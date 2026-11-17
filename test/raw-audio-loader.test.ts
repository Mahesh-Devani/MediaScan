/**
 * test/raw-audio-loader.test.ts
 * Tests for RawAudioLoader native WAV sample rate preservation,
 * non-resampling behavior in codec pipeline, and fallback paths.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RawAudioLoader } from '../src/audio/RawAudioLoader.ts';
import { WavExporter } from '../src/media/WavExporter.ts';
import { AudioPreprocessor } from '../src/codec/AudioPreprocessor.ts';

describe('RawAudioLoader Native Rate & Codec Converter Pipeline', () => {

  function createTestSignal(freq: number, sampleRate: number, durationSec: number): Int16Array {
    const numSamples = Math.floor(sampleRate * durationSec);
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(16000 * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    }
    return pcm;
  }

  it('preserves native 8,000 Hz sample rate and 1 channel for 8 kHz mono WAV', async () => {
    const pcm = createTestSignal(1000, 8000, 0.5);
    const wavBytes = WavExporter.encodeWav([pcm], 8000);

    const loaded = await RawAudioLoader.load(wavBytes, 'speech_8k.wav');

    assert.equal(loaded.sampleRate, 8000, 'Sample rate must remain exactly 8,000 Hz');
    assert.equal(loaded.numChannels, 1, 'Channel count must be 1');
    assert.equal(loaded.isContainerDecoded, false, 'Must not use container decode');
    assert.equal(loaded.formatName, 'WAV PCM 16-bit, 8000 Hz');
    assert.equal(loaded.channelData[0].length, pcm.length);
  });

  it('preserves native 16,000 Hz sample rate for 16 kHz mono WAV (*_g722_16000Hz_Input.wav)', async () => {
    const pcm = createTestSignal(1000, 16000, 0.5);
    const wavBytes = WavExporter.encodeWav([pcm], 16000);

    const loaded = await RawAudioLoader.load(wavBytes, 'test_g722_16000Hz_Input.wav');

    assert.equal(loaded.sampleRate, 16000, 'Sample rate must remain 16,000 Hz, NOT 48,000 Hz');
    assert.equal(loaded.numChannels, 1);
    assert.equal(loaded.isContainerDecoded, false);
    assert.equal(loaded.formatName, 'WAV PCM 16-bit, 16000 Hz');
    assert.equal(loaded.channelData[0].length, pcm.length);
  });

  it('preserves native 48,000 Hz sample rate and 2 channels for 48 kHz stereo WAV', async () => {
    const left = createTestSignal(440, 48000, 0.25);
    const right = createTestSignal(880, 48000, 0.25);
    const wavBytes = WavExporter.encodeWav([left, right], 48000);

    const loaded = await RawAudioLoader.load(wavBytes, 'studio_48k_stereo.wav');

    assert.equal(loaded.sampleRate, 48000, 'Sample rate must remain 48,000 Hz');
    assert.equal(loaded.numChannels, 2, 'Channel count must be 2');
    assert.equal(loaded.isContainerDecoded, false);
    assert.equal(loaded.formatName, 'WAV PCM 16-bit, 48000 Hz');
    assert.equal(loaded.channelData.length, 2);
    assert.equal(loaded.channelData[0].length, left.length);
  });

  it('produces no resampling when input sample rate equals target codec sample rate (16 kHz -> 16 kHz G.722)', async () => {
    const pcm = createTestSignal(1000, 16000, 0.2); // 3200 samples
    const wavBytes = WavExporter.encodeWav([pcm], 16000);

    const loaded = await RawAudioLoader.load(wavBytes, 'input_16k.wav');
    assert.equal(loaded.sampleRate, 16000);

    // Run through AudioPreprocessor matching Codec Converter pipeline for G.722 (target 16 kHz)
    const processed = AudioPreprocessor.process(loaded.channelData, 16000, {
      targetSampleRate: 16000,
      channelSelection: 0,
      removeDc: false,
      applyHighPass: false,
      normalizePeak: false
    });

    assert.equal(processed.pcm16.length, pcm.length, 'Output sample count must exactly equal input sample count');
    // Check that samples are bit-exact (converted from int16 -> float32 -> int16)
    let maxDiff = 0;
    for (let i = 0; i < pcm.length; i++) {
      const diff = Math.abs(processed.pcm16[i] - pcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.ok(maxDiff <= 1, `Max quantization difference between int16 and round-trip must be <= 1, got ${maxDiff}`);
  });

  it('produces no resampling when 8 kHz input is passed to 8 kHz codec (8 kHz -> 8 kHz G.711)', async () => {
    const pcm = createTestSignal(500, 8000, 0.2); // 1600 samples
    const wavBytes = WavExporter.encodeWav([pcm], 8000);

    const loaded = await RawAudioLoader.load(wavBytes, 'input_8k.wav');
    assert.equal(loaded.sampleRate, 8000);

    const processed = AudioPreprocessor.process(loaded.channelData, 8000, {
      targetSampleRate: 8000,
      channelSelection: 0,
      removeDc: false,
      applyHighPass: false,
      normalizePeak: false
    });

    assert.equal(processed.pcm16.length, pcm.length);
  });

  it('falls back to WebAudio container decoding when WavParser rejects corrupted or non-standard WAV', async () => {
    // Corrupted WAV with valid RIFF header but impossible chunk size / corrupted data
    const corruptedWav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, // RIFF
      0x10, 0x00, 0x00, 0x00,
      0x57, 0x41, 0x56, 0x45, // WAVE
      0x66, 0x6d, 0x74, 0x20, // fmt
      0x02, 0x00, 0x00, 0x00, // Invalid fmt chunk size (2 instead of 16+)
      0x01, 0x00
    ]);

    // In Node (non-browser), fallback to decodeViaWebAudio will throw AudioContext error
    await assert.rejects(
      async () => {
        await RawAudioLoader.load(corruptedWav, 'corrupted.wav');
      },
      /Browser AudioContext is required to decode containerized audio/,
      'Must enter the fallback decodeViaWebAudio path when WavParser rejects the file'
    );
  });

  it('formats WebAudio container fallback label correctly when AudioContext mock is present', async () => {
    // Mock browser AudioContext on globalThis
    const origWindow = (globalThis as any).window;
    try {
      (globalThis as any).window = {
        AudioContext: class {
          async decodeAudioData(_buf: ArrayBuffer) {
            return {
              numberOfChannels: 1,
              sampleRate: 48000,
              duration: 1.0,
              getChannelData(_c: number) { return new Float32Array(48000); }
            };
          }
          async close() {}
        }
      };

      // Corrupted WAV that triggers WavParser catch block
      const corruptedWav = new Uint8Array([
        0x52, 0x49, 0x46, 0x46,
        0x10, 0x00, 0x00, 0x00,
        0x57, 0x41, 0x56, 0x45,
        0x66, 0x6d, 0x74, 0x20,
        0x02, 0x00, 0x00, 0x00,
        0x01, 0x00
      ]);

      const loaded = await RawAudioLoader.load(corruptedWav, 'fallback_test.wav');
      assert.equal(loaded.isContainerDecoded, true);
      assert.equal(loaded.formatName, 'decoded by browser, rate resampled to 48000 Hz');
    } finally {
      (globalThis as any).window = origWindow;
    }
  });

});
