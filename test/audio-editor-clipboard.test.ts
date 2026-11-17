import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EditorClipboard } from '../src/clipstudio/editor/EditorClipboard.ts';
import { UndoRedoStack, type UndoSnapshot } from '../src/clipstudio/editor/UndoRedoStack.ts';
import { AudioBufferPool } from '../src/clipstudio/editor/AudioBufferPool.ts';
import { AudioPieceTable } from '../src/clipstudio/editor/AudioPieceTable.ts';

describe('Audio Editor Clipboard & Undo/Redo Engine', () => {
  it('copies and pastes audio within same sample rate and channels', () => {
    const cb = EditorClipboard.getInstance();
    const pool = new AudioBufferPool();

    const data = [new Float32Array([0.1, 0.2, 0.3, 0.4])];
    cb.copy(data, 16000, 16, 'clip1.wav');

    assert.equal(cb.hasContent, true);
    assert.equal(cb.getItem()?.lengthSamples, 4);

    const pasted = cb.pasteForTarget(16000, 1, pool);
    assert.ok(pasted);
    assert.equal(pasted.lengthSamples, 4);
    assert.equal(pasted.notice, undefined);

    const buf = pool.getBuffer(pasted.bufferId);
    assert.ok(buf);
    for (let i = 0; i < data[0].length; i++) {
      assert.ok(Math.abs(buf[0][i] - data[0][i]) < 1e-5);
    }
  });

  it('resamples and adapts channels when target format differs', () => {
    const cb = EditorClipboard.getInstance();
    const pool = new AudioBufferPool();

    // 8 kHz mono audio
    const data = [new Float32Array([0.2, 0.4, 0.6, 0.8])];
    cb.copy(data, 8000, 16, 'speech_8k.wav');

    // Paste into 16 kHz stereo
    const pasted = cb.pasteForTarget(16000, 2, pool);
    assert.ok(pasted);
    assert.ok(pasted.notice?.includes('Resampled 8,000 Hz → 16,000 Hz'));
    assert.ok(pasted.notice?.includes('Upmixed mono → stereo'));

    const buf = pool.getBuffer(pasted.bufferId);
    assert.ok(buf);
    assert.equal(buf.length, 2); // stereo
    // 8 kHz -> 16 kHz doubles the sample count approximately
    assert.ok(Math.abs(buf[0].length - 8) <= 1);
    assert.deepEqual(Array.from(buf[0]), Array.from(buf[1])); // L and R identical
  });

  it('manages undo and redo stacks with correct history navigation', () => {
    const history = new UndoRedoStack(5);
    const pool = new AudioBufferPool();
    const bufId = pool.registerBuffer([new Float32Array([1, 2, 3])], 16000, 16, 'buf');

    const table1 = AudioPieceTable.fromBuffer(bufId, 16000, 1, 3);
    const state1: UndoSnapshot = {
      table: table1,
      selectionStartSample: 0,
      selectionEndSample: 0,
      playheadSample: 0,
      description: 'Initial',
      timestamp: 1
    };

    // Make an edit (e.g. cut)
    history.push(state1);

    const table2 = AudioPieceTable.fromBuffer(bufId, 16000, 1, 2);
    const state2: UndoSnapshot = {
      table: table2,
      selectionStartSample: 0,
      selectionEndSample: 0,
      playheadSample: 0,
      description: 'Cut',
      timestamp: 2
    };

    assert.equal(history.canUndo, true);
    assert.equal(history.canRedo, false);
    assert.equal(history.currentUndoDescription, 'Initial');

    // Perform Undo
    const undone = history.undo(state2);
    assert.ok(undone);
    assert.equal(undone.description, 'Initial');
    assert.equal(history.canUndo, false);
    assert.equal(history.canRedo, true);
    assert.equal(history.currentRedoDescription, 'Cut');

    // Perform Redo
    const redone = history.redo(undone);
    assert.ok(redone);
    assert.equal(redone.description, 'Cut');
    assert.equal(history.canUndo, true);
    assert.equal(history.canRedo, false);
  });
});
