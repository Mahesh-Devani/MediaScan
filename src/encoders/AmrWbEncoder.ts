/**
 * AmrWbEncoder.ts
 * 3GPP TS 26.201 Adaptive Multi-Rate Wideband (AMR-WB) speech encoder wrapper.
 * Encodes 16 kHz audio into octet-aligned frames and standardized .awb / .AMRWBr files
 * utilizing the official 3GPP reference codec in AMR-WB Interoperable (IO) mode.
 */

import { EvsEncoder } from './EvsEncoder.ts';
import { RawClipPackager } from './RawClipPackager.ts';

export interface AmrWbEncodeOptions {
  mode?: number; // 0..8 (6.6k through 23.85k, default 8: 23.85 kbps)
  dtx?: boolean; // false = continuous speech, true = discontinuous transmission (SID/NO_DATA)
}

export class AmrWbEncoder {
  public static readonly BITRATES = [
    6600,   // Mode 0: 6.60 kbps
    8850,   // Mode 1: 8.85 kbps
    12650,  // Mode 2: 12.65 kbps
    14250,  // Mode 3: 14.25 kbps
    15850,  // Mode 4: 15.85 kbps
    18250,  // Mode 5: 18.25 kbps
    19850,  // Mode 6: 19.85 kbps
    23050,  // Mode 7: 23.05 kbps
    23850,  // Mode 8: 23.85 kbps
  ];

  /**
   * Resolves AMR-WB mode index (0..8) from target bitrate in bps.
   */
  public static modeFromBitrate(bps: number): number {
    const bitrates = AmrWbEncoder.BITRATES;
    let closest = 8; // default 23.85k
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
   * Returns bitrate in bps for given mode index (0..8).
   */
  public static bitrateFromMode(mode: number): number {
    return AmrWbEncoder.BITRATES[Math.max(0, Math.min(8, mode))] || 23850;
  }

  /**
   * Encodes 16 kHz linear PCM audio into discrete octet-aligned AMR-WB frames.
   * Conforms to RFC 4867 §5.3 / 3GPP TS 26.201 with 1-byte ToC:
   * Bits: [ 0 | FT (4b) | Q (1b) | 00 (2b) ]
   */
  public static async encode(
    pcm: Int16Array | Float32Array,
    options?: AmrWbEncodeOptions
  ): Promise<Uint8Array[]> {
    const mode = options?.mode ?? 8;
    const bitrateBps = AmrWbEncoder.bitrateFromMode(mode);
    const dtx = !!options?.dtx;

    // Use 3GPP EVS reference codec in AMR-WB Interoperable (IO) mode
    const rawFrames = await EvsEncoder.encode(pcm, {
      sampleRate: 16000,
      bitrateBps,
      bandwidth: 'WB',
      dtx,
      isAmrWbIo: true,
    });

    // Convert EVS MIME ToC byte (0x30 | mode) to RFC 4867 octet-aligned ToC ((mode << 3) | 0x04)
    return rawFrames.map((frame) => {
      if (frame.length === 0) return frame;
      const converted = new Uint8Array(frame.length);
      converted.set(frame);
      const frameMode = frame[0] & 0x0f;
      // Set Q=1 (good frame, bit 2 = 0x04), FT in bits 6..3
      converted[0] = (frameMode << 3) | 0x04;
      return converted;
    });
  }

  /**
   * Encodes 16 kHz PCM and packages into a standard RFC 4867 3GPP container file
   * starting with "#!AMR-WB\n" magic header (9 bytes).
   */
  public static async encodeToAwbFile(
    pcm: Int16Array | Float32Array,
    options?: AmrWbEncodeOptions
  ): Promise<Uint8Array> {
    const frames = await AmrWbEncoder.encode(pcm, options);
    const magic = new TextEncoder().encode('#!AMR-WB\n');
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
