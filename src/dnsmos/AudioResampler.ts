/**
 * AudioResampler.ts
 * High-fidelity bandlimited sinc audio resampler to 16,000 Hz mono Float32Array.
 */

export class AudioResampler {
  public static readonly TARGET_SAMPLE_RATE = 16000;

  /**
   * Resamples PCM input (Int16Array or Float32Array) to 16 kHz Float32Array normalized to [-1.0, 1.0].
   */
  public static resampleTo16k(
    input: Int16Array | Float32Array,
    inputSampleRate: number
  ): Float32Array {
    if (!input || input.length === 0) {
      return new Float32Array(0);
    }

    // Convert input to normalized Float32Array
    let srcFloat: Float32Array;
    if (input instanceof Int16Array) {
      srcFloat = new Float32Array(input.length);
      for (let i = 0; i < input.length; i++) {
        srcFloat[i] = input[i] / 32768.0;
      }
    } else {
      srcFloat = input;
    }

    if (inputSampleRate === this.TARGET_SAMPLE_RATE) {
      return new Float32Array(srcFloat);
    }

    const srcLen = srcFloat.length;
    const targetRate = this.TARGET_SAMPLE_RATE;
    const ratio = targetRate / inputSampleRate;
    const dstLen = Math.round(srcLen * ratio);
    const output = new Float32Array(dstLen);

    // High quality bandlimited sinc interpolation with Hann window
    const filterRadius = 16;
    const cutoff = ratio < 1.0 ? ratio * 0.95 : 0.98; // Anti-aliasing cutoff for downsampling, passband for upsampling

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
            sum += srcFloat[k];
            weightSum += 1.0;
          } else {
            const pix = Math.PI * dx;
            const sinc = Math.sin(pix * cutoff) / (pix * cutoff);
            const win = 0.5 * (1.0 + Math.cos((Math.PI * dx) / filterRadius));
            const w = sinc * win;
            sum += srcFloat[k] * w;
            weightSum += w;
          }
        }
      }

      output[i] = weightSum > 0 ? sum / weightSum : 0;
    }

    return output;
  }
}
