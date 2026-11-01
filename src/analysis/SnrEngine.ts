/**
 * SnrEngine.ts
 * Pure-function Signal-to-Noise Ratio (SNR) Analysis Engine.
 * Standalone, decoupled from MOS/DNSMOS and UI. Operates purely on 16-bit linear PCM.
 */

import { AudioFilters } from './AudioFilters.ts';
import { VadDetector, type VadAnalysis } from './VadDetector.ts';

export interface SnrRange {
  startSec?: number;
  endSec?: number;
}

export interface SnrOptions {
  mode?: 'auto' | 'manual';
  range?: SnrRange;
  highPassCutoff?: number; // Cutoff in Hz. Set to 0 to disable. Default: 80 Hz
  useAWeighting?: boolean; // Default: false (Z-weighting)
  manualNoiseRange?: { startSec: number; endSec: number };
  manualSpeechRange?: { startSec: number; endSec: number };
  timeWindowSizeSec?: number; // Default: 5.0s
  timeWindowHopSec?: number;  // Default: 1.0s
}

export interface SnrTimelinePoint {
  timeSec: number;
  snrDb: number | null;
  speechPct: number;
  speechLevelDbfs: number | null;
  noiseFloorDbfs: number | null;
}

export interface SnrResult {
  snrDb: number | null;
  speechLevelDbfs: number | null;
  noiseFloorDbfs: number | null;
  speechPct: number;
  noisePct: number;
  speechDurationSec: number;
  noiseDurationSec: number;
  totalDurationSec: number;
  sampleRate: number;
  mode: 'auto' | 'manual';
  appliedFilters: {
    highPassHz: number;
    aWeighting: boolean;
  };
  exactRange: {
    startSec: number;
    endSec: number;
    durationSec: number;
    frameCount: number;
  };
  status: 'ok' | 'cannot_estimate';
  cannotEstimateReason?: string;
  confidence: 'high' | 'low';
  lowConfidenceReasons: string[];
  clippingPct: number;
  timeline: SnrTimelinePoint[];
  timelineStats?: {
    minSnr: number;
    avgSnr: number;
    maxSnr: number;
  };
}

export class SnrEngine {
  public static readonly FRAME_STEP_SEC = 0.020; // 20 ms frame snap boundary

  /**
   * Snaps a timestamp (seconds) to the nearest 20 ms frame boundary.
   */
  public static snapToFrame(sec: number): number {
    return Math.max(0, Math.round(sec / this.FRAME_STEP_SEC) * this.FRAME_STEP_SEC);
  }

  /**
   * Main pure analysis function.
   */
  public static analyze(
    pcm: Int16Array,
    sampleRate: number,
    options: SnrOptions = {}
  ): SnrResult {
    const mode = options.mode || 'auto';
    const highPassHz = options.highPassCutoff !== undefined ? options.highPassCutoff : 80;
    const useAWeighting = Boolean(options.useAWeighting);
    const totalClipDuration = pcm.length / sampleRate;

    // 1. Determine and snap evaluation range to 20ms boundaries
    const rawStart = options.range?.startSec !== undefined ? Math.max(0, options.range.startSec) : 0;
    const rawEnd = options.range?.endSec !== undefined ? Math.min(totalClipDuration, options.range.endSec) : totalClipDuration;

    const startSec = this.snapToFrame(Math.min(rawStart, rawEnd));
    const endSec = this.snapToFrame(Math.max(rawStart, rawEnd));
    const durationSec = Math.max(0, endSec - startSec);

    const startSample = Math.min(pcm.length, Math.floor(startSec * sampleRate));
    const endSample = Math.min(pcm.length, Math.floor(endSec * sampleRate));
    const numSamples = Math.max(0, endSample - startSample);

    const exactRange = {
      startSec,
      endSec,
      durationSec,
      frameCount: Math.floor(durationSec / this.FRAME_STEP_SEC),
    };

    // Edge check: zero length or digital silence
    if (numSamples <= 0 || durationSec <= 0) {
      return this.createCannotEstimateResult(sampleRate, mode, highPassHz, useAWeighting, exactRange, 'Selected range is empty.');
    }

    // 2. Extract slice into Float32Array
    const slice = new Float32Array(numSamples);
    let maxAbs = 0;
    let clipCount = 0;
    for (let i = 0; i < numSamples; i++) {
      const val = pcm[startSample + i];
      slice[i] = val;
      const absVal = Math.abs(val);
      if (absVal > maxAbs) maxAbs = absVal;
      if (absVal >= 32760) clipCount++;
    }

    const clippingPct = (clipCount / numSamples) * 100;

    // Zero energy / digital silence
    if (maxAbs === 0) {
      return this.createCannotEstimateResult(sampleRate, mode, highPassHz, useAWeighting, exactRange, 'Audio contains digital silence (all samples zero).');
    }

    // 3. Apply Signal Conditioning Filters
    if (highPassHz > 0) {
      const hpf = AudioFilters.designHighPass(sampleRate, highPassHz);
      AudioFilters.applyBiquadInPlace(slice, hpf);
    }
    if (useAWeighting) {
      const aWeightingBiquads = AudioFilters.designAWeighting(sampleRate);
      AudioFilters.applyBiquadCascadeInPlace(slice, aWeightingBiquads);
    }

    // 4. Branch by Mode
    if (mode === 'manual') {
      return this.analyzeManual(
        pcm,
        sampleRate,
        options,
        highPassHz,
        useAWeighting,
        exactRange,
        clippingPct
      );
    } else {
      return this.analyzeAuto(
        slice,
        sampleRate,
        highPassHz,
        useAWeighting,
        exactRange,
        clippingPct,
        options
      );
    }
  }

