/**
 * AudioEditorLoader.ts
 * Dedicated import and export pipeline for the Audio Editor.
 * Decodes WAV and Raw PCM files directly with exact native sample rate preservation.
 * Exports multi-format WAV (8/16/24/32-bit int, 32-bit float) with optional TPDF dither.
 */

import { WavParser, type ParsedWav } from '../../audio/WavParser.ts';
import { RawAudioLoader, type RawPcmOptions } from '../../audio/RawAudioLoader.ts';
import { AudioBufferPool } from './AudioBufferPool.ts';
import { AudioPieceTable } from './AudioPieceTable.ts';

export interface ImportClipResult {
  table: AudioPieceTable;
  bufferId: string;
  fileName: string;
  sampleRate: number;
  numChannels: number;
  bitDepth: number;
  formatName: string;
}

export interface WavExportOptions {
  bitDepth?: 8 | 16 | 24 | 32;
  isFloat?: boolean;
  selection?: { startSample: number; lengthSamples: number };
  applyTpdfDither?: boolean;
}

export class AudioEditorLoader {
  /**
   * Import a file buffer (WAV or Raw PCM) directly into AudioBufferPool and AudioPieceTable.
   */
  public static importAudio(
    bytes: Uint8Array,
    fileName: string,
    pool: AudioBufferPool,
    rawOptions?: RawPcmOptions
  ): ImportClipResult {
    const isWav = fileName.toLowerCase().endsWith('.wav') || (
      bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // RIFF
      bytes[8] === 0x57 && bytes[9] === 0x41 && bytes[10] === 0x56 && bytes[11] === 0x45  // WAVE
    );

    if (isWav) {
      const parsed = WavParser.parse(bytes, fileName);
      const bufferId = pool.registerBuffer(
        parsed.channelData,
        parsed.sampleRate,
        parsed.bitsPerSample || 16,
        fileName
      );
      const table = AudioPieceTable.fromBuffer(
        bufferId,
        parsed.sampleRate,
        parsed.numChannels,
        parsed.totalSamplesPerChannel,
        parsed.bitsPerSample || 16
      );

      return {
        table,
        bufferId,
        fileName,
        sampleRate: parsed.sampleRate,
        numChannels: parsed.numChannels,
        bitDepth: parsed.bitsPerSample || 16,
        formatName: `WAV ${parsed.formatName}, ${parsed.sampleRate} Hz`
      };
    }

    // Raw PCM import
    const opts: RawPcmOptions = rawOptions || {
      sampleRate: 16000,
      numChannels: 1,
      bitDepth: 16
    };

    const channels = RawAudioLoader.decodeRawPcm(bytes, opts);
    const totalSamples = channels[0] ? channels[0].length : 0;
    const bufferId = pool.registerBuffer(channels, opts.sampleRate, opts.bitDepth, fileName);
    const table = AudioPieceTable.fromBuffer(
      bufferId,
      opts.sampleRate,
      opts.numChannels,
      totalSamples,
      opts.bitDepth
    );

    return {
      table,
      bufferId,
      fileName,
      sampleRate: opts.sampleRate,
      numChannels: opts.numChannels,
      bitDepth: opts.bitDepth,
      formatName: `Raw PCM ${opts.bitDepth}-bit (${opts.sampleRate} Hz, ${opts.numChannels} ch)`
    };
  }

  /**
   * Export an AudioPieceTable (whole clip or selection) to a RIFF WAV file buffer.
   */
  public static exportWav(
    table: AudioPieceTable,
    pool: AudioBufferPool,
    options?: WavExportOptions
  ): Uint8Array {
    const bitDepth = options?.bitDepth ?? (table.bitDepth === 32 ? 32 : table.bitDepth === 24 ? 24 : 16);
    const isFloat = options?.isFloat ?? (bitDepth === 32 && options?.bitDepth === 32 ? false : false);
    const sampleRate = table.sampleRate;
    const numChannels = table.numChannels;

    // Determine range to export
    let startSample = 0;
    let lengthSamples = table.totalSamples;

    if (options?.selection) {
      startSample = Math.max(0, Math.min(options.selection.startSample, table.totalSamples));
      lengthSamples = Math.min(options.selection.lengthSamples, table.totalSamples - startSample);
    }

    // Extract channels
    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(table.readSamples(startSample, lengthSamples, c, pool));
    }

    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = lengthSamples * blockAlign;

