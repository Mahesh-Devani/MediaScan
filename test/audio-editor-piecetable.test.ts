/**
 * test/audio-editor-piecetable.test.ts
 * Unit tests and randomized fuzz testing for the AudioPieceTable non-destructive edit list.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioBufferPool } from '../src/clipstudio/editor/AudioBufferPool.ts';
import { AudioPieceTable, type AudioPiece } from '../src/clipstudio/editor/AudioPieceTable.ts';

describe('AudioPieceTable Non-Destructive Edit List', () => {

  function createTestChannel(numSamples: number, startVal: number = 0): Float32Array {
    const ch = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      ch[i] = (startVal + i) / 10000.0;
    }
    return ch;
  }

  it('initializes from an AudioBufferPool buffer', () => {
    const pool = new AudioBufferPool();
    const ch0 = createTestChannel(16000);
    const bufId = pool.registerBuffer([ch0], 16000, 16, 'clip1.wav');

    const table = AudioPieceTable.fromBuffer(bufId, 16000, 1, 16000, 16);

    assert.equal(table.sampleRate, 16000);
    assert.equal(table.numChannels, 1);
    assert.equal(table.totalSamples, 16000);
    assert.equal(table.durationSec, 1.0);
    assert.equal(table.pieceCount, 1);

    const flattened = table.flatten(pool);
    assert.equal(flattened[0].length, 16000);
    assert.deepEqual(flattened[0], ch0);
  });

  it('correctly splits pieces at sample offsets without mutating audio data', () => {
    const pool = new AudioBufferPool();
    const ch0 = createTestChannel(1000);
    const bufId = pool.registerBuffer([ch0], 16000, 16);

    const table = AudioPieceTable.fromBuffer(bufId, 16000, 1, 1000);
    table.splitAt(400);

    assert.equal(table.pieceCount, 2);
    assert.equal(table.pieces[0].lengthSamples, 400);
    assert.equal(table.pieces[1].lengthSamples, 600);
    assert.equal(table.totalSamples, 1000);

    const flattened = table.flatten(pool);
    assert.deepEqual(flattened[0], ch0);
  });

  it('deletes ranges across piece boundaries and returns deleted pieces', () => {
    const pool = new AudioBufferPool();
    const ch0 = createTestChannel(1000);
    const bufId = pool.registerBuffer([ch0], 16000, 16);

    const table = AudioPieceTable.fromBuffer(bufId, 16000, 1, 1000);

    // Delete [200, 700) (length 500)
    const { table: deletedTable, deleted } = table.delete(200, 500);

    assert.equal(deletedTable.totalSamples, 500);
    assert.equal(deleted.reduce((sum, p) => sum + p.lengthSamples, 0), 500);

    const flat = deletedTable.flatten(pool)[0];
    assert.equal(flat.length, 500);

    // Samples [0..199] match ch0[0..199], samples [200..499] match ch0[700..999]
    for (let i = 0; i < 200; i++) {
      assert.equal(flat[i], ch0[i]);
    }
    for (let i = 200; i < 500; i++) {
      assert.equal(flat[i], ch0[i + 500]);
    }
  });

  it('inserts pieces at arbitrary sample offsets', () => {
    const pool = new AudioBufferPool();
    const chA = createTestChannel(500, 1000);
    const chB = createTestChannel(300, 9000);
    const bufA = pool.registerBuffer([chA], 16000, 16);
    const bufB = pool.registerBuffer([chB], 16000, 16);

    const tableA = AudioPieceTable.fromBuffer(bufA, 16000, 1, 500);
    const piecesB = AudioPieceTable.fromBuffer(bufB, 16000, 1, 300).slice(0, 300);

    // Insert B at offset 200 into A
    const result = tableA.insert(200, piecesB);
    assert.equal(result.totalSamples, 800);

    const flat = result.flatten(pool)[0];
    assert.equal(flat.length, 800);

    // [0..199] from A
    for (let i = 0; i < 200; i++) assert.equal(flat[i], chA[i]);
    // [200..499] from B
    for (let i = 0; i < 300; i++) assert.equal(flat[200 + i], chB[i]);
    // [500..799] from A
    for (let i = 0; i < 300; i++) assert.equal(flat[500 + i], chA[200 + i]);
  });

  it('fuzz testing: 500 random cut/copy/paste/delete operations match naive array implementation', () => {
    const pool = new AudioBufferPool();

    // Reference naive array implementation
    let refArray: number[] = [];
    const initialSamples = 2000;
    const initialChannel = new Float32Array(initialSamples);
    for (let i = 0; i < initialSamples; i++) {
      const v = Math.sin(i * 0.1);
      initialChannel[i] = v;
      refArray.push(v);
    }

    const initBuf = pool.registerBuffer([initialChannel], 16000, 16, 'init');
    let table = AudioPieceTable.fromBuffer(initBuf, 16000, 1, initialSamples);

    let clipboardPieces: AudioPiece[] = [];
    let refClipboard: number[] = [];

    // Pseudo-random generator with fixed seed for determinism
    let seed = 123456789;
    const rng = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };

    for (let step = 0; step < 500; step++) {
      const op = Math.floor(rng() * 4); // 0: copy, 1: delete, 2: paste/insert, 3: cut
      const curLen = table.totalSamples;

      if (op === 0 && curLen > 0) {
        // Copy
        const start = Math.floor(rng() * curLen);
        const len = Math.floor(rng() * (curLen - start)) + 1;
        clipboardPieces = table.slice(start, len);
        refClipboard = refArray.slice(start, start + len);
      } else if (op === 1 && curLen > 1) {
        // Delete
        const start = Math.floor(rng() * curLen);
        const len = Math.floor(rng() * (curLen - start));
        table = table.delete(start, len).table;
        refArray.splice(start, len);
      } else if (op === 2 && clipboardPieces.length > 0) {
        // Paste / Insert
        const pos = Math.floor(rng() * (curLen + 1));
        table = table.insert(pos, clipboardPieces);
        refArray.splice(pos, 0, ...refClipboard);
      } else if (op === 3 && curLen > 1) {
        // Cut
        const start = Math.floor(rng() * curLen);
        const len = Math.floor(rng() * (curLen - start));
        clipboardPieces = table.slice(start, len);
        refClipboard = refArray.slice(start, start + len);
        table = table.delete(start, len).table;
        refArray.splice(start, len);
      }

      // Verification after each step
      assert.equal(table.totalSamples, refArray.length, `Step ${step}: Total samples mismatch`);
    }

    // Verify sample-by-sample correctness of the final flattened audio
    const finalFlat = table.flatten(pool)[0];
    assert.equal(finalFlat.length, refArray.length);
    for (let i = 0; i < refArray.length; i++) {
      assert.ok(
        Math.abs(finalFlat[i] - refArray[i]) < 1e-6,
        `Sample mismatch at index ${i}: piece table=${finalFlat[i]}, ref=${refArray[i]}`
      );
    }
  });

});
