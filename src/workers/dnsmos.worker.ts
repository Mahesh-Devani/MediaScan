/**
 * dnsmos.worker.ts
 * Off-main-thread Web Worker for Microsoft DNSMOS P.835 / P.808 inference via onnxruntime-web.
 */

import * as ort from 'onnxruntime-web';
import type { DnsmosWorkerTask, DnsmosWorkerResponse, DnsmosWindowScore, DnsmosResult, DnsmosConfidence } from '../dnsmos/DnsmosTypes.ts';
import { Polyfit } from '../dnsmos/Polyfit.ts';
import { MelSpectrogram } from '../dnsmos/MelSpectrogram.ts';

// Configure ONNX Runtime
const isBrowser = typeof window !== 'undefined' || typeof self !== 'undefined';
if (isBrowser) {
  try {
    ort.env.wasm.numThreads = 1; // Default to single thread for broad compatibility
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    }
  } catch (e) {
    console.warn('[dnsmos.worker] Warning configuring ort.env:', e);
  }
}

let sessionP835: ort.InferenceSession | null = null;
let sessionP835Personalized: ort.InferenceSession | null = null;
let sessionP808: ort.InferenceSession | null = null;

async function getOrInitP835Session(isPersonalized: boolean = false, baseUrl: string = ''): Promise<ort.InferenceSession> {
  const modelUrl = isPersonalized
    ? `${baseUrl}models/dnsmos/sig_bak_ovr_p.onnx`
    : `${baseUrl}models/dnsmos/sig_bak_ovr.onnx`;

  if (isPersonalized) {
    if (!sessionP835Personalized) {
      sessionP835Personalized = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
    }
    return sessionP835Personalized;
  } else {
    if (!sessionP835) {
      sessionP835 = await ort.InferenceSession.create(modelUrl, {
        executionProviders: ['wasm'],
      });
    }
    return sessionP835;
  }
}

async function getOrInitP808Session(baseUrl: string = ''): Promise<ort.InferenceSession> {
  if (!sessionP808) {
    const modelUrl = `${baseUrl}models/dnsmos/model_v8.onnx`;
    sessionP808 = await ort.InferenceSession.create(modelUrl, {
      executionProviders: ['wasm'],
    });
  }
  return sessionP808;
}