    // Format tag: 1 = PCM, 3 = IEEE Float
    const formatTag = isFloat ? 3 : 1;
    const headerSize = 44;
    const totalFileSize = headerSize + dataSize;

    const buffer = new ArrayBuffer(totalFileSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // RIFF header
    bytes[0] = 0x52; bytes[1] = 0x49; bytes[2] = 0x46; bytes[3] = 0x46; // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    bytes[8] = 0x57; bytes[9] = 0x41; bytes[10] = 0x56; bytes[11] = 0x45; // "WAVE"

    // "fmt " chunk
    bytes[12] = 0x66; bytes[13] = 0x6d; bytes[14] = 0x74; bytes[15] = 0x20;
    view.setUint32(16, 16, true);
    view.setUint16(20, formatTag, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitDepth, true);

    // "data" chunk
    bytes[36] = 0x64; bytes[37] = 0x61; bytes[38] = 0x74; bytes[39] = 0x61;
    view.setUint32(40, dataSize, true);

    const applyDither = options?.applyTpdfDither === true;
    let offset = 44;

    if (isFloat && bitDepth === 32) {
      for (let s = 0; s < lengthSamples; s++) {
        for (let c = 0; c < numChannels; c++) {
          view.setFloat32(offset, channels[c][s], true);
          offset += 4;
        }
      }
    } else if (bitDepth === 16) {
      for (let s = 0; s < lengthSamples; s++) {
        for (let c = 0; c < numChannels; c++) {
          let sample = channels[c][s];
          if (applyDither) {
            // TPDF dither: sum of two uniform random numbers [-0.5, 0.5) / 32768
            const dither = (Math.random() - Math.random()) / 32768.0;
            sample += dither;
          }
          const clamped = Math.max(-1.0, Math.min(1.0, sample));
          const intVal = Math.round(clamped * 32768.0);
          view.setInt16(offset, Math.max(-32768, Math.min(32767, intVal)), true);
          offset += 2;
        }
      }
    } else if (bitDepth === 24) {
      for (let s = 0; s < lengthSamples; s++) {
        for (let c = 0; c < numChannels; c++) {
          let sample = channels[c][s];
          if (applyDither) {
            const dither = (Math.random() - Math.random()) / 8388608.0;
            sample += dither;
          }
          const clamped = Math.max(-1.0, Math.min(1.0, sample));
          const intVal = Math.round(clamped * 8388608.0);
          const val = Math.max(-8388608, Math.min(8388607, intVal));
          bytes[offset] = val & 0xff;
          bytes[offset + 1] = (val >> 8) & 0xff;
          bytes[offset + 2] = (val >> 16) & 0xff;
          offset += 3;
        }
      }
    } else if (bitDepth === 8) {
      for (let s = 0; s < lengthSamples; s++) {
        for (let c = 0; c < numChannels; c++) {
          let sample = channels[c][s];
          if (applyDither) {
            const dither = (Math.random() - Math.random()) / 128.0;
            sample += dither;
          }
          const clamped = Math.max(-1.0, Math.min(1.0, sample));
          const uintVal = Math.round((clamped + 1.0) * 128.0);
          bytes[offset] = Math.max(0, Math.min(255, uintVal));
          offset += 1;
        }
      }
    } else if (bitDepth === 32) {
      for (let s = 0; s < lengthSamples; s++) {
        for (let c = 0; c < numChannels; c++) {
          const clamped = Math.max(-1.0, Math.min(1.0, channels[c][s]));
          const intVal = Math.round(clamped * 2147483648.0);
          view.setInt32(offset, Math.max(-2147483648, Math.min(2147483647, intVal)), true);
          offset += 4;
        }
      }
    }

    return bytes;
  }
}
