/**
 * AudioBufferPool.ts
 * Manages immutable source audio buffers for the Audio Editor Piece Table.
 * Buffers are stored in memory as Float32Array per channel and never modified in place.
 */

export interface SourceBufferMeta {
  bufferId: string;
  fileName: string;
  sampleRate: number;
  numChannels: number;
  bitDepth: number; // 8, 16, 24, 32
  totalSamples: number;
  durationSec: number;
  createdAt: number;
}

export class AudioBufferPool {
  private static instanceCounter = 0;
  private readonly buffers = new Map<string, Float32Array[]>();
  private readonly meta = new Map<string, SourceBufferMeta>();

  /**
   * Register a new immutable audio buffer into the pool.
   * Returns a unique buffer ID.
   */
  public registerBuffer(
    channelData: Float32Array[],
    sampleRate: number,
    bitDepth: number = 16,
    fileName: string = 'audio'
  ): string {
    if (!channelData || channelData.length === 0) {
      throw new Error('Cannot register empty channel data in AudioBufferPool');
    }
    const numChannels = channelData.length;
    const totalSamples = channelData[0].length;

    const bufferId = `buf-${Date.now()}-${++AudioBufferPool.instanceCounter}`;
    this.buffers.set(bufferId, channelData);
    this.meta.set(bufferId, {
      bufferId,
      fileName,
      sampleRate,
      numChannels,
      bitDepth,
      totalSamples,
      durationSec: sampleRate > 0 ? totalSamples / sampleRate : 0,
      createdAt: Date.now()
    });

    return bufferId;
  }

  /**
   * Retrieve channel data for a registered buffer.
   */
  public getBuffer(bufferId: string): Float32Array[] | undefined {
    return this.buffers.get(bufferId);
  }

  /**
   * Retrieve metadata for a registered buffer.
   */
  public getMetadata(bufferId: string): SourceBufferMeta | undefined {
    return this.meta.get(bufferId);
  }

  /**
   * Delete a buffer from the pool to release memory.
   */
  public releaseBuffer(bufferId: string): boolean {
    this.meta.delete(bufferId);
    return this.buffers.delete(bufferId);
  }

  /**
   * Calculate total memory consumed by registered audio buffers in bytes.
   */
  public getTotalMemoryBytes(): number {
    let totalBytes = 0;
    for (const channels of this.buffers.values()) {
      for (const ch of channels) {
        totalBytes += ch.byteLength;
      }
    }
    return totalBytes;
  }

  /**
   * Clear all buffers from the pool.
   */
  public clear(): void {
    this.buffers.clear();
    this.meta.clear();
  }
}
