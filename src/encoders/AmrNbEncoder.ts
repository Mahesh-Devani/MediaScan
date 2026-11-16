/**
 * AmrNbEncoder.ts
 * 3GPP TS 26.101 Adaptive Multi-Rate Narrowband (AMR-NB) speech encoder wrapper.
 * Encodes 8 kHz mono audio into octet-aligned frames and standardized .amr files
 * using the OpenCORE-AMR engine (compiled to WebAssembly / JS).
 */

import AMR from './amrnb.esm.js';
import { RawClipPackager } from './RawClipPackager.ts';

export interface AmrNbEncodeOptions {
  mode?: number; // 0..7 (MR475 through MR122, default 5: MR795 / 7.95 kbps)
  dtx?: boolean; // false = continuous speech, true = discontinuous transmission (SID/NO_DATA)
}

export class AmrNbEncoder {
  public static readonly BITRATES = [4750, 5150, 5900, 6700, 7400, 7950, 10200, 12200];

  public static readonly MODES = {
    MR475: 0,
    MR515: 1,
    MR59: 2,
    MR67: 3,
    MR74: 4,
    MR795: 5,
    MR102: 6,
    MR122: 7,
  } as const;

  /**
   * Resolves AMR-NB mode index (0..7) from target bitrate in bps.
   */
  public static modeFromBitrate(bps: number): number {
    const bitrates = AmrNbEncoder.BITRATES;
    let closest = 5; // default 7.95k
    let minDiff = Infinity;
    for (let i = 0; i < bitrates.length; i++) {
      const diff = Math.abs(bitrates[i] - bps);
      if (diff < minDiff) {
        minDiff = diff;
        closest = i;
      }
    }
    return closest;
  }

  /**
   * Returns bitrate in bps for given mode index (0..7).
   */
  public static bitrateFromMode(mode: number): number {
    return AmrNbEncoder.BITRATES[Math.max(0, Math.min(7, mode))] || 7950;
  }

  /**
   * Encodes 8 kHz linear PCM audio into discrete octet-aligned AMR-NB frames.
   * Each frame begins with a 1-byte Table of Contents (ToC) conforming to RFC 4867 §5.3.
   */
  public static encode(
    pcm: Int16Array | Float32Array,
    options?: AmrNbEncodeOptions
  ): Uint8Array[] {
    const mode = options?.mode ?? AmrNbEncoder.MODES.MR795;
    const dtx = !!options?.dtx;

    let pcm16: Int16Array;
    if (pcm instanceof Int16Array) {
      pcm16 = pcm;
    } else {
      pcm16 = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        const s = Math.round(pcm[i] * 32767);
        pcm16[i] = s > 32767 ? 32767 : s < -32768 ? -32768 : s;
      }
    }

    const engine = AMR as any;
    if (typeof engine.encodeFrames === 'function') {
      return engine.encodeFrames(pcm16, mode, dtx);
    }

    // Fallback: encode via engine.encode and split by frame sizes
    const float32 = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      float32[i] = pcm16[i] / 32768.0;
    }
    const rawFile: Uint8Array | null = engine.encode(float32, 8000, mode);
    if (!rawFile || rawFile.length <= 6) return [];

    // Parse frames out of raw file (skipping "#!AMR\n")
    const SIZES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 6, 5, 5, 0, 0, 0, 0];
    const frames: Uint8Array[] = [];
    let offset = 6;
    while (offset < rawFile.length) {
      const toc = rawFile[offset];
      const ft = (toc >> 3) & 0x0f;
      const payloadSize = SIZES[ft] ?? 0;
      const frameLen = 1 + payloadSize;
      if (offset + frameLen > rawFile.length) break;
      frames.push(rawFile.subarray(offset, offset + frameLen));
      offset += frameLen;
    }
    return frames;
  }

  /**
   * Encodes 8 kHz PCM and packages into a standard RFC 4867 3GPP container file
   * starting with "#!AMR\n" magic header.
   */
  public static encodeToAmrFile(
    pcm: Int16Array | Float32Array,
    options?: AmrNbEncodeOptions
  ): Uint8Array {
    const frames = AmrNbEncoder.encode(pcm, options);
    const magic = new TextEncoder().encode('#!AMR\n');
    const totalBytes = magic.length + frames.reduce((acc, f) => acc + f.length, 0);
    const out = new Uint8Array(totalBytes);
    out.set(magic, 0);
    let offset = magic.length;
    for (const frame of frames) {
      out.set(frame, offset);
      offset += frame.length;
    }
    return out;
  }
}
