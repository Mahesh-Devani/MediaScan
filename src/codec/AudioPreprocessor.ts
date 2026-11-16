/**
 * AudioPreprocessor.ts
 * Comprehensive audio pre-processing pipeline for telephony and media codecs:
 * - Multi-channel selection (Left, Right, Mono Mix, custom channel index)
 * - Bandlimited sinc resampling to any target rate (8k, 16k, 32k, 48k)
 * - DC offset removal (single-pole high-pass DC blocker)
 * - Telecom high-pass filter (70 Hz 2nd order Butterworth)
 * - Peak / RMS normalization
 * - Leading/trailing silence trimming with pre/post margin
 * - Target duration padding or looping
 */

export interface PreprocessOptions {
  channel?: 'left' | 'right' | 'mix' | number;
  targetSampleRate: number;
  removeDc?: boolean;
  highPassFilter?: boolean;
  normalize?: boolean;
  targetPeakDbfs?: number; // Default -1.0 dBFS
  trimSilence?: boolean;
  trimThresholdDbfs?: number; // Default -50 dBFS
  trimMarginMs?: number; // Default 50 ms
  targetDurationSec?: number;
  durationMode?: 'pad' | 'loop'; // 'pad' (default) or 'loop'
}

export interface PreprocessResult {
  pcmFloat: Float32Array; // Normalized [-1.0, 1.0]
  pcm16: Int16Array; // Signed 16-bit [-32768, 32767]
  sampleRate: number;
  durationSec: number;
  peakDbfs: number;
  rmsDbfs: number;
}

export class AudioPreprocessor {
  /**
   * Preprocesses raw audio channels into ready-to-encode single-channel PCM.
   */
  public static process(
    channels: Float32Array[],
    inputSampleRate: number,
    options: PreprocessOptions
  ): PreprocessResult {
    if (!channels || channels.length === 0 || channels[0].length === 0) {
      return {
        pcmFloat: new Float32Array(0),
        pcm16: new Int16Array(0),
        sampleRate: options.targetSampleRate,
        durationSec: 0,
        peakDbfs: -100,
        rmsDbfs: -100,
      };
    }

    // 1. Channel extraction / downmixing
    let mono = this.selectChannel(channels, options.channel ?? 'mix');

    // 2. DC removal
    if (options.removeDc !== false) {
      mono = this.removeDcOffset(mono);
    }

    // 3. Optional 70 Hz high-pass filter (removes AC hum / sub-bass rumble)
    if (options.highPassFilter) {
      mono = this.applyHighPass(mono, inputSampleRate, 70);
    }

    // 4. Bandlimited sinc resampling to target rate
    if (inputSampleRate !== options.targetSampleRate) {
      mono = this.resample(mono, inputSampleRate, options.targetSampleRate);
    }
    const currentRate = options.targetSampleRate;

    // 5. Silence trimming
    if (options.trimSilence) {
      mono = this.trimSilence(
        mono,
        currentRate,
        options.trimThresholdDbfs ?? -50.0,
        options.trimMarginMs ?? 50
      );
    }

    // 6. Target duration padding or looping
    if (options.targetDurationSec && options.targetDurationSec > 0) {
      mono = this.adjustDuration(
        mono,
        currentRate,
        options.targetDurationSec,
        options.durationMode ?? 'pad'
      );
    }

    // 7. Normalization
    if (options.normalize) {
      mono = this.normalizePeak(mono, options.targetPeakDbfs ?? -1.0);
    }

    // 8. Convert to Int16Array and compute stats
    const len = mono.length;
    const pcm16 = new Int16Array(len);
    let peak = 0.0;
    let sumSq = 0.0;

    for (let i = 0; i < len; i++) {
      let s = mono[i];
      if (s > 1.0) s = 1.0;
      else if (s < -1.0) s = -1.0;

      const absS = Math.abs(s);
      if (absS > peak) peak = absS;
      sumSq += s * s;

      const val16 = Math.round(s * 32767);
      pcm16[i] = val16 < -32768 ? -32768 : val16 > 32767 ? 32767 : val16;
    }

    const rms = len > 0 ? Math.sqrt(sumSq / len) : 0;
    const peakDbfs = peak > 1e-6 ? 20 * Math.log10(peak) : -100;
    const rmsDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -100;
    const durationSec = currentRate > 0 ? len / currentRate : 0;

    return {
      pcmFloat: mono,
      pcm16,
      sampleRate: currentRate,
      durationSec,
      peakDbfs: Math.round(peakDbfs * 10) / 10,
      rmsDbfs: Math.round(rmsDbfs * 10) / 10,
    };
  }