  /**
   * Auto Mode: VAD-driven active speech & noise floor estimation.
   */
  private static analyzeAuto(
    slice: Float32Array,
    sampleRate: number,
    highPassHz: number,
    useAWeighting: boolean,
    exactRange: { startSec: number; endSec: number; durationSec: number; frameCount: number },
    clippingPct: number,
    options: SnrOptions
  ): SnrResult {
    const vad = VadDetector.analyze(slice, sampleRate);

    // "Cannot estimate" rules
    if (vad.speechFrames === 0 && vad.noiseFrames === 0) {
      return this.createCannotEstimateResult(sampleRate, 'auto', highPassHz, useAWeighting, exactRange, 'No decodable frames in range.', clippingPct);
    }
    if (vad.speechFrames === 0) {
      return this.createCannotEstimateResult(sampleRate, 'auto', highPassHz, useAWeighting, exactRange, 'No speech activity detected in range.', clippingPct);
    }
    if (vad.noiseFrames === 0) {
      return this.createCannotEstimateResult(sampleRate, 'auto', highPassHz, useAWeighting, exactRange, 'No pause or background noise frames detected in range.', clippingPct);
    }

    const snrDb = Math.round((vad.activeSpeechLevelDbfs - vad.noiseFloorDbfs) * 10) / 10;

    // Confidence diagnostics
    const lowConfidenceReasons: string[] = [];
    if (exactRange.durationSec < 3.0) {
      lowConfidenceReasons.push('Evaluation range is under 3.0s; sample size is small.');
    }
    if (vad.noiseDurationSec < 0.5) {
      lowConfidenceReasons.push(`Fewer than 0.5s of noise/pause frames (${vad.noiseDurationSec.toFixed(2)}s); noise floor may be underestimated.`);
    }
    if (vad.speechDurationSec < 1.0) {
      lowConfidenceReasons.push(`Fewer than 1.0s of active speech (${vad.speechDurationSec.toFixed(2)}s); speech level may be inaccurate.`);
    }
    if (clippingPct >= 0.1) {
      lowConfidenceReasons.push(`Digital clipping detected (${clippingPct.toFixed(2)}% of samples); speech peaks may be distorted.`);
    }
    if (vad.noiseStdDevDbfs > 6.0) {
      lowConfidenceReasons.push(`Noise floor varies strongly (${vad.noiseStdDevDbfs.toFixed(1)} dB standard deviation); consider using Manual Mode.`);
    }

    const confidence: 'high' | 'low' = lowConfidenceReasons.length > 0 ? 'low' : 'high';

    // 5. Compute Time-Windowed Sliding Timeline
    const timeline = this.computeTimeline(slice, sampleRate, options.timeWindowSizeSec || 5.0, options.timeWindowHopSec || 1.0);
    const timelineStats = this.computeTimelineStats(timeline);

    return {
      snrDb,
      speechLevelDbfs: Math.round(vad.activeSpeechLevelDbfs * 10) / 10,
      noiseFloorDbfs: Math.round(vad.noiseFloorDbfs * 10) / 10,
      speechPct: Math.round(vad.speechPct * 10) / 10,
      noisePct: Math.round(vad.noisePct * 10) / 10,
      speechDurationSec: Math.round(vad.speechDurationSec * 100) / 100,
      noiseDurationSec: Math.round(vad.noiseDurationSec * 100) / 100,
      totalDurationSec: exactRange.durationSec,
      sampleRate,
      mode: 'auto',
      appliedFilters: {
        highPassHz,
        aWeighting: useAWeighting,
      },
      exactRange,
      status: 'ok',
      confidence,
      lowConfidenceReasons,
      clippingPct: Math.round(clippingPct * 100) / 100,
      timeline,
      timelineStats,
    };
  }

