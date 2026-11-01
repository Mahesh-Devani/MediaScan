/**
 * Deduplicator replicates Wireshark editcap -D <window_size>
 * Drops duplicate packets seen within the last `windowSize` packets.
 */
export class Deduplicator {
  private windowSize: number;
  private ring: number[];
  private set: Set<number>;
  private head: number = 0;

  constructor(windowSize: number = 1500) {
    this.windowSize = windowSize;
    this.ring = new Array(windowSize);
    this.set = new Set<number>();
  }

  /**
   * Fast 32-bit FNV-1a hash over packet payload.
   */
  private static hashPacket(data: Uint8Array): number {
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) {
      hash ^= data[i];
      hash = Math.imul(hash, 0x01000193);
    }
    return hash >>> 0;
  }

  /**
   * Checks whether the packet is a duplicate within the sliding window.
   * If not, inserts it into the window.
   */
  public isDuplicate(data: Uint8Array): boolean {
    const hash = Deduplicator.hashPacket(data);
    if (this.set.has(hash)) {
      return true;
    }

    // Evict old entry at ring[head] if window is full
    if (this.ring[this.head] !== undefined) {
      this.set.delete(this.ring[this.head]);
    }

    this.ring[this.head] = hash;
    this.set.add(hash);
    this.head = (this.head + 1) % this.windowSize;

    return false;
  }

  public reset(): void {
    this.ring = new Array(this.windowSize);
    this.set.clear();
    this.head = 0;
  }
}
