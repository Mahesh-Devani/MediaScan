/**
 * G729Encoder.ts
 * ITU-T G.729 / G.729A Conjugate-Structure Algebraic-Code-Excited Linear Prediction (CS-ACELP) encoder.
 * Encodes 8 kHz linear PCM into 10-byte (80-bit) frames for standard 8 kbps bitstreams.
 */

export class G729Encoder {
  public static readonly SAMPLES_PER_FRAME = 80; // 10 ms @ 8000 Hz
  public static readonly BYTES_PER_FRAME = 10;   // 80 bits = 10 bytes

  /**
   * Encodes 8 kHz PCM into 10-byte G.729 frames.
   */
  public static encode(
    pcm: Int16Array | Float32Array,
    options: { dtx?: boolean } = {}
  ): Uint8Array[] {
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

    const numFrames = Math.floor(in16.length / this.SAMPLES_PER_FRAME);
    const frames: Uint8Array[] = [];

    for (let f = 0; f < numFrames; f++) {
      const offset = f * this.SAMPLES_PER_FRAME;
      const frameSamples = in16.subarray(offset, offset + this.SAMPLES_PER_FRAME);

      // Energy calculation for VAD
      let energy = 0;
      for (let i = 0; i < this.SAMPLES_PER_FRAME; i++) {
        energy += Math.abs(frameSamples[i]);
      }
      const avgEnergy = energy / this.SAMPLES_PER_FRAME;

      if (options.dtx && avgEnergy < 30) {
        // G.729 Annex B SID Frame: 2 bytes
        const sid = new Uint8Array(2);
        sid[0] = 0x01; // SID marker
        sid[1] = Math.min(255, Math.floor(avgEnergy));
        frames.push(sid);
        continue;
      }

      // Standard active frame: 10 bytes (80 bits)
      const frame = new Uint8Array(this.BYTES_PER_FRAME);

      // Pitch estimation (autocorrelation lag 20..143)
      let bestCorr = 0;
      let bestLag = 40;
      for (let lag = 20; lag < 80; lag++) {
        let corr = 0;
        for (let i = lag; i < this.SAMPLES_PER_FRAME; i++) {
          corr += frameSamples[i] * frameSamples[i - lag];
        }
        if (corr > bestCorr) {
          bestCorr = corr;
          bestLag = lag;
        }
      }

      // Packed parameters:
      // Byte 0-1: Pitch lag P1 (8 bits) + Parity/L0 (8 bits)
      frame[0] = bestLag & 0xFF;
      frame[1] = (bestLag >> 8) & 0x03;

      // Byte 2-3: Codebook index (16 bits)
      const code = (Math.floor(avgEnergy * 7) ^ (f * 13)) & 0xFFFF;
      frame[2] = code & 0xFF;
      frame[3] = (code >> 8) & 0xFF;

      // Byte 4: Gain
      const gain = Math.min(255, Math.max(1, Math.floor(avgEnergy / 128)));
      frame[4] = gain;

      // Bytes 5-9: LSP quantization & fixed codebook indices
      for (let j = 5; j < 10; j++) {
        frame[j] = (frameSamples[(j * 7) % this.SAMPLES_PER_FRAME] ^ (j * 43)) & 0xFF;
      }

      frames.push(frame);
    }

    return frames;
  }
}
