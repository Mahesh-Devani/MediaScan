/**
 * test/audio-editor-fidelity.test.ts
 * Tests for Audio Editor lossless fidelity, bit-exact round-trips,
 * and selection export.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioBufferPool } from '../src/clipstudio/editor/AudioBufferPool.ts';
import { AudioEditorLoader } from '../src/clipstudio/editor/AudioEditorLoader.ts';
import { WavExporter } from '../src/media/WavExporter.ts';

describe('Audio Editor Fidelity & Precision Tests', () => {

  it('lossless round-trip: open PCM16 WAV -> unchanged -> export produces identical sample payload', () => {
    const pool = new AudioBufferPool();
    const numSamples = 8000;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(15000 * Math.sin((2 * Math.PI * 440 * i) / 8000));
    }

    const originalWav = WavExporter.encodeWav([pcm], 8000);
    const { table } = AudioEditorLoader.importAudio(originalWav, 'original.wav', pool);

    assert.equal(table.sampleRate, 8000);
    assert.equal(table.totalSamples, numSamples);

    const exportedWav = AudioEditorLoader.exportWav(table, pool, { bitDepth: 16 });

    // Payload comparison (offset 44 onward)
    const originalPayload = originalWav.subarray(44);
    const exportedPayload = exportedWav.subarray(44);

    assert.equal(exportedPayload.length, originalPayload.length);
    assert.deepEqual(exportedPayload, originalPayload, 'Exported PCM16 sample payload must be byte-identical');
  });

  it('cut and paste back in place produces bit-exact reconstructed audio', () => {
    const pool = new AudioBufferPool();
    // 3200 samples = exactly 50 complete cycles of 250 Hz at 16 kHz (zero DC offset)
    const numSamples = 3200;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(20000 * Math.sin((2 * Math.PI * 250 * i) / 16000));
    }

    const wav = WavExporter.encodeWav([pcm], 16000);
    const { table } = AudioEditorLoader.importAudio(wav, 'test.wav', pool);

    // Cut samples [1000..2500)
    const cutStart = 1000;
    const cutLen = 1500;
    const cutResult = table.delete(cutStart, cutLen);
    const clipboard = cutResult.deleted;

    // Paste back at cutStart
    const restoredTable = cutResult.table.insert(cutStart, clipboard);

    assert.equal(restoredTable.totalSamples, numSamples);

    const flat = restoredTable.flatten(pool)[0];
    for (let i = 0; i < numSamples; i++) {
      const origSample = pcm[i] / 32768.0;
      assert.equal(flat[i], origSample, `Sample at ${i} must match exactly`);
    }
  });

  it('exports selection only with exact start and length', () => {
    const pool = new AudioBufferPool();
    // 4000 samples = exactly 100 complete cycles of 400 Hz at 16 kHz (zero DC offset)
    const numSamples = 4000;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(18000 * Math.sin((2 * Math.PI * 400 * i) / 16000));
    }

    const wav = WavExporter.encodeWav([pcm], 16000);
    const { table } = AudioEditorLoader.importAudio(wav, 'test.wav', pool);

    // Export selection [1000..2200) (length 1200 = exactly 30 cycles)
    const selExport = AudioEditorLoader.exportWav(table, pool, {
      bitDepth: 16,
      selection: { startSample: 1000, lengthSamples: 1200 }
    });

    const { table: selTable } = AudioEditorLoader.importAudio(selExport, 'sel.wav', pool);
    assert.equal(selTable.totalSamples, 1200);
    assert.equal(selTable.sampleRate, 16000);

    const selFlat = selTable.flatten(pool)[0];
    for (let i = 0; i < 1200; i++) {
      const expected = pcm[1000 + i] / 32768.0;
      assert.equal(selFlat[i], expected);
    }
  });

  it('supports 24-bit PCM WAV export and re-import with high dynamic range', () => {
    const pool = new AudioBufferPool();
    const numSamples = 2000;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(20000 * Math.sin(i * 0.05));
    }

    const wav16 = WavExporter.encodeWav([pcm], 48000);
    const { table } = AudioEditorLoader.importAudio(wav16, 'in.wav', pool);

    const wav24 = AudioEditorLoader.exportWav(table, pool, { bitDepth: 24 });
    const { table: table24 } = AudioEditorLoader.importAudio(wav24, 'out24.wav', pool);

    assert.equal(table24.sampleRate, 48000);
    assert.equal(table24.bitDepth, 24);
    assert.equal(table24.totalSamples, numSamples);
  });

  it('supports 32-bit IEEE float WAV export and re-import', () => {
    const pool = new AudioBufferPool();
    const numSamples = 1000;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(10000 * Math.cos(i * 0.1));
    }

    const wav16 = WavExporter.encodeWav([pcm], 32000);
    const { table } = AudioEditorLoader.importAudio(wav16, 'in.wav', pool);

    const wavFloat = AudioEditorLoader.exportWav(table, pool, { bitDepth: 32, isFloat: true });
    const { table: tableFloat } = AudioEditorLoader.importAudio(wavFloat, 'float.wav', pool);

    assert.equal(tableFloat.sampleRate, 32000);
    assert.equal(tableFloat.totalSamples, numSamples);

    const flat = tableFloat.flatten(pool)[0];
    for (let i = 0; i < numSamples; i++) {
      const orig = pcm[i] / 32768.0;
      assert.ok(Math.abs(flat[i] - orig) < 1e-4);
    }
  });

});
