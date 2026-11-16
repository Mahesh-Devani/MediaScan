/**
 * tts.worker.ts
 * Web Worker for 100% offline client-side neural voice synthesis via onnxruntime-web.
 * Runs Piper-compatible ONNX models and custom user-loaded voice models in an isolated thread.
 */

import * as ort from 'onnxruntime-web';
import { PiperPhonemizer } from '../tts/PiperPhonemizer.ts';

// Configure default thread count safely
if (typeof self !== 'undefined') {
  try {
    ort.env.wasm.numThreads = 1; // Default to single-thread for universal compatibility
    if (typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated) {
      ort.env.wasm.numThreads = Math.min(4, navigator.hardwareConcurrency || 2);
    }
  } catch (e) {
    console.warn('[tts.worker] Warning configuring ort.env:', e);
  }
}

export interface VoiceConfig {
  audio?: {
    sample_rate?: number;
  };
  phoneme_type?: string;
  phoneme_id_map?: Record<string, number[]>;
  espeak?: {
    voice?: string;
  };
  inference?: {
    noise_scale?: number;
    length_scale?: number;
    noise_w?: number;
  };
  speaker_id_map?: Record<string, number>;
}

export interface TtsSynthesizeRequest {
  id: string;
  text: string;
  normalizedText: string;
  voiceId: string;
  language?: string;
  espeakVoice?: string;
  modelUrl?: string;
  configUrl?: string;
  wasmBaseUrl?: string;
  modelBuffer?: ArrayBuffer;
  config?: VoiceConfig;
  speed: number;       // length_scale = 1.0 / speed
  noiseScale: number;  // default 0.667
  noiseW: number;      // default 0.8
  sentencePauseMs: number;
  speakerId?: number;
}

export interface TtsSynthesizeResponse {
  id: string;
  success: boolean;
  audioPcm?: Float32Array;
  sampleRate?: number;
  durationSec?: number;
  error?: string;
}

// In-memory caches for session, model buffers, and configs
const sessionCache = new Map<string, ort.InferenceSession>();
const bufferCache = new Map<string, ArrayBuffer>();
const configCache = new Map<string, VoiceConfig>();

if (typeof self !== 'undefined') {
  self.onmessage = async (event: MessageEvent<TtsSynthesizeRequest>) => {
    const req = event.data;
    try {
      // 1. Configure WASM path if provided
      if (req.wasmBaseUrl) {
        const base = req.wasmBaseUrl.endsWith('/') ? req.wasmBaseUrl : req.wasmBaseUrl + '/';
        ort.env.wasm.wasmPaths = base;
      }

      // 2. Load model buffer if not provided
      if (!req.modelBuffer && req.modelUrl) {
        let cachedBuf = bufferCache.get(req.modelUrl);
        if (!cachedBuf) {
          // Check persistent browser CacheStorage first
          if (typeof caches !== 'undefined') {
            try {
              const cache = await caches.open('piper-voices-cache-v1');
              const matched = await cache.match(req.modelUrl);
              if (matched) {
                cachedBuf = await matched.arrayBuffer();
              }
            } catch (e) {}
          }

          if (!cachedBuf) {
            const resp = await fetch(req.modelUrl);
            if (!resp.ok) {
              throw new Error(`Failed to load voice model from ${req.modelUrl} (${resp.status} ${resp.statusText})`);
            }
            const cType = resp.headers.get('content-type') || '';
            if (cType.includes('text/html')) {
              throw new Error(`Voice model file not found at ${req.modelUrl} (server returned HTML SPA fallback).`);
            }
            cachedBuf = await resp.arrayBuffer();
            if (cachedBuf.byteLength < 1000) {
              throw new Error(`Voice model file at ${req.modelUrl} is invalid or too small (${cachedBuf.byteLength} bytes).`);
            }
            const headerBytes = new Uint8Array(cachedBuf.slice(0, 16));
            const headerText = String.fromCharCode(...headerBytes);
            if (headerText.toLowerCase().includes('<!doc') || headerText.toLowerCase().includes('<html')) {
              throw new Error(`Voice model file at ${req.modelUrl} returned HTML text instead of binary ONNX model.`);
            }
          }
          bufferCache.set(req.modelUrl, cachedBuf);
        }
        req.modelBuffer = cachedBuf;
      }

      // 3. Load config if not provided
      if (!req.config && req.configUrl) {
        let cachedConfig = configCache.get(req.configUrl);
        if (!cachedConfig) {
          if (typeof caches !== 'undefined') {
            try {
              const cache = await caches.open('piper-voices-cache-v1');
              const matched = await cache.match(req.configUrl);
              if (matched) {
                cachedConfig = await matched.json();
              }
            } catch (e) {}
          }

          if (!cachedConfig) {
            try {
              const resp = await fetch(req.configUrl);
              const cType = resp.headers.get('content-type') || '';
              if (resp.ok && !cType.includes('text/html')) {
                cachedConfig = await resp.json();
              }
            } catch (e) {
              console.warn('[tts.worker] Could not fetch config from configUrl:', e);
            }
          }
          if (cachedConfig) {
            configCache.set(req.configUrl, cachedConfig);
          }
        }
        req.config = cachedConfig;
      }

      // 4. Create or retrieve ONNX session
      const session = await getOrCreateSession(req);

      // 5. Run inference with piper phonemization
      const audioData = await runInference(session, req);

      const response: TtsSynthesizeResponse = {
        id: req.id,
        success: true,
        audioPcm: audioData.pcm,
        sampleRate: audioData.sampleRate,
        durationSec: audioData.pcm.length / audioData.sampleRate,
      };

      (self as any).postMessage(response, [audioData.pcm.buffer]);
    } catch (err: any) {
      console.error('[tts.worker] TTS synthesis failed:', err);
      const response: TtsSynthesizeResponse = {
        id: req.id,
        success: false,
        error: err?.message || String(err),
      };
      (self as any).postMessage(response);
    }
  };
}

