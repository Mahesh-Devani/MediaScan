/**
 * AudioPieceTable.ts
 * Non-destructive Piece Table (Edit List) for audio editing.
 * Represents audio as an ordered sequence of slices into immutable source buffers.
 * Cut/copy/paste/undo operations manipulate descriptors in O(pieces) time.
 */

import { AudioBufferPool } from './AudioBufferPool.ts';

export interface AudioPiece {
  bufferId: string;
  srcStartSample: number;
  lengthSamples: number;
}

export class AudioPieceTable {
  public readonly sampleRate: number;
  public readonly numChannels: number;
  public readonly bitDepth: number;
  private _pieces: AudioPiece[];

  constructor(
    sampleRate: number,
    numChannels: number,
    bitDepth: number = 16,
    pieces: AudioPiece[] = []
  ) {
    this.sampleRate = sampleRate;
    this.numChannels = numChannels;
    this.bitDepth = bitDepth;
    this._pieces = pieces.map(p => ({ ...p }));
  }

  /**
   * Create an AudioPieceTable from a registered source buffer.
   */
  public static fromBuffer(
    bufferId: string,
    sampleRate: number,
    numChannels: number,
    totalSamples: number,
    bitDepth: number = 16
  ): AudioPieceTable {
    const pieces: AudioPiece[] = totalSamples > 0 ? [{
      bufferId,
      srcStartSample: 0,
      lengthSamples: totalSamples
    }] : [];
    return new AudioPieceTable(sampleRate, numChannels, bitDepth, pieces);
  }

  public get pieces(): readonly AudioPiece[] {
    return this._pieces;
  }

  public get pieceCount(): number {
    return this._pieces.length;
  }

  public get totalSamples(): number {
    let sum = 0;
    for (let i = 0; i < this._pieces.length; i++) {
      sum += this._pieces[i].lengthSamples;
    }
    return sum;
  }

  public get durationSec(): number {
    return this.sampleRate > 0 ? this.totalSamples / this.sampleRate : 0;
  }

  public clone(): AudioPieceTable {
    return new AudioPieceTable(
      this.sampleRate,
      this.numChannels,
      this.bitDepth,
      this._pieces
    );
  }

  /**
   * Split the piece list at a specific sample offset so that a piece boundary exists at offset.
   * Modifies internal piece array in place.
   */
  public splitAt(offset: number): void {
    const clampedOffset = Math.max(0, Math.min(offset, this.totalSamples));
    if (clampedOffset === 0 || clampedOffset === this.totalSamples) {
      return;
    }

    let accumulated = 0;
    for (let i = 0; i < this._pieces.length; i++) {
      const piece = this._pieces[i];
      const pieceEnd = accumulated + piece.lengthSamples;

      if (clampedOffset > accumulated && clampedOffset < pieceEnd) {
        // Split piece into left and right
        const leftLen = clampedOffset - accumulated;
        const rightLen = piece.lengthSamples - leftLen;

        const leftPiece: AudioPiece = {
          bufferId: piece.bufferId,
          srcStartSample: piece.srcStartSample,
          lengthSamples: leftLen
        };
        const rightPiece: AudioPiece = {
          bufferId: piece.bufferId,
          srcStartSample: piece.srcStartSample + leftLen,
          lengthSamples: rightLen
        };

        this._pieces.splice(i, 1, leftPiece, rightPiece);
        return;
      }
      accumulated = pieceEnd;
    }
  }

  /**
   * Slice a range of samples into an array of piece descriptors without copying audio samples.
   */
  public slice(startSample: number, lengthSamples: number): AudioPiece[] {
    if (lengthSamples <= 0 || this._pieces.length === 0) {
      return [];
    }

    const start = Math.max(0, Math.min(startSample, this.totalSamples));
    const end = Math.min(start + lengthSamples, this.totalSamples);
    if (start >= end) return [];

    const result: AudioPiece[] = [];
    let accumulated = 0;

    for (let i = 0; i < this._pieces.length; i++) {
      const piece = this._pieces[i];
      const pieceStart = accumulated;
      const pieceEnd = accumulated + piece.lengthSamples;

      // Check if current piece intersects [start, end)
      if (pieceEnd > start && pieceStart < end) {
        const overlapStart = Math.max(start, pieceStart);
        const overlapEnd = Math.min(end, pieceEnd);
        const srcOffset = overlapStart - pieceStart;
        const len = overlapEnd - overlapStart;

        result.push({
          bufferId: piece.bufferId,
          srcStartSample: piece.srcStartSample + srcOffset,
          lengthSamples: len
        });
      }

      accumulated = pieceEnd;
      if (accumulated >= end) break;
    }

    return result;
  }

