/**
 * EvsEncoder.ts
 * 3GPP TS 26.445 Enhanced Voice Services (EVS) Audio Encoder wrapper.
 * Encodes linear 16-bit PCM into standard EVS primary bitstreams and AMR-WB IO modes
 * using the official 3GPP reference codec compiled to WebAssembly.
 */

import { EvsDecoder } from '../decoders/EvsDecoder.ts';
import type { AudioBandwidth } from '../codec/CodecProfileRegistry.ts';

export interface EvsEncodeOptions {
  bitrateBps: number;
  bandwidth: AudioBandwidth;
  sampleRate: number; // 8000, 16000, 32000, 48000
  dtx: boolean;
  isAmrWbIo?: boolean;
}

export interface EncodedEvsFrame {
  tocByte: number;
  payload: Uint8Array;
  isDtx: boolean;
  frameType: 'speech' | 'sid' | 'nodata';
}

export class EvsEncoder {
  /**
   * Encodes PCM audio into discrete EVS container frames.
   */
  public static async encode(
    pcm: Int16Array | Float32Array,
    options: EvsEncodeOptions
  ): Promise<Uint8Array[]> {
    const instance = await EvsDecoder.getInstance();
    const exp = instance.exports as any;

    const sampleRate = options.sampleRate;
    const bitrate = options.bitrateBps;
    const bwCode = options.bandwidth === 'NB' ? 0 : options.bandwidth === 'WB' ? 1 : options.bandwidth === 'SWB' ? 2 : 3;
    const dtxFlag = options.dtx ? 1 : 0;
    const ioFlag = options.isAmrWbIo ? 1 : 0;

    const enc = exp.evs_encoder_create(sampleRate, bitrate, bwCode, dtxFlag, 0, ioFlag);
    if (!enc) {
      throw new Error(`Failed to create EVS encoder for sampleRate=${sampleRate}, bitrate=${bitrate}`);
    }

    try {
      const pcmPtr = exp.evs_encoder_pcm_ptr(enc);
      const outPtr = exp.evs_encoder_output_ptr(enc);
      const frameSamples = exp.evs_encoder_frame_samples(enc);

      // Convert float to int16 if needed
      const in16 = pcm instanceof Int16Array ? pcm : new Int16Array(pcm.length);
      if (!(pcm instanceof Int16Array)) {
        for (let i = 0; i < pcm.length; i++) {
          let s = Math.round(pcm[i] * 32767);
          if (s > 32767) s = 32767;
          else if (s < -32768) s = -32768;
          in16[i] = s;
        }
      }

      const numFrames = Math.ceil(in16.length / frameSamples);
      const frames: Uint8Array[] = [];

      for (let f = 0; f < numFrames; f++) {
        const offset = f * frameSamples;
        const pcmMem = new Int16Array(exp.memory.buffer, pcmPtr, frameSamples);

        const available = Math.min(frameSamples, in16.length - offset);
        if (available > 0) {
          pcmMem.set(in16.subarray(offset, offset + available));
        }
        if (available < frameSamples) {
          pcmMem.fill(0, available); // Zero-pad last frame
        }

        exp.evs_encoder_encode(enc);
        const result = BigInt(exp.evs_encoder_result(enc));

        // Result: high 32 bits = byte count, low 32 bits = ToC / metadata
        const byteCount = Number(result >> 32n);
        const meta = Number(result & 0xffffffffn);
        const tocByte = options.isAmrWbIo ? (0x30 | (meta & 0x0f)) : (meta & 0x0f);

        // In reference container format: [1-byte ToC, payloadBytes...]
        if (byteCount > 0) {
          const frameBuffer = new Uint8Array(1 + byteCount);
          frameBuffer[0] = tocByte;
          const payload = new Uint8Array(exp.memory.buffer, outPtr, byteCount);
          frameBuffer.set(payload, 1);
          frames.push(frameBuffer);
        } else {
          // NO_DATA frame (1-byte ToC only)
          frames.push(new Uint8Array([tocByte]));
        }
      }

      return frames;
    } finally {
      exp.evs_encoder_destroy(enc);
    }
  }
}