async function getOrCreateSession(req: TtsSynthesizeRequest): Promise<ort.InferenceSession> {
  const cacheKey = req.voiceId;
  let session = sessionCache.get(cacheKey);
  if (session) return session;

  const sessionOptions: ort.InferenceSession.SessionOptions = {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  };

  if (req.modelBuffer) {
    session = await ort.InferenceSession.create(req.modelBuffer, sessionOptions);
  } else if (req.modelUrl) {
    session = await ort.InferenceSession.create(req.modelUrl, sessionOptions);
  } else {
    throw new Error(`Neither modelBuffer nor modelUrl was provided for voice ${req.voiceId}`);
  }

  sessionCache.set(cacheKey, session);
  return session;
}

async function runInference(
  session: ort.InferenceSession,
  req: TtsSynthesizeRequest
): Promise<{ pcm: Float32Array; sampleRate: number }> {
  const text = (req.normalizedText || req.text || '').trim();
  const config = req.config || {};
  const sampleRate = config.audio?.sample_rate || 22050;

  const espeakVoice = config.espeak?.voice || req.espeakVoice || PiperPhonemizer.resolveEspeakVoice(req.language || 'en_US');
  const wasmBase = req.wasmBaseUrl || 'wasm/';

  // 1. Phonemize via piper_phonemize WebAssembly
  const phonemizeRes = await PiperPhonemizer.phonemize(text, espeakVoice, wasmBase);
  const phonemeIds = phonemizeRes.phonemeIds;
  if (!phonemeIds || phonemeIds.length === 0) {
    throw new Error(`Phonemization returned 0 tokens for input: "${text}"`);
  }

  const seqLength = phonemeIds.length;

  // 2. Prepare ONNX Tensors
  const inputData = new BigInt64Array(seqLength);
  for (let i = 0; i < seqLength; i++) {
    inputData[i] = BigInt(phonemeIds[i]);
  }
  const inputTensor = new ort.Tensor('int64', inputData, [1, seqLength]);
  const lengthsTensor = new ort.Tensor('int64', new BigInt64Array([BigInt(seqLength)]), [1]);

  const lengthScale = 1.0 / Math.max(0.2, Math.min(3.0, req.speed || 1.0));
  const noiseScale = req.noiseScale ?? config.inference?.noise_scale ?? 0.667;
  const noiseW = req.noiseW ?? config.inference?.noise_w ?? 0.8;
  const scalesTensor = new ort.Tensor('float32', new Float32Array([noiseScale, lengthScale, noiseW]), [3]);

  const feeds: Record<string, ort.Tensor> = {
    input: inputTensor,
    input_lengths: lengthsTensor,
    scales: scalesTensor,
  };

  if (config.speaker_id_map && Object.keys(config.speaker_id_map).length > 0) {
    feeds.sid = new ort.Tensor('int64', new BigInt64Array([BigInt(req.speakerId || 0)]), [1]);
  }

  // 3. Run Inference
  const results = await session.run(feeds);
  const outputTensor = results.output || Object.values(results)[0];

  if (!outputTensor || !outputTensor.data) {
    throw new Error('TTS model inference returned empty output tensor');
  }

  const rawPcm = outputTensor.data as Float32Array;
  return { pcm: rawPcm, sampleRate };
}
