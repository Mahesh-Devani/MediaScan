/**
 * WebCodecs / Web Audio Opus Decoder with feature detection.
 */
export class OpusDecoder {
  public static isSupported(): boolean {
    return typeof (globalThis as any).AudioDecoder !== 'undefined';
  }

  /**
   * Decode Opus RTP packets using WebCodecs AudioDecoder when available.
   */
  public static async decodePackets(
    packets: Array<{ timestamp: number; payload: Uint8Array }>,
    sampleRate: number = 48000,
    channels: number = 1
  ): Promise<Float32Array> {
    if (!OpusDecoder.isSupported()) {
      throw new Error('WebCodecs AudioDecoder is not supported in this environment.');
    }

    const decodedChunks: Float32Array[] = [];

    const decoder = new (globalThis as any).AudioDecoder({
      output: (audioData: any) => {
        const floatData = new Float32Array(audioData.numberOfFrames);
        audioData.copyTo(floatData, { planeIndex: 0 });
        decodedChunks.push(floatData);
        audioData.close();
      },
      error: (e: any) => {
        console.error('Opus decoding error:', e);
      },
    });

    decoder.configure({
      codec: 'opus',
      sampleRate,
      numberOfChannels: channels,
    });

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      const chunk = new (globalThis as any).EncodedAudioChunk({
        type: 'key',
        timestamp: Math.round(pkt.timestamp * (1e6 / sampleRate)), // microseconds
        data: pkt.payload,
      });
      decoder.decode(chunk);
    }

    await decoder.flush();
    decoder.close();

    // Concatenate chunks
    const totalFrames = decodedChunks.reduce((acc, c) => acc + c.length, 0);
    const result = new Float32Array(totalFrames);
    let offset = 0;
    for (const chunk of decodedChunks) {
      result.set(chunk, offset);
      offset += chunk.length;
    }

    return result;
  }
}