  /**
   * Insert pieces at sampleOffset. Returns a new AudioPieceTable.
   */
  public insert(sampleOffset: number, insertPieces: AudioPiece[]): AudioPieceTable {
    if (!insertPieces || insertPieces.length === 0) {
      return this.clone();
    }

    const cloned = this.clone();
    cloned.splitAt(sampleOffset);

    // Find insertion index
    let insertIdx = 0;
    let accumulated = 0;
    const clampedOffset = Math.max(0, Math.min(sampleOffset, cloned.totalSamples));

    for (let i = 0; i < cloned._pieces.length; i++) {
      if (accumulated === clampedOffset) {
        insertIdx = i;
        break;
      }
      accumulated += cloned._pieces[i].lengthSamples;
      if (accumulated === clampedOffset) {
        insertIdx = i + 1;
        break;
      }
    }

    if (clampedOffset >= cloned.totalSamples) {
      insertIdx = cloned._pieces.length;
    }

    const newPieces = cloned._pieces.slice();
    newPieces.splice(insertIdx, 0, ...insertPieces.map(p => ({ ...p })));
    return new AudioPieceTable(cloned.sampleRate, cloned.numChannels, cloned.bitDepth, newPieces);
  }

  /**
   * Delete a range of samples. Returns new AudioPieceTable and the deleted pieces.
   */
  public delete(startSample: number, lengthSamples: number): {
    table: AudioPieceTable;
    deleted: AudioPiece[];
  } {
    if (lengthSamples <= 0 || this._pieces.length === 0) {
      return { table: this.clone(), deleted: [] };
    }

    const start = Math.max(0, Math.min(startSample, this.totalSamples));
    const end = Math.min(start + lengthSamples, this.totalSamples);
    if (start >= end) {
      return { table: this.clone(), deleted: [] };
    }

    const deleted = this.slice(start, end - start);

    const cloned = this.clone();
    cloned.splitAt(start);
    cloned.splitAt(end);

    // Remove all pieces lying entirely between start and end
    const remaining: AudioPiece[] = [];
    let accumulated = 0;

    for (let i = 0; i < cloned._pieces.length; i++) {
      const piece = cloned._pieces[i];
      const pieceStart = accumulated;
      const pieceEnd = accumulated + piece.lengthSamples;

      if (pieceEnd <= start || pieceStart >= end) {
        remaining.push({ ...piece });
      }
      accumulated = pieceEnd;
    }

    return {
      table: new AudioPieceTable(cloned.sampleRate, cloned.numChannels, cloned.bitDepth, remaining),
      deleted
    };
  }

  /**
   * Read a continuous slice of samples for a specific channel into a Float32Array.
   */
  public readSamples(
    startSample: number,
    countSamples: number,
    channelIndex: number,
    pool: AudioBufferPool
  ): Float32Array {
    const out = new Float32Array(countSamples);
    if (countSamples <= 0 || this._pieces.length === 0) return out;

    const start = Math.max(0, Math.min(startSample, this.totalSamples));
    const end = Math.min(start + countSamples, this.totalSamples);
    if (start >= end) return out;

    let outIdx = 0;
    let accumulated = 0;

    for (let i = 0; i < this._pieces.length; i++) {
      const piece = this._pieces[i];
      const pieceStart = accumulated;
      const pieceEnd = accumulated + piece.lengthSamples;

      if (pieceEnd > start && pieceStart < end) {
        const overlapStart = Math.max(start, pieceStart);
        const overlapEnd = Math.min(end, pieceEnd);
        const srcOffset = piece.srcStartSample + (overlapStart - pieceStart);
        const copyLen = overlapEnd - overlapStart;

        const bufChannels = pool.getBuffer(piece.bufferId);
        if (bufChannels && bufChannels[channelIndex]) {
          const srcChannel = bufChannels[channelIndex];
          out.set(srcChannel.subarray(srcOffset, srcOffset + copyLen), outIdx);
        }
        outIdx += copyLen;
      }

      accumulated = pieceEnd;
      if (accumulated >= end) break;
    }

    return out;
  }

  /**
   * Flatten the entire piece table into contiguous Float32Array channel buffers.
   */
  public flatten(pool: AudioBufferPool): Float32Array[] {
    const total = this.totalSamples;
    const channels: Float32Array[] = [];

    for (let c = 0; c < this.numChannels; c++) {
      channels.push(this.readSamples(0, total, c, pool));
    }

    return channels;
  }
}