export async function processDnsmosTask(task: DnsmosWorkerTask): Promise<DnsmosResult> {
  const tStart = performance.now();
  const fs = 16000;
  const inputLenSec = 9.01;
  const lenSamples = Math.round(inputLenSec * fs); // 144160
  const hopSamples = fs; // 16000 (1.0 sec)

  const rawAudio = task.audioPcm;
  const originalDuration = rawAudio.length / fs;

  // 1. Confidence & Diagnostic Checks
  const reasons: string[] = [];
  let isShortPadded = false;

  if (originalDuration < 3.0) {
    reasons.push('Range is very short (< 3.0s); speech quality ratings may be unstable.');
  }

  // Energy & Silence check
  let sumSq = 0.0;
  let silentFrames = 0;
  const checkFrameLen = 320; // 20ms
  const numCheckFrames = Math.floor(rawAudio.length / checkFrameLen);
  for (let i = 0; i < numCheckFrames; i++) {
    let fSum = 0;
    const start = i * checkFrameLen;
    for (let j = 0; j < checkFrameLen; j++) {
      const s = rawAudio[start + j];
      fSum += s * s;
    }
    sumSq += fSum;
    const fRms = Math.sqrt(fSum / checkFrameLen);
    if (fRms < 0.002) silentFrames++;
  }
  const overallRms = Math.sqrt(sumSq / Math.max(1, rawAudio.length));
  if (overallRms < 0.001 || (numCheckFrames > 0 && silentFrames / numCheckFrames > 0.75)) {
    reasons.push('Range contains predominantly silence or near-zero energy; scores may not reflect active speech.');
  }

  // Codec bandwidth caveat
  if (task.originalSampleRate <= 8000) {
    reasons.push('Narrowband 8 kHz speech upsampled to 16 kHz model. Upper band (> 4 kHz) is absent.');
  }

  // 2. Padding behavior for short audio: repeat/tile per reference
  let audio = rawAudio;
  if (audio.length < lenSamples) {
    isShortPadded = true;
    reasons.push('Audio is shorter than 9.01s; repeated and tiled per reference specification.');
    while (audio.length < lenSamples) {
      const combined = new Float32Array(audio.length * 2);
      combined.set(audio, 0);
      combined.set(audio, audio.length);
      audio = combined;
    }
  }

  const confidenceLevel: DnsmosConfidence['level'] = reasons.length === 0 ? 'high' : reasons.length === 1 && !isShortPadded ? 'medium' : 'low';
  const confidence: DnsmosConfidence = {
    level: confidenceLevel,
    reasons,
  };

  // 3. Initialize models & WASM runtime
  let defaultBase = './';
  if (typeof self !== 'undefined' && self.location && self.location.href) {
    defaultBase = new URL('../', self.location.href).href;
  }
  const baseUrl = task.options?.modelBaseUrl || defaultBase;

  if (typeof self !== 'undefined') {
    const wasmBase = task.options?.wasmBaseUrl || (self.location && self.location.href ? new URL('../wasm/', self.location.href).href : './wasm/');
    try {
      ort.env.wasm.wasmPaths = wasmBase;
    } catch (e) {
      console.warn('[dnsmos.worker] Error setting wasmPaths:', e);
    }
  }

  const isPersonalized = !!task.options?.isPersonalized;
  const includeP808 = !!task.options?.includeP808;

  const sessP835 = await getOrInitP835Session(isPersonalized, baseUrl);
  const sessP808 = includeP808 ? await getOrInitP808Session(baseUrl) : null;

  // 4. Window Loop
  const numHops = Math.floor(audio.length / fs - inputLenSec) + 1;
  const windows: DnsmosWindowScore[] = [];

  for (let idx = 0; idx < numHops; idx++) {
    const startIdx = idx * hopSamples;
    const endIdx = startIdx + lenSamples;
    if (endIdx > audio.length) break;

    const audioSeg = audio.subarray(startIdx, endIdx);

    // Primary P.835 inference (takes [1, 144160] raw audio)
    const tensor835 = new ort.Tensor('float32', new Float32Array(audioSeg), [1, lenSamples]);
    const feeds835: Record<string, ort.Tensor> = {};
    feeds835[sessP835.inputNames[0]] = tensor835;

    const out835 = await sessP835.run(feeds835);
    const data835 = out835[sessP835.outputNames[0]].data as Float32Array;
    const rawSig = data835[0];
    const rawBak = data835[1];
    const rawOvr = data835[2];

    const fitted = Polyfit.fit(rawSig, rawBak, rawOvr, isPersonalized);

    // Optional P.808 inference
    let p808Score: number | undefined;
    if (sessP808) {
      const subAudio = audioSeg.subarray(0, 144000);
      const melFeatures = MelSpectrogram.compute(subAudio);
      const tensor808 = new ort.Tensor('float32', melFeatures, [1, 900, 120]);
      const feeds808: Record<string, ort.Tensor> = {};
      feeds808[sessP808.inputNames[0]] = tensor808;
      const out808 = await sessP808.run(feeds808);
      const data808 = out808[sessP808.outputNames[0]].data as Float32Array;
      p808Score = Math.max(1.0, Math.min(5.0, Number(data808[0].toFixed(4))));
    }

    windows.push({
      windowIdx: idx,
      startSec: Number((task.startSec + idx).toFixed(2)),
      endSec: Number((task.startSec + idx + inputLenSec).toFixed(2)),
      sig_raw: Number(rawSig.toFixed(4)),
      bak_raw: Number(rawBak.toFixed(4)),
      ovrl_raw: Number(rawOvr.toFixed(4)),
      sig: fitted.sig,
      bak: fitted.bak,
      ovrl: fitted.ovrl,
      p808: p808Score,
    });
  }

  // 5. Aggregate Metrics
  if (windows.length === 0) {
    throw new Error('No valid windows could be computed for the audio segment.');
  }

  let sumSig = 0, sumBak = 0, sumOvrl = 0, sumP808 = 0;
  let minSig = Infinity, maxSig = -Infinity;
  let minBak = Infinity, maxBak = -Infinity;
  let minOvrl = Infinity, maxOvrl = -Infinity;
  let minP808 = Infinity, maxP808 = -Infinity;

  for (const w of windows) {
    sumSig += w.sig;
    sumBak += w.bak;
    sumOvrl += w.ovrl;
    if (w.p808 !== undefined) sumP808 += w.p808;

    if (w.sig < minSig) minSig = w.sig;
    if (w.sig > maxSig) maxSig = w.sig;
    if (w.bak < minBak) minBak = w.bak;
    if (w.bak > maxBak) maxBak = w.bak;
    if (w.ovrl < minOvrl) minOvrl = w.ovrl;
    if (w.ovrl > maxOvrl) maxOvrl = w.ovrl;
    if (w.p808 !== undefined) {
      if (w.p808 < minP808) minP808 = w.p808;
      if (w.p808 > maxP808) maxP808 = w.p808;
    }
  }

  const N = windows.length;
  const meanSig = Number((sumSig / N).toFixed(4));
  const meanBak = Number((sumBak / N).toFixed(4));
  const meanOvrl = Number((sumOvrl / N).toFixed(4));
  const meanP808 = includeP808 ? Number((sumP808 / N).toFixed(4)) : undefined;

  const computeTimeMs = Math.round(performance.now() - tStart);
  const computeTimeSec = Math.max(0.001, computeTimeMs / 1000.0);
  const realtimeFactor = Number((originalDuration / computeTimeSec).toFixed(2));

  return {
    streamId: task.streamId,
    ssrc: task.ssrc,
    legId: task.legId,
    direction: task.direction,
    codec: task.codec,
    originalSampleRate: task.originalSampleRate,
    modelSampleRate: fs,
    fileInfo: task.fileInfo,

    range: {
      startSec: task.startSec,
      endSec: task.endSec,
      durationSec: Number(originalDuration.toFixed(2)),
      isFullStream: task.isFullStream,
    },

    sig: meanSig,
    bak: meanBak,
    ovrl: meanOvrl,
    p808: meanP808,

    sig_min: Number(minSig.toFixed(4)),
    sig_max: Number(maxSig.toFixed(4)),
    sig_weighted: meanSig, // Single continuous clip weighting

    bak_min: Number(minBak.toFixed(4)),
    bak_max: Number(maxBak.toFixed(4)),
    bak_weighted: meanBak,

    ovrl_min: Number(minOvrl.toFixed(4)),
    ovrl_max: Number(maxOvrl.toFixed(4)),
    ovrl_weighted: meanOvrl,

    p808_min: includeP808 ? Number(minP808.toFixed(4)) : undefined,
    p808_max: includeP808 ? Number(maxP808.toFixed(4)) : undefined,
    p808_weighted: meanP808,

    windowCount: N,
    windows,

    confidence,
    realtimeFactor,
    computeTimeMs,

    isPersonalized,
    modelVersion: 'DNSMOS P.835 (ICASSP 2022) / model_v8 (P.808)',
  };
}

// Worker message listener when running inside a Web Worker
if (typeof self !== 'undefined' && 'onmessage' in self) {
  self.onmessage = async (e: MessageEvent<DnsmosWorkerTask>) => {
    const task = e.data;
    try {
      const result = await processDnsmosTask(task);
      const resp: DnsmosWorkerResponse = {
        taskId: task.taskId,
        success: true,
        result,
      };
      self.postMessage(resp);
    } catch (err: any) {
      console.error('[dnsmos.worker] Task processing error:', err);
      const resp: DnsmosWorkerResponse = {
        taskId: task.taskId,
        success: false,
        error: err?.message || String(err),
      };
      self.postMessage(resp);
    }
  };
}
