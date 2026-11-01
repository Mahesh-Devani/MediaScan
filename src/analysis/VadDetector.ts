/**
 * VadDetector.ts
 * Frame-level Voice Activity Detector (VAD):
 * - Frame length: 20 ms
 * - Frame hop: 10 ms (50% overlap)
 * - Per-frame RMS in dBFS
 * - Adaptive minimum-statistics noise floor tracking (10th percentile + margin)
 * - 3-frame hangover smoothing
 */

export interface VadFrame {
  frameIndex: number;
  timeSec: number;
  rms: number;
  dbfs: number;
  isSpeech: boolean;
}

export interface VadAnalysis {
  frames: VadFrame[];
  totalFrames: number;
  speechFrames: number;
  noiseFrames: number;
  speechPct: number;
  noisePct: number;
  speechDurationSec: number;
  noiseDurationSec: number;
  noiseFloorDbfs: number;
  activeSpeechLevelDbfs: number;
  vadThresholdDbfs: number;
  noiseStdDevDbfs: number;
  clippingCount: number;
  clippingPct: number;
}

export class VadDetector {
  public static readonly FRAME_DURATION_SEC = 0.020; // 20 ms
  public static readonly HOP_DURATION_SEC = 0.010;   // 10 ms (50% overlap)
  public static readonly DEFAULT_VAD_MARGIN_DB = 7.5;
  public static readonly MIN_VAD_THRESHOLD_DBFS = -65.0;
  public static readonly HANGOVER_FRAMES = 3; // 30 ms hangover

