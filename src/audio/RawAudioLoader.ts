/**
 * RawAudioLoader.ts
 * Decodes raw codec-encoded streams, containerized audio (WebCodecs/WebAudio),
 * and user-parameterized raw PCM into multi-channel Float32Array buffers.
 */

import { G711Decoder } from '../decoders/G711Decoder.ts';
import { G722Decoder } from '../decoders/G722Decoder.ts';
import { G726Decoder } from '../decoders/G726Decoder.ts';
import { G729Decoder } from '../decoders/G729Decoder.ts';
import { AmrDecoder } from '../decoders/AmrDecoder.ts';
import { OpusDecoder } from '../decoders/OpusDecoder.ts';

export interface RawPcmOptions {
  sampleRate: number;
  numChannels: number;
  bitDepth: 8 | 16 | 24 | 32;
  isFloat?: boolean;
  isBigEndian?: boolean;
  isUnsigned?: boolean;
}

export interface LoadedAudio {
  fileName: string;
  codec: string;
  formatName: string;
  sampleRate: number;
  numChannels: number;
  channelData: Float32Array[];
  durationSec: number;
  isContainerDecoded: boolean;
  requiresLazyFallback?: boolean;
  lazyFallbackReason?: string;
}

export type SupportedRawCodec =
  | 'auto'
  | 'pcm'
  | 'g711u'
  | 'g711a'
  | 'g722'
  | 'g726'
  | 'g729'
  | 'amr-nb'
  | 'amr-wb'
  | 'opus'
  | 'ilbc'
  | 'speex'
  | 'container';

