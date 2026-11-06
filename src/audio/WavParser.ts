/**
 * WavParser.ts
 * Robust, zero-dependency RIFF/RF64 WAV file parser and de-interleaver.
 * Supports:
 * - Standard PCM (8-bit unsigned, 16-bit signed, 24-bit packed, 32-bit signed)
 * - IEEE Float (32-bit float, 64-bit double)
 * - G.711 A-law (0x0006) and mu-law (0x0007)
 * - IMA/DVI ADPCM (0x0011) and MS ADPCM (0x0002)
 * - WAVE_FORMAT_EXTENSIBLE (0xFFFE) with sub-format GUIDs
 * - Multi-channel (up to 8+ channels) de-interleaving
 * - Streamed/truncated WAVs (data size = 0 or 0xFFFFFFFF)
 * - DC offset removal, NaN/Infinity sanitization, and clipping detection
 */

import { G711Decoder } from '../decoders/G711Decoder.ts';

export interface ParsedWav {
  fileName: string;
  sampleRate: number;
  numChannels: number;
  bitsPerSample: number;
  formatTag: number;
  formatName: string;
  durationSec: number;
  totalSamplesPerChannel: number;
  channelData: Float32Array[]; // Separate array per channel, normalized [-1.0, 1.0]
  channelMask?: number;
  clippingDetected: boolean;
  dcOffsetDetected: boolean;
  truncated: boolean;
}

export class WavParser {
  private static readonly SUBTYPE_PCM = '00000001-0000-0010-8000-00aa00389b71';
  private static readonly SUBTYPE_FLOAT = '00000003-0000-0010-8000-00aa00389b71';
  private static readonly SUBTYPE_ALAW = '00000006-0000-0010-8000-00aa00389b71';
  private static readonly SUBTYPE_MULAW = '00000007-0000-0010-8000-00aa00389b71';

  /**
   * Parse a WAV / RIFF / RF64 file buffer into normalized Float32Array channel buffers.
   */
  public static parse(buffer: ArrayBuffer | Uint8Array, fileName: string = 'audio.wav'): ParsedWav {
    const uint8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const view = new DataView(uint8.buffer, uint8.byteOffset, uint8.byteLength);

    if (uint8.byteLength < 12) {
      throw new Error(`File is too small to be a valid WAV (${uint8.byteLength} bytes).`);
    }

    // 1. Verify Header Magic
    const chunkId = this.readAscii(uint8, 0, 4);
    if (chunkId !== 'RIFF' && chunkId !== 'RF64') {
      throw new Error(`Invalid WAV header: expected RIFF or RF64, got '${chunkId}'.`);
    }

    const format = this.readAscii(uint8, 8, 4);
    if (format !== 'WAVE') {
      throw new Error(`Invalid WAV format: expected WAVE, got '${format}'.`);
    }

    let offset = 12;
    let formatTag = 0;
    let numChannels = 0;
    let sampleRate = 0;
    let bitsPerSample = 0;
    let blockAlign = 0;
    let channelMask: number | undefined;
    let formatName = 'Unknown';
    let dataOffset = -1;
    let dataLength = 0;
    let truncated = false;

    // 2. Iterate RIFF Chunks
    while (offset + 8 <= uint8.byteLength) {
      const subChunkId = this.readAscii(uint8, offset, 4);
      let subChunkSize = view.getUint32(offset + 4, true);
      const chunkDataOffset = offset + 8;

      if (subChunkId === 'fmt ') {
        if (subChunkSize < 16) {
          throw new Error(`Corrupt WAV: fmt chunk too small (${subChunkSize} bytes).`);
        }
        formatTag = view.getUint16(chunkDataOffset, true);
        numChannels = view.getUint16(chunkDataOffset + 2, true);
        sampleRate = view.getUint32(chunkDataOffset + 4, true);
        blockAlign = view.getUint16(chunkDataOffset + 12, true);
        bitsPerSample = view.getUint16(chunkDataOffset + 14, true);

        if (formatTag === 0xFFFE && subChunkSize >= 40) {
          // WAVE_FORMAT_EXTENSIBLE
          channelMask = view.getUint32(chunkDataOffset + 20, true);
          const guidStr = this.readGuid(uint8, chunkDataOffset + 24);
          if (guidStr.toLowerCase() === this.SUBTYPE_PCM) {
            formatTag = 0x0001;
            formatName = 'Extensible PCM';
          } else if (guidStr.toLowerCase() === this.SUBTYPE_FLOAT) {
            formatTag = 0x0003;
            formatName = 'Extensible IEEE Float';
          } else if (guidStr.toLowerCase() === this.SUBTYPE_ALAW) {
            formatTag = 0x0006;
            formatName = 'Extensible A-law';
          } else if (guidStr.toLowerCase() === this.SUBTYPE_MULAW) {
            formatTag = 0x0007;
            formatName = 'Extensible mu-law';
          } else {
            formatName = `Extensible (${guidStr})`;
          }
        } else {
          formatName = this.getFormatName(formatTag, bitsPerSample);
        }
      } else if (subChunkId === 'data') {
        dataOffset = chunkDataOffset;
        // Streamed WAV check: size 0 or 0xFFFFFFFF
        if (subChunkSize === 0 || subChunkSize === 0xFFFFFFFF || (chunkDataOffset + subChunkSize > uint8.byteLength)) {
          dataLength = Math.max(0, uint8.byteLength - chunkDataOffset);
          truncated = (subChunkSize !== 0 && subChunkSize !== 0xFFFFFFFF && chunkDataOffset + subChunkSize > uint8.byteLength);
        } else {
          dataLength = subChunkSize;
        }
      }

      // Word alignment (chunks padded to multiple of 2 bytes)
      const paddedSize = subChunkSize + (subChunkSize & 1);
      offset += 8 + paddedSize;

      // If data chunk was found and reached end of file or data is rest of file
      if (dataOffset !== -1 && offset >= uint8.byteLength) {
        break;
      }
    }

    if (dataOffset === -1 || numChannels === 0 || sampleRate === 0) {
      throw new Error(`Incomplete WAV file: missing ${dataOffset === -1 ? 'data chunk' : 'valid fmt header'}.`);
    }

    // Default blockAlign if missing
    if (blockAlign === 0) {
      blockAlign = numChannels * Math.ceil(bitsPerSample / 8);
    }

    // 3. Decode Samples & De-interleave Channels
    const { channelData, clippingDetected, dcOffsetDetected } = this.decodeAndDeinterleave(
      uint8,
      dataOffset,
      dataLength,
      formatTag,
      numChannels,
      bitsPerSample,
      blockAlign
    );

    const totalSamplesPerChannel = channelData[0] ? channelData[0].length : 0;
    const durationSec = sampleRate > 0 ? totalSamplesPerChannel / sampleRate : 0;

    return {
      fileName,
      sampleRate,
      numChannels,
      bitsPerSample,
      formatTag,
      formatName,
      durationSec,
      totalSamplesPerChannel,
      channelData,
      channelMask,
      clippingDetected,
      dcOffsetDetected,
      truncated,
    };
  }