  /**
   * Manual Mode: User-marked speech range and noise range.
   */
  private static analyzeManual(
    pcm: Int16Array,
    sampleRate: number,
    options: SnrOptions,
    highPassHz: number,
    useAWeighting: boolean,
    exactRange: { startSec: number; endSec: number; durationSec: number; frameCount: number },
    clippingPct: number
  ): SnrResult {
    if (!options.manualSpeechRange || !options.manualNoiseRange) {
      return this.createCannotEstimateResult(
        sampleRate,
        'manual',
        highPassHz,
        useAWeighting,
        exactRange,
        'Manual mode requires both a speech range and a noise-only range.'
      );
    }

    const spStart = Math.max(0, Math.floor(options.manualSpeechRange.startSec * sampleRate));
    const spEnd = Math.min(pcm.length, Math.floor(options.manualSpeechRange.endSec * sampleRate));
    const nsStart = Math.max(0, Math.floor(options.manualNoiseRange.startSec * sampleRate));
    const nsEnd = Math.min(pcm.length, Math.floor(options.manualNoiseRange.endSec * sampleRate));

    if (spEnd <= spStart || nsEnd <= nsStart) {
      return this.createCannotEstimateResult(
        sampleRate,
        'manual',
        highPassHz,
        useAWeighting,
        exactRange,
        'One or both of the manual ranges have zero duration.'
      );
    }

    // Extract speech slice & noise slice
    const speechSlice = new Float32Array(spEnd - spStart);
    for (let i = 0; i < speechSlice.length; i++) speechSlice[i] = pcm[spStart + i];

    const noiseSlice = new Float32Array(nsEnd - nsStart);
    for (let i = 0; i < noiseSlice.length; i++) noiseSlice[i] = pcm[nsStart + i];

    // Apply filters
    if (highPassHz > 0) {
      const hpf = AudioFilters.designHighPass(sampleRate, highPassHz);
      AudioFilters.applyBiquadInPlace(speechSlice, hpf);
      AudioFilters.applyBiquadInPlace(noiseSlice, hpf);
    }
    if (useAWeighting) {
      const aWeightingBiquads = AudioFilters.designAWeighting(sampleRate);
      AudioFilters.applyBiquadCascadeInPlace(speechSlice, aWeightingBiquads);
      AudioFilters.applyBiquadCascadeInPlace(noiseSlice, aWeightingBiquads);
    }

    // Compute RMS power
    let spSum = 0;
    for (let i = 0; i < speechSlice.length; i++) {
      const v = speechSlice[i] / 32768.0;
      spSum += v * v;
    }
    const spPower = spSum / speechSlice.length;

    let nsSum = 0;
    for (let i = 0; i < noiseSlice.length; i++) {
      const v = noiseSlice[i] / 32768.0;
      nsSum += v * v;
    }
    const nsPower = nsSum / noiseSlice.length;

    if (spPower <= 0 || nsPower <= 0) {
      return this.createCannotEstimateResult(
        sampleRate,
        'manual',
        highPassHz,
        useAWeighting,
        exactRange,
        'Digital silence in either speech or noise range.'
      );
    }

    const pureSpPower = Math.max(spPower - nsPower, 0.02 * spPower);
    const speechLevelDbfs = 10 * Math.log10(pureSpPower);
    const noiseFloorDbfs = 10 * Math.log10(nsPower);
    const snrDb = Math.round((speechLevelDbfs - noiseFloorDbfs) * 10) / 10;

    const spDur = speechSlice.length / sampleRate;
    const nsDur = noiseSlice.length / sampleRate;
    const totDur = spDur + nsDur;

    const lowConfidenceReasons: string[] = [];
    if (spDur < 0.5) lowConfidenceReasons.push(`Speech range is very short (${spDur.toFixed(2)}s).`);
    if (nsDur < 0.2) lowConfidenceReasons.push(`Noise range is very short (${nsDur.toFixed(2)}s).`);
    if (clippingPct >= 0.1) lowConfidenceReasons.push(`Clipping detected (${clippingPct.toFixed(2)}%).`);

    return {
      snrDb,
      speechLevelDbfs: Math.round(speechLevelDbfs * 10) / 10,
      noiseFloorDbfs: Math.round(noiseFloorDbfs * 10) / 10,
      speechPct: Math.round((spDur / totDur) * 1000) / 10,
      noisePct: Math.round((nsDur / totDur) * 1000) / 10,
      speechDurationSec: Math.round(spDur * 100) / 100,
      noiseDurationSec: Math.round(nsDur * 100) / 100,
      totalDurationSec: Math.round(totDur * 100) / 100,
      sampleRate,
      mode: 'manual',
      appliedFilters: {
        highPassHz,
        aWeighting: useAWeighting,
      },
      exactRange,
      status: 'ok',
      confidence: lowConfidenceReasons.length > 0 ? 'low' : 'high',
      lowConfidenceReasons,
      clippingPct: Math.round(clippingPct * 100) / 100,
      timeline: [],
    };
  }