  /**
   * Extracts or mixes channels to single mono Float32Array.
   */
  public static selectChannel(
    channels: Float32Array[],
    selection: 'left' | 'right' | 'mix' | number
  ): Float32Array {
    const numChannels = channels.length;
    if (numChannels === 1) {
      return new Float32Array(channels[0]);
    }

    if (selection === 'left' || selection === 0) {
      return new Float32Array(channels[0]);
    }

    if (selection === 'right' || selection === 1) {
      return new Float32Array(channels[1] ?? channels[0]);
    }

    if (typeof selection === 'number' && selection >= 0 && selection < numChannels) {
      return new Float32Array(channels[selection]);
    }

    // Downmix to mono: average of all channels
    const len = channels[0].length;
    const out = new Float32Array(len);
    for (let c = 0; c < numChannels; c++) {
      const ch = channels[c];
      const chLen = Math.min(len, ch.length);
      for (let i = 0; i < chLen; i++) {
        out[i] += ch[i];
      }
    }
    const factor = 1.0 / numChannels;
    for (let i = 0; i < len; i++) {
      out[i] *= factor;
    }
    return out;
  }

  /**
   * Single-pole DC blocker filter: y[n] = x[n] - x[n-1] + 0.995 * y[n-1]
   */
  public static removeDcOffset(input: Float32Array): Float32Array {
    const len = input.length;
    const out = new Float32Array(len);
    let xPrev = 0.0;
    let yPrev = 0.0;
    const R = 0.995;

    for (let i = 0; i < len; i++) {
      const x = input[i];
      const y = x - xPrev + R * yPrev;
      out[i] = y;
      xPrev = x;
      yPrev = y;
    }
    return out;
  }

  /**
   * 2nd order Butterworth high-pass filter.
   */
  public static applyHighPass(
    input: Float32Array,
    sampleRate: number,
    cutoffHz: number
  ): Float32Array {
    const len = input.length;
    const out = new Float32Array(len);

    const w = 2.0 * Math.PI * cutoffHz / sampleRate;
    const cosw = Math.cos(w);
    const alpha = Math.sin(w) / (2.0 * Math.SQRT1_2); // Q = 0.7071

    const b0 = (1.0 + cosw) / 2.0;
    const b1 = -(1.0 + cosw);
    const b2 = (1.0 + cosw) / 2.0;
    const a0 = 1.0 + alpha;
    const a1 = -2.0 * cosw;
    const a2 = 1.0 - alpha;

    const nb0 = b0 / a0;
    const nb1 = b1 / a0;
    const nb2 = b2 / a0;
    const na1 = a1 / a0;
    const na2 = a2 / a0;

    let x1 = 0.0, x2 = 0.0;
    let y1 = 0.0, y2 = 0.0;

    for (let i = 0; i < len; i++) {
      const x0 = input[i];
      const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
      out[i] = y0;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
    }
    return out;
  }