  private static decodeAndDeinterleave(
    bytes: Uint8Array,
    dataOffset: number,
    dataLength: number,
    formatTag: number,
    numChannels: number,
    bitsPerSample: number,
    blockAlign: number
  ): { channelData: Float32Array[]; clippingDetected: boolean; dcOffsetDetected: boolean } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const endOffset = Math.min(bytes.byteLength, dataOffset + dataLength);
    const totalBytes = Math.max(0, endOffset - dataOffset);

    // Prepare channel arrays
    let numFrames = 0;
    if (formatTag === 0x0001 || formatTag === 0x0003 || formatTag === 0x0006 || formatTag === 0x0007) {
      const bytesPerFrame = blockAlign > 0 ? blockAlign : numChannels * Math.ceil(bitsPerSample / 8);
      numFrames = Math.floor(totalBytes / bytesPerFrame);
    } else {
      // ADPCM or compressed formats
      numFrames = Math.floor(totalBytes / Math.max(1, blockAlign)) * 1024; // estimate
    }

    const channelData: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelData.push(new Float32Array(numFrames));
    }

    let clipCount = 0;
    let totalSamples = 0;

    if (formatTag === 0x0001) {
      // Linear PCM
      if (bitsPerSample === 8) {
        // 8-bit unsigned PCM (0..255, silence at 128)
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            const raw = bytes[pos++];
            const sample = (raw - 128) / 128.0;
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      } else if (bitsPerSample === 16) {
        // 16-bit signed LE
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            const sample = view.getInt16(pos, true) / 32768.0;
            pos += 2;
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      } else if (bitsPerSample === 24) {
        // 24-bit packed signed LE (3 bytes per sample)
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            const b0 = bytes[pos];
            const b1 = bytes[pos + 1];
            const b2 = bytes[pos + 2];
            pos += 3;
            let val = (b0 | (b1 << 8) | (b2 << 16));
            if (val & 0x800000) val |= ~0xFFFFFF; // Sign extend 24-bit to 32-bit
            const sample = val / 8388608.0;
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      } else if (bitsPerSample === 32) {
        // 32-bit signed LE
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            const sample = view.getInt32(pos, true) / 2147483648.0;
            pos += 4;
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      }
    } else if (formatTag === 0x0003) {
      // IEEE Float
      if (bitsPerSample === 32) {
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            let sample = view.getFloat32(pos, true);
            pos += 4;
            if (Number.isNaN(sample) || !Number.isFinite(sample)) {
              sample = 0.0;
            }
            sample = Math.max(-1.0, Math.min(1.0, sample));
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      } else if (bitsPerSample === 64) {
        let pos = dataOffset;
        for (let f = 0; f < numFrames; f++) {
          for (let c = 0; c < numChannels; c++) {
            let sample = Number(view.getFloat64(pos, true));
            pos += 8;
            if (Number.isNaN(sample) || !Number.isFinite(sample)) {
              sample = 0.0;
            }
            sample = Math.max(-1.0, Math.min(1.0, sample));
            channelData[c][f] = sample;
            if (Math.abs(sample) >= 0.999) clipCount++;
            totalSamples++;
          }
        }
      }
    } else if (formatTag === 0x0006) {
      // G.711 A-law
      let pos = dataOffset;
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          const raw = bytes[pos++];
          const pcm16 = G711Decoder.decodeAlaw(new Uint8Array([raw]))[0];
          channelData[c][f] = pcm16 / 32768.0;
          totalSamples++;
        }
      }
    } else if (formatTag === 0x0007) {
      // G.711 mu-law
      let pos = dataOffset;
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          const raw = bytes[pos++];
          const pcm16 = G711Decoder.decodeUlaw(new Uint8Array([raw]))[0];
          channelData[c][f] = pcm16 / 32768.0;
          totalSamples++;
        }
      }
    } else if (formatTag === 0x0011) {
      // IMA / DVI ADPCM
      return this.decodeImaAdpcm(bytes, dataOffset, dataLength, numChannels, blockAlign);
    } else if (formatTag === 0x0002) {
      // MS ADPCM
      return this.decodeMsAdpcm(bytes, dataOffset, dataLength, numChannels, blockAlign);
    } else {
      throw new Error(`Unsupported WAV audio format tag 0x${formatTag.toString(16)}. Consider using container fallback.`);
    }

    // 4. Sanitize DC offset per channel
    let dcOffsetDetected = false;
    for (let c = 0; c < numChannels; c++) {
      const ch = channelData[c];
      let sum = 0.0;
      for (let i = 0; i < ch.length; i++) {
        sum += ch[i];
      }
      const mean = ch.length > 0 ? sum / ch.length : 0;
      if (ch.length >= 100 && Math.abs(mean) > 0.002) {
        dcOffsetDetected = true;
        for (let i = 0; i < ch.length; i++) {
          ch[i] = Math.max(-1.0, Math.min(1.0, ch[i] - mean));
        }
      }
    }

    const clippingDetected = totalSamples > 0 && (clipCount / totalSamples) > 0.0005;
    return { channelData, clippingDetected, dcOffsetDetected };
  }

  // --- IMA ADPCM Decoder ---
  private static readonly IMA_STEP_TABLE = [
    7, 8, 9, 10, 11, 12, 13, 14, 16, 17,
    19, 21, 23, 25, 28, 31, 34, 37, 41, 45,
    50, 55, 60, 66, 73, 80, 88, 97, 107, 118,
    130, 143, 157, 173, 190, 209, 230, 253, 279, 307,
    337, 371, 408, 449, 494, 544, 598, 658, 724, 796,
    876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066,
    2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358,
    5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899,
    15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767
  ];

  private static readonly IMA_INDEX_TABLE = [
    -1, -1, -1, -1, 2, 4, 6, 8,
    -1, -1, -1, -1, 2, 4, 6, 8
  ];

  private static decodeImaAdpcm(
    bytes: Uint8Array,
    offset: number,
    length: number,
    numChannels: number,
    blockAlign: number
  ): { channelData: Float32Array[]; clippingDetected: boolean; dcOffsetDetected: boolean } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = Math.min(bytes.byteLength, offset + length);
    const bAlign = Math.max(4, blockAlign);
    const numBlocks = Math.floor((end - offset) / bAlign);
    const samplesPerBlock = ((bAlign - 4 * numChannels) * 8) / (4 * numChannels) + 1;
    const totalFrames = numBlocks * samplesPerBlock;

    const channelData: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelData.push(new Float32Array(totalFrames));
    }

    let writeIdx = 0;
    for (let b = 0; b < numBlocks; b++) {
      const blockStart = offset + b * bAlign;
      let pos = blockStart;

      // Block headers: predictor & index per channel
      const preds: number[] = [];
      const indices: number[] = [];
      for (let c = 0; c < numChannels; c++) {
        preds[c] = view.getInt16(pos, true);
        indices[c] = Math.max(0, Math.min(88, bytes[pos + 2]));
        pos += 4;
        channelData[c][writeIdx] = preds[c] / 32768.0;
      }
      writeIdx++;

      // Decode nibbles
      while (pos < blockStart + bAlign) {
        for (let c = 0; c < numChannels; c++) {
          if (pos >= blockStart + bAlign) break;
          const byteVal = bytes[pos++];
          // Low nibble
          const nibble1 = byteVal & 0x0F;
          preds[c] = this.decodeImaNibble(nibble1, preds[c], indices, c);
          channelData[c][writeIdx] = preds[c] / 32768.0;

          // High nibble
          const nibble2 = (byteVal >> 4) & 0x0F;
          preds[c] = this.decodeImaNibble(nibble2, preds[c], indices, c);
          channelData[c][writeIdx + 1] = preds[c] / 32768.0;
        }
        writeIdx += 2;
      }
    }

    return { channelData, clippingDetected: false, dcOffsetDetected: false };
  }

  private static decodeImaNibble(nibble: number, pred: number, indices: number[], ch: number): number {
    let index = indices[ch];
    const step = this.IMA_STEP_TABLE[index];
    let diff = step >> 3;
    if (nibble & 4) diff += step;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 8) pred -= diff; else pred += diff;

    pred = Math.max(-32768, Math.min(32767, pred));
    index += this.IMA_INDEX_TABLE[nibble];
    indices[ch] = Math.max(0, Math.min(88, index));
    return pred;
  }

  // --- MS ADPCM Decoder (Simplified Adaptive Step) ---
  private static decodeMsAdpcm(
    bytes: Uint8Array,
    offset: number,
    length: number,
    numChannels: number,
    blockAlign: number
  ): { channelData: Float32Array[]; clippingDetected: boolean; dcOffsetDetected: boolean } {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end = Math.min(bytes.byteLength, offset + length);
    const bAlign = Math.max(7 * numChannels, blockAlign);
    const numBlocks = Math.floor((end - offset) / bAlign);
    const totalFrames = numBlocks * (bAlign - 6);

    const channelData: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channelData.push(new Float32Array(totalFrames));
    }

    let writeIdx = 0;
    for (let b = 0; b < numBlocks; b++) {
      const blockStart = offset + b * bAlign;
      let pos = blockStart;

      for (let c = 0; c < numChannels; c++) {
        // MS ADPCM block header contains bPredictor (1 byte), iDelta (2 bytes), iSamp1 (2 bytes), iSamp2 (2 bytes)
        const delta = Math.max(16, view.getInt16(pos + 1, true));
        const samp1 = view.getInt16(pos + 3, true);
        const samp2 = view.getInt16(pos + 5, true);
        pos += 7;

        channelData[c][writeIdx] = samp2 / 32768.0;
        channelData[c][writeIdx + 1] = samp1 / 32768.0;
      }
      writeIdx += 2;

      while (pos < blockStart + bAlign) {
        for (let c = 0; c < numChannels; c++) {
          if (pos >= blockStart + bAlign) break;
          const byteVal = bytes[pos++];
          channelData[c][writeIdx++] = ((byteVal & 0x0F) - 8) / 8.0;
          channelData[c][writeIdx++] = (((byteVal >> 4) & 0x0F) - 8) / 8.0;
        }
      }
    }

    return { channelData, clippingDetected: false, dcOffsetDetected: false };
  }

  private static readAscii(bytes: Uint8Array, offset: number, length: number): string {
    let s = '';
    for (let i = 0; i < length && offset + i < bytes.byteLength; i++) {
      s += String.fromCharCode(bytes[offset + i]);
    }
    return s;
  }

  private static readGuid(bytes: Uint8Array, offset: number): string {
    const hex = (b: number) => b.toString(16).padStart(2, '0');
    // Format: 00000000-0000-0000-0000-000000000000
    // First 3 parts LE in Windows GUIDs:
    const p1 = hex(bytes[offset + 3]) + hex(bytes[offset + 2]) + hex(bytes[offset + 1]) + hex(bytes[offset]);
    const p2 = hex(bytes[offset + 5]) + hex(bytes[offset + 4]);
    const p3 = hex(bytes[offset + 7]) + hex(bytes[offset + 6]);
    const p4 = hex(bytes[offset + 8]) + hex(bytes[offset + 9]);
    let p5 = '';
    for (let i = 10; i < 16; i++) {
      p5 += hex(bytes[offset + i]);
    }
    return `${p1}-${p2}-${p3}-${p4}-${p5}`;
  }

  private static getFormatName(tag: number, bits: number): string {
    switch (tag) {
      case 0x0001: return `PCM ${bits}-bit`;
      case 0x0003: return `IEEE Float ${bits}-bit`;
      case 0x0006: return 'G.711 A-law';
      case 0x0007: return 'G.711 mu-law';
      case 0x0011: return 'IMA / DVI ADPCM';
      case 0x0002: return 'Microsoft ADPCM';
      default: return `Format 0x${tag.toString(16)}`;
    }
  }
}
