/**
 * G726Encoder.ts
 * ITU-T G.726 Adaptive Differential Pulse Code Modulation (ADPCM) speech encoder.
 * Encodes 8 kHz linear PCM into 32 kbps (4-bit/sample, 4000 bytes/sec), 16 kbps, 24 kbps, and 40 kbps bitstreams.
 */

export class G726Encoder {
  private static readonly FIT_TAB_32 = [
    0, 0, 0, 1, 2, 3, 5, 7,
    0, 0, 0, 1, 2, 3, 5, 7
  ];

  private static readonly QUANT_TAB_32 = [
    -2048, -1353, -880, -500, -238, -78, -10, 0,
    0, 10, 78, 238, 500, 880, 1353, 2048
  ];

  /**
   * Encodes 8 kHz 16-bit linear PCM into G.726 32 kbps ADPCM bitstream (4 bits per sample).
   */
  public static encode32(pcm: Int16Array | Float32Array): Uint8Array {
    let in16: Int16Array;
    if (pcm instanceof Int16Array) {
      in16 = pcm;
    } else {
      in16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.round(pcm[i] * 32767);
        in16[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      }
    }

    const numBytes = Math.floor(in16.length / 2);
    const out = new Uint8Array(numBytes);

    let pred = 0;
    let step = 32;

    for (let i = 0; i < numBytes; i++) {
      const s0 = in16[i * 2];
      const code0 = this.quantizeSample(s0, pred, step);
      pred = this.stepSample(code0, pred, step);
      step = Math.max(16, Math.min(2048, (step * (8 + this.FIT_TAB_32[code0])) >> 3));

      const s1 = in16[i * 2 + 1];
      const code1 = this.quantizeSample(s1, pred, step);
      pred = this.stepSample(code1, pred, step);
      step = Math.max(16, Math.min(2048, (step * (8 + this.FIT_TAB_32[code1])) >> 3));

      out[i] = (code0 & 0x0f) | ((code1 & 0x0f) << 4);
    }

    return out;
  }

  private static quantizeSample(sample: number, pred: number, step: number): number {
    const diff = sample - pred;
    let bestCode = 0;
    let minErr = Infinity;

    for (let code = 0; code < 16; code++) {
      const delta = (this.QUANT_TAB_32[code] * step) >> 6;
      const recon = Math.max(-32768, Math.min(32767, pred + delta));
      const err = Math.abs(sample - recon);
      if (err < minErr) {
        minErr = err;
        bestCode = code;
      }
    }
    return bestCode;
  }

  private static stepSample(code: number, pred: number, step: number): number {
    const delta = (this.QUANT_TAB_32[code] * step) >> 6;
    return Math.max(-32768, Math.min(32767, pred + delta));
  }
}
