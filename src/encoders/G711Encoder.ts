/**
 * G711Encoder.ts
 * ITU-T Recommendation G.711 Logarithmic Companding Encoder.
 * Converts 16-bit linear PCM (or Float32Array [-1.0, 1.0]) to 8-bit G.711 µ-law and A-law.
 * Pure TypeScript implementation featuring precomputed tables for fast real-time throughput.
 */

export class G711Encoder {
  private static ulawTable: Uint8Array = new Uint8Array(65536);
  private static alawTable: Uint8Array = new Uint8Array(65536);
  private static isInitialized = false;

  private static initTables(): void {
    if (this.isInitialized) return;

    for (let i = 0; i < 65536; i++) {
      // Map 0..65535 to signed 16-bit -32768..32767
      const sample = i < 32768 ? i : i - 65536;
      this.ulawTable[i] = this.linearToUlawDirect(sample);
      this.alawTable[i] = this.linearToAlawDirect(sample);
    }

    this.isInitialized = true;
  }

  /**
   * Direct ITU-T G.711 mu-law encoding for a single 16-bit linear sample.
   */
  public static linearToUlawDirect(sample: number): number {
    const BIAS = 0x84; // 132
    const CLIP = 32635;

    let sign = (sample >> 8) & 0x80;
    if (sign !== 0) {
      sample = -sample;
    }
    if (sample > CLIP) {
      sample = CLIP;
    }
    sample += BIAS;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    const mantissa = (sample >> (exponent + 3)) & 0x0f;
    const ulawByte = ~(sign | (exponent << 4) | mantissa) & 0xff;
    return ulawByte;
  }

  /**
   * Direct ITU-T G.711 A-law encoding for a single 16-bit linear sample.
   */
  public static linearToAlawDirect(sample: number): number {
    let sign = 0;
    if (sample >= 0) {
      sign = 0xd5; // 0x80 | 0x55
    } else {
      sign = 0x55;
      sample = -sample - 1;
    }

    if (sample > 32767) sample = 32767;

    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
      exponent--;
    }

    let mantissa: number;
    if (exponent === 0) {
      mantissa = (sample >> 4) & 0x0f;
    } else {
      mantissa = (sample >> (exponent + 3)) & 0x0f;
    }

    const alawByte = ((exponent << 4) | mantissa) ^ sign;
    return alawByte & 0xff;
  }

  /**
   * Encodes 16-bit linear PCM (or normalized Float32Array) to G.711 µ-law octets.
   */
  public static encodeUlaw(input: Int16Array | Float32Array): Uint8Array {
    this.initTables();
    const len = input.length;
    const out = new Uint8Array(len);

    if (input instanceof Int16Array) {
      for (let i = 0; i < len; i++) {
        // Convert signed 16-bit sample to 0..65535 table index
        const idx = input[i] & 0xffff;
        out[i] = this.ulawTable[idx];
      }
    } else {
      for (let i = 0; i < len; i++) {
        let s = Math.round(input[i] * 32767);
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        out[i] = this.ulawTable[s & 0xffff];
      }
    }

    return out;
  }

  /**
   * Encodes 16-bit linear PCM (or normalized Float32Array) to G.711 A-law octets.
   */
  public static encodeAlaw(input: Int16Array | Float32Array): Uint8Array {
    this.initTables();
    const len = input.length;
    const out = new Uint8Array(len);

    if (input instanceof Int16Array) {
      for (let i = 0; i < len; i++) {
        const idx = input[i] & 0xffff;
        out[i] = this.alawTable[idx];
      }
    } else {
      for (let i = 0; i < len; i++) {
        let s = Math.round(input[i] * 32767);
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        out[i] = this.alawTable[s & 0xffff];
      }
    }

    return out;
  }
}
