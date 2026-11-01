/**
 * Client-side 16-bit linear PCM RIFF WAV builder and exporter.
 */
export class WavExporter {
  public static encodeWav(channels: Int16Array[], sampleRate: number = 8000, bitsPerSample: number = 16): Uint8Array {
    const numChannels = channels.length;
    const numSamples = Math.max(...channels.map(c => c.length));
    const bytesPerSample = bitsPerSample / 8;
    const blockAlign = numChannels * bytesPerSample;
    const byteRate = sampleRate * blockAlign;
    const dataSize = numSamples * blockAlign;

    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);

    // RIFF chunk descriptor
    bytes[0] = 0x52; bytes[1] = 0x49; bytes[2] = 0x46; bytes[3] = 0x46; // "RIFF"
    view.setUint32(4, 36 + dataSize, true);
    bytes[8] = 0x57; bytes[9] = 0x41; bytes[10] = 0x56; bytes[11] = 0x45; // "WAVE"

    // fmt subchunk
    bytes[12] = 0x66; bytes[13] = 0x6d; bytes[14] = 0x74; bytes[15] = 0x20; // "fmt "
    view.setUint32(16, 16, true); // Subchunk1Size (16 for PCM)
    view.setUint16(20, 1, true);  // AudioFormat (1 = PCM)
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);

    // data subchunk
    bytes[36] = 0x64; bytes[37] = 0x61; bytes[38] = 0x74; bytes[39] = 0x61; // "data"
    view.setUint32(40, dataSize, true);

    // Interleave samples
    let offset = 44;
    for (let s = 0; s < numSamples; s++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const val = s < channels[ch].length ? channels[ch][s] : 0;
        view.setInt16(offset, val, true);
        offset += 2;
      }
    }

    return bytes;
  }

  /**
   * Encodes caller (left channel) and callee (right channel) into a synchronized stereo WAV file.
   */
  public static encodeStereoWav(left: Int16Array, right: Int16Array, sampleRate: number = 8000): Uint8Array {
    return WavExporter.encodeWav([left, right], sampleRate, 16);
  }
}