export class RawAudioLoader {
  /**
   * Auto-detect codec from extension and magic bytes.
   */
  public static detectCodec(bytes: Uint8Array, fileName: string): SupportedRawCodec {
    const ext = fileName.toLowerCase().split('.').pop() || '';

    // Magic Byte checks
    if (bytes.length >= 6) {
      // #!AMR\n
      if (bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41 && bytes[3] === 0x4d && bytes[4] === 0x52 && bytes[5] === 0x0a) {
        return 'amr-nb';
      }
    }
    if (bytes.length >= 9) {
      // #!AMR-WB\n
      if (bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x41 && bytes[3] === 0x4d && bytes[4] === 0x52 && bytes[5] === 0x2d && bytes[6] === 0x57 && bytes[7] === 0x42 && bytes[8] === 0x0a) {
        return 'amr-wb';
      }
    }
    if (bytes.length >= 4) {
      // OggS
      if (bytes[0] === 0x4f && bytes[1] === 0x67 && bytes[2] === 0x67 && bytes[3] === 0x53) {
        return 'opus';
      }
      // fLaC
      if (bytes[0] === 0x66 && bytes[1] === 0x4c && bytes[2] === 0x61 && bytes[3] === 0x43) {
        return 'container';
      }
      // ID3 or MP3 sync
      if ((bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) {
        return 'container';
      }
    }

    // Extension mappings
    switch (ext) {
      case 'ulaw':
      case 'mulaw':
      case 'mu':
        return 'g711u';
      case 'alaw':
      case 'al':
        return 'g711a';
      case 'g722':
        return 'g722';
      case 'g726':
        return 'g726';
      case 'g729':
      case 'g729a':
        return 'g729';
      case 'amr':
        return 'amr-nb';
      case 'amrwb':
      case 'awb':
        return 'amr-wb';
      case 'opus':
      case 'ogg':
        return 'opus';
      case 'ilbc':
        return 'ilbc';
      case 'spx':
      case 'speex':
        return 'speex';
      case 'mp3':
      case 'm4a':
      case 'aac':
      case 'flac':
      case 'webm':
        return 'container';
      case 'raw':
      case 'pcm':
        return 'pcm';
      default:
        return 'auto';
    }
  }

  /**
   * Load and decode an audio stream buffer into normalized multi-channel Float32Array.
   */
  public static async load(
    buffer: ArrayBuffer | Uint8Array,
    fileName: string,
    forcedCodec: SupportedRawCodec = 'auto',
    pcmOptions?: RawPcmOptions
  ): Promise<LoadedAudio> {
    const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
    const codec = forcedCodec === 'auto' ? this.detectCodec(bytes, fileName) : forcedCodec;

    // Check for Tier 3 lazy fallback codecs
    if (codec === 'ilbc') {
      return {
        fileName,
        codec: 'iLBC',
        formatName: 'iLBC (RFC 3951/3952)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [new Float32Array(0)],
        durationSec: 0,
        isContainerDecoded: false,
        requiresLazyFallback: true,
        lazyFallbackReason: 'iLBC requires optional ffmpeg.wasm fallback module (~28 MB).',
      };
    }
    if (codec === 'speex') {
      return {
        fileName,
        codec: 'Speex',
        formatName: 'Speex CELP (RFC 5574)',
        sampleRate: 16000,
        numChannels: 1,
        channelData: [new Float32Array(0)],
        durationSec: 0,
        isContainerDecoded: false,
        requiresLazyFallback: true,
        lazyFallbackReason: 'Speex requires optional ffmpeg.wasm fallback module (~28 MB).',
      };
    }

    // 1. Direct Built-in Decoders
    if (codec === 'g711u') {
      const pcm16 = G711Decoder.decodeUlaw(bytes);
      const floatData = this.pcm16ToFloat(pcm16);
      return {
        fileName,
        codec: 'PCMU',
        formatName: 'G.711 mu-law (8 kHz mono)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 8000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'g711a') {
      const pcm16 = G711Decoder.decodeAlaw(bytes);
      const floatData = this.pcm16ToFloat(pcm16);
      return {
        fileName,
        codec: 'PCMA',
        formatName: 'G.711 A-law (8 kHz mono)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 8000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'g722') {
      const pcm16 = G722Decoder.decodeG722(bytes);
      const floatData = this.pcm16ToFloat(pcm16);
      return {
        fileName,
        codec: 'G722',
        formatName: 'ITU-T G.722 SB-ADPCM (16 kHz mono)',
        sampleRate: 16000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 16000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'g726') {
      const pcm16 = G726Decoder.decode32(bytes);
      const floatData = this.pcm16ToFloat(pcm16);
      return {
        fileName,
        codec: 'G726',
        formatName: 'ITU-T G.726 32kbps ADPCM (8 kHz mono)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 8000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'g729') {
      const pcm16 = G729Decoder.decode(bytes);
      const floatData = this.pcm16ToFloat(pcm16);
      return {
        fileName,
        codec: 'G729',
        formatName: 'ITU-T G.729 CS-ACELP (8 kHz mono)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 8000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'amr-nb') {
      // Ensure AMR magic header if missing
      let amrBytes = bytes;
      if (bytes.length >= 6 && bytes[0] !== 0x23) {
        const header = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a]); // #!AMR\n
        const combined = new Uint8Array(header.length + bytes.length);
        combined.set(header, 0);
        combined.set(bytes, header.length);
        amrBytes = combined;
      }
      const decoded = await AmrDecoder.decodeAmrFile(amrBytes);
      const floatData = this.pcm16ToFloat(decoded.pcm);
      return {
        fileName,
        codec: 'AMR',
        formatName: '3GPP AMR-NB (8 kHz mono)',
        sampleRate: 8000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 8000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'amr-wb') {
      let amrBytes = bytes;
      if (bytes.length >= 9 && bytes[0] !== 0x23) {
        const header = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a]); // #!AMR-WB\n
        const combined = new Uint8Array(header.length + bytes.length);
        combined.set(header, 0);
        combined.set(bytes, header.length);
        amrBytes = combined;
      }
      const decoded = await AmrDecoder.decodeAmrFile(amrBytes);
      const floatData = this.pcm16ToFloat(decoded.pcm);
      return {
        fileName,
        codec: 'AMR-WB',
        formatName: '3GPP AMR-WB (16 kHz mono)',
        sampleRate: 16000,
        numChannels: 1,
        channelData: [floatData],
        durationSec: floatData.length / 16000,
        isContainerDecoded: false,
      };
    }

    if (codec === 'pcm') {
      const opts = pcmOptions || {
        sampleRate: 16000,
        numChannels: 1,
        bitDepth: 16,
      };
      const channels = this.decodeRawPcm(bytes, opts);
      const durationSec = channels[0] ? channels[0].length / opts.sampleRate : 0;
      return {
        fileName,
        codec: 'PCM',
        formatName: `Raw PCM ${opts.bitDepth}-bit (${opts.sampleRate} Hz, ${opts.numChannels} ch)`,
        sampleRate: opts.sampleRate,
        numChannels: opts.numChannels,
        channelData: channels,
        durationSec,
        isContainerDecoded: false,
      };
    }

    // 2. Browser Native WebCodecs / Web Audio Container Decoding
    return this.decodeViaWebAudio(bytes, fileName);
  }

  /**
   * Browser Web Audio decodeAudioData fallback for containerized files (MP3, AAC, FLAC, OGG).
   */
  private static async decodeViaWebAudio(bytes: Uint8Array, fileName: string): Promise<LoadedAudio> {
    const isBrowser = typeof window !== 'undefined' && typeof window.AudioContext !== 'undefined';
    if (!isBrowser) {
      throw new Error(`Browser AudioContext is required to decode containerized audio '${fileName}'.`);
    }

    const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    try {
      const copy = new Uint8Array(bytes.length);
      copy.set(bytes);
      const audioBuffer = await audioCtx.decodeAudioData(copy.buffer);
      const numChannels = audioBuffer.numberOfChannels;
      const sampleRate = audioBuffer.sampleRate;
      const channelData: Float32Array[] = [];

      for (let c = 0; c < numChannels; c++) {
        channelData.push(new Float32Array(audioBuffer.getChannelData(c)));
      }

      return {
        fileName,
        codec: 'Container',
        formatName: `Container Decode (${Math.round(sampleRate)} Hz, ${numChannels} ch, best-effort)`,
        sampleRate,
        numChannels,
        channelData,
        durationSec: audioBuffer.duration,
        isContainerDecoded: true,
      };
    } finally {
      audioCtx.close().catch(() => {});
    }
  }

  /**
   * Decodes user-parameterized raw PCM buffer into multi-channel Float32Array buffers.
   */
  public static decodeRawPcm(bytes: Uint8Array, opts: RawPcmOptions): Float32Array[] {
    const { sampleRate, numChannels, bitDepth, isFloat, isBigEndian, isUnsigned } = opts;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const bytesPerSample = bitDepth / 8;
    const frameSize = numChannels * bytesPerSample;
    const numFrames = Math.floor(bytes.byteLength / frameSize);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) {
      channels.push(new Float32Array(numFrames));
    }

    let pos = 0;
    const le = !isBigEndian;

    if (bitDepth === 8) {
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          const raw = bytes[pos++];
          channels[c][f] = isUnsigned !== false ? (raw - 128) / 128.0 : view.getInt8(pos - 1) / 128.0;
        }
      }
    } else if (bitDepth === 16) {
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          channels[c][f] = view.getInt16(pos, le) / 32768.0;
          pos += 2;
        }
      }
    } else if (bitDepth === 24) {
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          let val: number;
          if (le) {
            val = bytes[pos] | (bytes[pos + 1] << 8) | (bytes[pos + 2] << 16);
          } else {
            val = (bytes[pos] << 16) | (bytes[pos + 1] << 8) | bytes[pos + 2];
          }
          if (val & 0x800000) val |= ~0xFFFFFF;
          channels[c][f] = val / 8388608.0;
          pos += 3;
        }
      }
    } else if (bitDepth === 32) {
      for (let f = 0; f < numFrames; f++) {
        for (let c = 0; c < numChannels; c++) {
          channels[c][f] = isFloat ? view.getFloat32(pos, le) : view.getInt32(pos, le) / 2147483648.0;
          pos += 4;
        }
      }
    }

    return channels;
  }

  private static pcm16ToFloat(pcm: Int16Array): Float32Array {
    const float = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) {
      float[i] = pcm[i] / 32768.0;
    }
    return float;
  }
}