  /**
   * Sliding window timeline generator (5s window, 1s step).
   */
  private static computeTimeline(
    samples: Float32Array,
    sampleRate: number,
    windowSec: number,
    hopSec: number
  ): SnrTimelinePoint[] {
    const points: SnrTimelinePoint[] = [];
    const windowSamples = Math.round(windowSec * sampleRate);
    const hopSamples = Math.round(hopSec * sampleRate);

    if (samples.length < windowSamples) {
      return points;
    }

    for (let start = 0; start + windowSamples <= samples.length; start += hopSamples) {
      const windowSlice = samples.subarray(start, start + windowSamples);
      const vad = VadDetector.analyze(windowSlice, sampleRate);
      const timeSec = Math.round(((start + windowSamples / 2) / sampleRate) * 10) / 10;

      if (vad.speechFrames > 0 && vad.noiseFrames > 0) {
        const snr = Math.round((vad.activeSpeechLevelDbfs - vad.noiseFloorDbfs) * 10) / 10;
        points.push({
          timeSec,
          snrDb: snr,
          speechPct: Math.round(vad.speechPct),
          speechLevelDbfs: Math.round(vad.activeSpeechLevelDbfs * 10) / 10,
          noiseFloorDbfs: Math.round(vad.noiseFloorDbfs * 10) / 10,
        });
      } else {
        points.push({
          timeSec,
          snrDb: null,
          speechPct: Math.round(vad.speechPct),
          speechLevelDbfs: null,
          noiseFloorDbfs: null,
        });
      }
    }

    return points;
  }

  private static computeTimelineStats(timeline: SnrTimelinePoint[]): { minSnr: number; avgSnr: number; maxSnr: number } | undefined {
    const valid = timeline.filter(p => p.snrDb !== null).map(p => p.snrDb as number);
    if (valid.length === 0) return undefined;

    let min = valid[0];
    let max = valid[0];
    let sum = 0;
    for (const v of valid) {
      if (v < min) min = v;
      if (v > max) max = v;
      sum += v;
    }

    return {
      minSnr: Math.round(min * 10) / 10,
      avgSnr: Math.round((sum / valid.length) * 10) / 10,
      maxSnr: Math.round(max * 10) / 10,
    };
  }

  private static createCannotEstimateResult(
    sampleRate: number,
    mode: 'auto' | 'manual',
    highPassHz: number,
    aWeighting: boolean,
    exactRange: { startSec: number; endSec: number; durationSec: number; frameCount: number },
    cannotEstimateReason: string,
    clippingPct: number = 0
  ): SnrResult {
    const lowConfidenceReasons = [cannotEstimateReason];
    if (exactRange.durationSec > 0 && exactRange.durationSec < 3.0) {
      lowConfidenceReasons.push('Evaluation range is under 3.0s; sample size is small.');
    }
    if (clippingPct >= 0.1) {
      lowConfidenceReasons.push(`Digital clipping detected (${clippingPct.toFixed(2)}% of samples); speech peaks may be distorted.`);
    }

    return {
      snrDb: null,
      speechLevelDbfs: null,
      noiseFloorDbfs: null,
      speechPct: 0,
      noisePct: 0,
      speechDurationSec: 0,
      noiseDurationSec: 0,
      totalDurationSec: exactRange.durationSec,
      sampleRate,
      mode,
      appliedFilters: {
        highPassHz,
        aWeighting,
      },
      exactRange,
      status: 'cannot_estimate',
      cannotEstimateReason,
      confidence: 'low',
      lowConfidenceReasons,
      clippingPct: Math.round(clippingPct * 100) / 100,
      timeline: [],
    };
  }
}
