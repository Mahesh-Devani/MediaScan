/**
 * AudioMixer.ts
 * Multi-clip mixing, paste-mixing, crossfading, and concatenation engine.
 * Includes peak analysis, clipping warning, auto-attenuation, and soft limiter.
 */

export type MixMode = 'mix' | 'replace' | 'insert' | 'crossfade';

export interface PasteMixOptions {
  mode: MixMode;
  offsetSample: number;
  gainA: number; // Linear gain factor for original (e.g. 1.0 = 100%)
  gainB: number; // Linear gain factor for mix/clipboard (e.g. 1.0 = 100%)
  clippingStrategy: 'auto-reduce' | 'soft-limiter' | 'leave';
  extendLength: boolean;
}

export interface MixResult {
  channels: Float32Array[];
  predictedPeakDbfs: number;
  isClipped: boolean;
  attenuationGainDb: number;
  durationSec: number;
}

export class AudioMixer {
  /**
   * Mix clip B into clip A at offsetSample with gains and clipping strategy.
   */
  public static mix(
    targetChannels: Float32Array[],
    sourceChannels: Float32Array[],
    options: PasteMixOptions,
    sampleRate: number
  ): MixResult {
    const numChannels = Math.max(targetChannels.length, sourceChannels.length);
    const lenA = targetChannels[0] ? targetChannels[0].length : 0;
    const lenB = sourceChannels[0] ? sourceChannels[0].length : 0;

    let outLength = lenA;
    if (options.extendLength) {
      outLength = Math.max(lenA, options.offsetSample + lenB);
    }

    // Pre-allocate output channels
    const mixed: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      mixed.push(new Float32Array(outLength));
    }

    // Copy A with gainA
    for (let c = 0; c < numChannels; c++) {
      const srcA = targetChannels[c] || targetChannels[0];
      const dst = mixed[c];
      if (srcA) {
        for (let i = 0; i < lenA; i++) {
          dst[i] = srcA[i] * options.gainA;
        }
      }
    }

    // Mix B with gainB
    for (let c = 0; c < numChannels; c++) {
      const srcB = sourceChannels[c] || sourceChannels[0];
      const dst = mixed[c];
      if (!srcB) continue;

      for (let i = 0; i < lenB; i++) {
        const outIdx = options.offsetSample + i;
        if (outIdx >= outLength) break;
        if (outIdx < 0) continue;

        if (options.mode === 'mix') {
          dst[outIdx] += srcB[i] * options.gainB;
        } else if (options.mode === 'replace') {
          dst[outIdx] = srcB[i] * options.gainB;
        } else if (options.mode === 'crossfade') {
          const t = i / (lenB - 1 || 1);
          const origA = targetChannels[c] && outIdx < lenA ? targetChannels[c][outIdx] : 0;
          dst[outIdx] = (1 - t) * origA * options.gainA + t * srcB[i] * options.gainB;
        }
      }
    }

    // Peak analysis
    let maxPeak = 0;
    for (let c = 0; c < numChannels; c++) {
      const ch = mixed[c];
      for (let i = 0; i < ch.length; i++) {
        const absVal = Math.abs(ch[i]);
        if (absVal > maxPeak) maxPeak = absVal;
      }
    }

    const predictedPeakDbfs = maxPeak > 1e-6 ? 20 * Math.log10(maxPeak) : -96.0;
    const isClipped = maxPeak > 1.0;
    let attenuationGainDb = 0;

    if (isClipped) {
      if (options.clippingStrategy === 'auto-reduce') {
        // Attenuate so that max peak is -0.5 dBFS (~0.944)
        const targetAmp = Math.pow(10, -0.5 / 20);
        const factor = targetAmp / maxPeak;
        attenuationGainDb = 20 * Math.log10(factor);

        for (let c = 0; c < numChannels; c++) {
          const ch = mixed[c];
          for (let i = 0; i < ch.length; i++) {
            ch[i] *= factor;
          }
        }
      } else if (options.clippingStrategy === 'soft-limiter') {
        // Soft-knee tanh limiter
        for (let c = 0; c < numChannels; c++) {
          const ch = mixed[c];
          for (let i = 0; i < ch.length; i++) {
            const v = ch[i];
            if (v > 0.8) {
              ch[i] = 0.8 + 0.2 * Math.tanh((v - 0.8) / 0.2);
            } else if (v < -0.8) {
              ch[i] = -0.8 + 0.2 * Math.tanh((v + 0.8) / 0.2);
            }
          }
        }
      } else {
        // Leave / hard clamp to [-1.0, 1.0]
        for (let c = 0; c < numChannels; c++) {
          const ch = mixed[c];
          for (let i = 0; i < ch.length; i++) {
            ch[i] = Math.max(-1.0, Math.min(1.0, ch[i]));
          }
        }
      }
    }

    return {
      channels: mixed,
      predictedPeakDbfs: Math.round(predictedPeakDbfs * 10) / 10,
      isClipped,
      attenuationGainDb: Math.round(attenuationGainDb * 10) / 10,
      durationSec: sampleRate > 0 ? outLength / sampleRate : 0
    };
  }

  /**
   * Concat multiple clips in sequence with gap silence duration.
   */
  public static concat(
    clips: Float32Array[][],
    gapSamples: number = 0
  ): Float32Array[] {
    if (clips.length === 0) return [];
    const numChannels = clips[0].length;

    let totalLength = 0;
    for (let k = 0; k < clips.length; k++) {
      totalLength += clips[k][0] ? clips[k][0].length : 0;
      if (k < clips.length - 1) totalLength += gapSamples;
    }

    const out: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      out.push(new Float32Array(totalLength));
    }

    let writeOffset = 0;
    for (let k = 0; k < clips.length; k++) {
      const clip = clips[k];
      const clipLen = clip[0] ? clip[0].length : 0;

      for (let c = 0; c < numChannels; c++) {
        const src = clip[c] || clip[0];
        if (src) {
          out[c].set(src, writeOffset);
        }
      }

      writeOffset += clipLen + gapSamples;
    }

    return out;
  }
}
