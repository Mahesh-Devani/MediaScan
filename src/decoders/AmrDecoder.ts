/**
 * AMR-NB and AMR-WB audio decoder wrapper.
 * Uses OpenCORE-AMR (compiled to WASM) to decode standard 3GPP AMR files
 * and depacketized RFC 4867 RTP streams into 16-bit linear PCM.
 */
import decodeAmrWasm from '@audio/decode-amr';
import { AmrDepacketizer } from './AmrDepacketizer.ts';

export class AmrDecoder {
  /**
   * Decode a complete 3GPP AMR file (starting with #!AMR\n or #!AMR-WB\n) to 16-bit PCM.
   */
  public static async decodeAmrFile(
    amrBytes: Uint8Array
  ): Promise<{ pcm: Int16Array; sampleRate: number }> {
    const audioData = await decodeAmrWasm(amrBytes);
    const float32 = audioData.channelData[0] || new Float32Array(0);
    const pcm = new Int16Array(float32.length);

    // Convert Float32Array (-1.0 to 1.0) to 16-bit signed PCM integers
    for (let i = 0; i < float32.length; i++) {
      pcm[i] = Math.max(-32768, Math.min(32767, Math.round(float32[i] * 32768)));
    }

    return {
      pcm,
      sampleRate: audioData.sampleRate,
    };
  }

  /**
   * Depacketize and decode a sequence of RTP payloads to 16-bit PCM.
   */
  public static async decodeRtpPayloads(
    payloads: Uint8Array[],
    isWideband: boolean,
    octetAligned: boolean = false
  ): Promise<{ pcm: Int16Array; sampleRate: number }> {
    const amrContainer = AmrDepacketizer.depacketize(payloads, isWideband, octetAligned);
    return AmrDecoder.decodeAmrFile(amrContainer);
  }
}
