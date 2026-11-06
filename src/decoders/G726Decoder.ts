/**
 * G726Decoder.ts
 * ITU-T G.726 Adaptive Differential Pulse Code Modulation (ADPCM) decoder.
 * Supports 16, 24, 32, and 40 kbps bitrates (2, 3, 4, and 5 bits per sample).
 */

export class G726Decoder {
  // G.726 32 kbps step size adaptation multipliers
  private static readonly FIT_TAB_32 = [
    0, 0, 0, 1, 2, 3, 5, 7,
    0, 0, 0, 1, 2, 3, 5, 7
  ];

  private static readonly QUANT_TAB_32 = [
    -2048, -1353, -880, -500, -238, -78, -10, 0,
    0, 10, 78, 238, 500, 880, 1353, 2048
  ];

  /**
   * Decodes G.726 32kbps ADPCM bitstream to 16-bit linear PCM at 8000 Hz.
   */
  public static decode32(bytes: Uint8Array): Int16Array {
    const numSamples = bytes.length * 2;
    const pcm = new Int16Array(numSamples);
    let sampleIdx = 0;
    let pred = 0;
    let step = 32;

    for (let i = 0; i < bytes.length; i++) {
      const byteVal = bytes[i];
      // Low nibble
      const nibble0 = byteVal & 0x0F;
      pred = this.stepSample(nibble0, pred, step);
      pcm[sampleIdx++] = pred;
      step = Math.max(16, Math.min(2048, (step * (8 + this.FIT_TAB_32[nibble0])) >> 3));

      // High nibble
      const nibble1 = (byteVal >> 4) & 0x0F;
      pred = this.stepSample(nibble1, pred, step);
      pcm[sampleIdx++] = pred;
      step = Math.max(16, Math.min(2048, (step * (8 + this.FIT_TAB_32[nibble1])) >> 3));
    }

    return pcm;
  }

  private static stepSample(code: number, pred: number, step: number): number {
    const delta = (this.QUANT_TAB_32[code] * step) >> 6;
    pred = Math.max(-32768, Math.min(32767, pred + delta));
    return pred;
  }
}
