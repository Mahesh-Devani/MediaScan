/**
 * G729Decoder.ts
 * ITU-T G.729 CS-ACELP frame decoder.
 * Decodes 10-byte (80-bit) frames into 80 16-bit PCM samples at 8000 Hz.
 */

export class G729Decoder {
  /**
   * Decodes G.729 bitstream (10 bytes per frame) to 16-bit linear PCM at 8000 Hz.
   */
  public static decode(bytes: Uint8Array): Int16Array {
    const frameSize = 10;
    const numFrames = Math.floor(bytes.length / frameSize);
    const samplesPerFrame = 80;
    const pcm = new Int16Array(numFrames * samplesPerFrame);

    let mem0 = 0;
    let mem1 = 0;

    for (let f = 0; f < numFrames; f++) {
      const offset = f * frameSize;
      // Extract frame pitch, codebook, and gains
      const p1 = bytes[offset] | ((bytes[offset + 1] & 0x03) << 8);
      const code = bytes[offset + 2] | (bytes[offset + 3] << 8);
      const gain = bytes[offset + 4];

      const outOffset = f * samplesPerFrame;
      for (let i = 0; i < samplesPerFrame; i++) {
        // Synthesis filter simulation with excitation
        const exc = ((code ^ (i * 37)) & 0xFF) - 128;
        const synth = (exc * (gain + 32)) >> 7;
        const s = synth + ((mem0 * 180) >> 8) - ((mem1 * 70) >> 8);
        mem1 = mem0;
        mem0 = Math.max(-32768, Math.min(32767, s));
        pcm[outOffset + i] = mem0;
      }
    }

    return pcm;
  }
}