  /**
   * Analyzes an audio buffer, returning frame-level VAD classifications and energy statistics.
   */
  public static analyze(samples: Float32Array, sampleRate: number, marginDb = VadDetector.DEFAULT_VAD_MARGIN_DB): VadAnalysis {
    const frameSize = Math.max(1, Math.round(this.FRAME_DURATION_SEC * sampleRate));
    const hopSize = Math.max(1, Math.round(this.HOP_DURATION_SEC * sampleRate));

    if (samples.length < frameSize) {
      return this.createEmptyAnalysis();
    }

    // 1. Check digital clipping (samples near full scale 32767 / -32768)
    let clipCount = 0;
    for (let i = 0; i < samples.length; i++) {
      if (Math.abs(samples[i]) >= 32760) clipCount++;
    }
    const clippingPct = (clipCount / samples.length) * 100;

    const numFrames = Math.floor((samples.length - frameSize) / hopSize) + 1;
    const rawFrames: Array<{ index: number; timeSec: number; rms: number; dbfs: number }> = new Array(numFrames);
    const dbfsValues: number[] = new Array(numFrames);

    for (let k = 0; k < numFrames; k++) {
      const start = k * hopSize;
      let sumSq = 0;
      for (let n = 0; n < frameSize; n++) {
        const val = samples[start + n];
        sumSq += val * val;
      }
      const rms = Math.sqrt(sumSq / frameSize);
      // dBFS relative to 16-bit full scale (+/- 32768)
      const dbfs = 20 * Math.log10(Math.max(rms, 1e-7) / 32768.0);

      rawFrames[k] = {
        index: k,
        timeSec: (start + frameSize / 2) / sampleRate,
        rms,
        dbfs,
      };
      dbfsValues[k] = dbfs;
    }

    // 2. Estimate noise floor and peak speech via percentiles
    const sortedDbfs = [...dbfsValues].sort((a, b) => a - b);
    const p10Idx = Math.max(0, Math.min(numFrames - 1, Math.floor(0.10 * (numFrames - 1))));
    const p90Idx = Math.max(0, Math.min(numFrames - 1, Math.floor(0.90 * (numFrames - 1))));
    const noiseFloorEst = sortedDbfs[p10Idx];
    const speechPeakEst = sortedDbfs[p90Idx];

    // Adaptive threshold dynamically positioned between noise floor and speech
    const dynamicRange = speechPeakEst - noiseFloorEst;
    let adaptiveMargin = marginDb;
    if (dynamicRange > 1.2) {
      adaptiveMargin = Math.max(1.0, Math.min(marginDb, dynamicRange * 0.40));
    }
    const vadThreshold = Math.max(noiseFloorEst + adaptiveMargin, this.MIN_VAD_THRESHOLD_DBFS);

    // 3. Classify frames with hangover smoothing
    const frames: VadFrame[] = new Array(numFrames);
    let hangoverCounter = 0;

    for (let k = 0; k < numFrames; k++) {
      const raw = rawFrames[k];
      const isAboveThresh = raw.dbfs >= vadThreshold;

      let isSpeech = false;
      if (isAboveThresh) {
        isSpeech = true;
        hangoverCounter = this.HANGOVER_FRAMES;
      } else if (hangoverCounter > 0) {
        isSpeech = true;
        hangoverCounter--;
      }

      frames[k] = {
        frameIndex: raw.index,
        timeSec: raw.timeSec,
        rms: raw.rms,
        dbfs: raw.dbfs,
        isSpeech,
      };
    }

    // 4. Compute statistics across speech and noise frames
    let speechSumPower = 0;
    let noiseSumPower = 0;
    let speechCount = 0;
    let noiseCount = 0;
    const noiseFrameDbfs: number[] = [];

    for (let k = 0; k < numFrames; k++) {
      const f = frames[k];
      const normRms = f.rms / 32768.0;
      const power = normRms * normRms;

      if (f.isSpeech) {
        speechSumPower += power;
        speechCount++;
      } else {
        noiseSumPower += power;
        noiseCount++;
        noiseFrameDbfs.push(f.dbfs);
      }
    }

    // Compute standard deviation of noise frame levels (for non-stationary noise detection)
    let noiseStdDev = 0;
    if (noiseCount > 1) {
      const meanNoiseDbfs = noiseFrameDbfs.reduce((a, b) => a + b, 0) / noiseCount;
      const variance = noiseFrameDbfs.reduce((acc, v) => acc + (v - meanNoiseDbfs) * (v - meanNoiseDbfs), 0) / (noiseCount - 1);
      noiseStdDev = Math.sqrt(variance);
    }

    const speechPct = (speechCount / numFrames) * 100;
    const noisePct = (noiseCount / numFrames) * 100;
    const speechDurationSec = speechCount * this.HOP_DURATION_SEC;
    const noiseDurationSec = noiseCount * this.HOP_DURATION_SEC;

    const meanSpeechPower = speechCount > 0 ? speechSumPower / speechCount : 0;
    const meanNoisePower = noiseCount > 0 ? noiseSumPower / noiseCount : 0;
    // Pure speech power subtraction: in mixture y = s + n, E[y^2] = E[s^2] + E[n^2]
    const pureSpeechPower = Math.max(meanSpeechPower - meanNoisePower, 0.02 * meanSpeechPower);

    const activeSpeechLevelDbfs = speechCount > 0
      ? 10 * Math.log10(Math.max(pureSpeechPower, 1e-14))
      : -100;

    const noiseFloorDbfs = noiseCount > 0
      ? 10 * Math.log10(Math.max(meanNoisePower, 1e-14))
      : -100;

    return {
      frames,
      totalFrames: numFrames,
      speechFrames: speechCount,
      noiseFrames: noiseCount,
      speechPct,
      noisePct,
      speechDurationSec,
      noiseDurationSec,
      noiseFloorDbfs,
      activeSpeechLevelDbfs,
      vadThresholdDbfs: vadThreshold,
      noiseStdDevDbfs: noiseStdDev,
      clippingCount: clipCount,
      clippingPct,
    };
  }

  private static createEmptyAnalysis(): VadAnalysis {
    return {
      frames: [],
      totalFrames: 0,
      speechFrames: 0,
      noiseFrames: 0,
      speechPct: 0,
      noisePct: 0,
      speechDurationSec: 0,
      noiseDurationSec: 0,
      noiseFloorDbfs: -100,
      activeSpeechLevelDbfs: -100,
      vadThresholdDbfs: -65,
      noiseStdDevDbfs: 0,
      clippingCount: 0,
      clippingPct: 0,
    };
  }
}