  /**
   * Bandlimited sinc interpolation resampler with Hann window.
   */
  public static resample(
    input: Float32Array,
    fromRate: number,
    toRate: number
  ): Float32Array {
    if (fromRate === toRate || input.length === 0) {
      return new Float32Array(input);
    }

    const ratio = toRate / fromRate;
    const dstLen = Math.round(input.length * ratio);
    const output = new Float32Array(dstLen);

    const filterRadius = 16;
    const cutoff = ratio < 1.0 ? ratio * 0.95 : 0.98;
    const srcLen = input.length;

    for (let i = 0; i < dstLen; i++) {
      const srcPos = i / ratio;
      const centerIdx = Math.floor(srcPos);
      let sum = 0.0;
      let weightSum = 0.0;

      for (let j = -filterRadius; j <= filterRadius; j++) {
        const k = centerIdx + j;
        if (k >= 0 && k < srcLen) {
          const dx = srcPos - k;
          if (dx === 0) {
            sum += input[k];
            weightSum += 1.0;
          } else {
            const pix = Math.PI * dx;
            const sinc = Math.sin(pix * cutoff) / (pix * cutoff);
            const hann = 0.5 * (1.0 + Math.cos((Math.PI * dx) / (filterRadius + 1)));
            const w = sinc * hann;
            sum += input[k] * w;
            weightSum += w;
          }
        }
      }

      output[i] = weightSum > 1e-6 ? sum / weightSum : 0.0;
    }

    return output;
  }

  /**
   * Trims leading and trailing silence below threshold dBFS.
   */
  public static trimSilence(
    input: Float32Array,
    sampleRate: number,
    thresholdDbfs: number,
    marginMs: number
  ): Float32Array {
    const len = input.length;
    if (len === 0) return input;

    const thresholdLinear = Math.pow(10, thresholdDbfs / 20);
    const windowSize = Math.max(16, Math.round(0.010 * sampleRate)); // 10 ms window
    const marginSamples = Math.round((marginMs / 1000) * sampleRate);

    // Find first non-silent window
    let startIdx = 0;
    for (let i = 0; i < len; i += windowSize) {
      let sumSq = 0;
      const end = Math.min(len, i + windowSize);
      for (let j = i; j < end; j++) {
        sumSq += input[j] * input[j];
      }
      const rms = Math.sqrt(sumSq / (end - i));
      if (rms >= thresholdLinear) {
        startIdx = Math.max(0, i - marginSamples);
        break;
      }
    }

    // Find last non-silent window
    let endIdx = len;
    for (let i = len; i > 0; i -= windowSize) {
      const start = Math.max(0, i - windowSize);
      let sumSq = 0;
      for (let j = start; j < i; j++) {
        sumSq += input[j] * input[j];
      }
      const rms = Math.sqrt(sumSq / (i - start));
      if (rms >= thresholdLinear) {
        endIdx = Math.min(len, i + marginSamples);
        break;
      }
    }

    if (startIdx >= endIdx) {
      return input; // Silence all through or cannot trim
    }

    return input.slice(startIdx, endIdx);
  }

  /**
   * Pads or loops audio to reach exact target duration.
   */
  public static adjustDuration(
    input: Float32Array,
    sampleRate: number,
    targetDurationSec: number,
    mode: 'pad' | 'loop'
  ): Float32Array {
    const targetSamples = Math.round(targetDurationSec * sampleRate);
    const currentSamples = input.length;

    if (currentSamples === targetSamples) {
      return new Float32Array(input);
    }

    if (currentSamples > targetSamples) {
      // Truncate to target duration
      return input.slice(0, targetSamples);
    }

    // currentSamples < targetSamples
    const out = new Float32Array(targetSamples);
    if (mode === 'loop' && currentSamples > 0) {
      let offset = 0;
      while (offset < targetSamples) {
        const toCopy = Math.min(currentSamples, targetSamples - offset);
        out.set(input.subarray(0, toCopy), offset);
        offset += toCopy;
      }
    } else {
      // Zero-pad (silence)
      out.set(input, 0);
    }

    return out;
  }

  /**
   * Normalizes audio to target peak dBFS.
   */
  public static normalizePeak(input: Float32Array, targetPeakDbfs: number): Float32Array {
    let peak = 0.0;
    const len = input.length;
    for (let i = 0; i < len; i++) {
      const absS = Math.abs(input[i]);
      if (absS > peak) peak = absS;
    }

    if (peak < 1e-6) {
      return new Float32Array(input);
    }

    const targetPeakLinear = Math.pow(10, targetPeakDbfs / 20.0);
    const gain = targetPeakLinear / peak;

    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      out[i] = input[i] * gain;
    }
    return out;
  }
}
