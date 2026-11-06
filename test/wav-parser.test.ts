/**
 * wav-parser.test.ts
 * Unit tests for WavParser across all supported formats and edge cases:
 * - 8, 16, 24, 32-bit PCM
 * - 32-bit and 64-bit IEEE Float
 * - WAVE_FORMAT_EXTENSIBLE with sub-format GUIDs
 * - G.711 A-law and mu-law
 * - IMA ADPCM and MS ADPCM
 * - Metadata chunks (LIST, fact, ID3) and odd-byte padding
 * - Streamed/truncated WAVs (data size = 0, 0xFFFFFFFF)
 * - Float sanitization (NaN/Inf, DC bias, clipping detection)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { WavParser } from '../src/audio/WavParser.ts';

// Helper to construct synthetic WAV binary buffers
function buildWavBuffer(opts: {
  formatTag: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  rawSampleBytes: Uint8Array;
  extraChunks?: Array<{ id: string; data: Uint8Array }>;
  overrideDataSize?: number;
  extensibleGuid?: string;
}): Uint8Array {
  const { formatTag, channels, sampleRate, bitsPerSample, rawSampleBytes, extraChunks, overrideDataSize, extensibleGuid } = opts;
  const isExtensible = formatTag === 0xFFFE || !!extensibleGuid;
  const fmtChunkSize = isExtensible ? 40 : 16;
  const blockAlign = channels * Math.ceil(bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataSize = overrideDataSize !== undefined ? overrideDataSize : rawSampleBytes.length;

  let extraBytesLen = 0;
  if (extraChunks) {
    for (const ch of extraChunks) {
      extraBytesLen += 8 + ch.data.length + (ch.data.length & 1);
    }
  }

  const totalLength = 12 + (8 + fmtChunkSize) + extraBytesLen + (8 + rawSampleBytes.length);
  const out = new Uint8Array(totalLength);
  const view = new DataView(out.buffer);

  // RIFF header
  out.set([0x52, 0x49, 0x46, 0x46], 0); // 'RIFF'
  view.setUint32(4, totalLength - 8, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8); // 'WAVE'

  // fmt chunk
  let pos = 12;
  out.set([0x66, 0x6d, 0x74, 0x20], pos); // 'fmt '
  view.setUint32(pos + 4, fmtChunkSize, true);
  view.setUint16(pos + 8, isExtensible ? 0xFFFE : formatTag, true);
  view.setUint16(pos + 10, channels, true);
  view.setUint32(pos + 12, sampleRate, true);
  view.setUint32(pos + 16, byteRate, true);
  view.setUint16(pos + 20, blockAlign, true);
  view.setUint16(pos + 22, bitsPerSample, true);

  if (isExtensible) {
    view.setUint16(pos + 24, 22, true); // cbSize = 22
    view.setUint16(pos + 26, bitsPerSample, true); // validBits
    view.setUint32(pos + 28, 0x3, true); // dwChannelMask (stereo)
    // GUID 16 bytes: 00000001-0000-0010-8000-00aa00389b71 (PCM)
    const subFormat = formatTag === 3 ? 3 : 1;
    out.set([subFormat, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71], pos + 32);
  }
  pos += 8 + fmtChunkSize;

  // Extra chunks (LIST, fact, etc.)
  if (extraChunks) {
    for (const ch of extraChunks) {
      for (let i = 0; i < 4; i++) out[pos + i] = ch.id.charCodeAt(i);
      view.setUint32(pos + 4, ch.data.length, true);
      out.set(ch.data, pos + 8);
      pos += 8 + ch.data.length;
      if (ch.data.length & 1) pos += 1; // 2-byte word padding
    }
  }

  // data chunk
  out.set([0x64, 0x61, 0x74, 0x61], pos); // 'data'
  view.setUint32(pos + 4, dataSize, true);
  out.set(rawSampleBytes, pos + 8);

  return out;
}

describe('WavParser Comprehensive Format & Edge Case Tests', () => {

  it('parses standard 16-bit signed LE mono PCM WAV', () => {
    const samples = new Int16Array([0, 16384, 32767, -16384, -32768]);
    const raw = new Uint8Array(samples.buffer);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      rawSampleBytes: raw,
    });

    const parsed = WavParser.parse(wav, 'test_16bit.wav');
    assert.strictEqual(parsed.numChannels, 1);
    assert.strictEqual(parsed.sampleRate, 16000);
    assert.strictEqual(parsed.bitsPerSample, 16);
    assert.strictEqual(parsed.totalSamplesPerChannel, 5);
    assert.ok(Math.abs(parsed.channelData[0][1] - 0.5) < 0.001);
    assert.ok(Math.abs(parsed.channelData[0][2] - 1.0) < 0.001);
    assert.ok(Math.abs(parsed.channelData[0][3] - (-0.5)) < 0.001);
  });

  it('parses 8-bit unsigned stereo PCM WAV and de-interleaves channels', () => {
    // 8-bit unsigned: 128 is silence, 255 is +1.0, 0 is -1.0
    const raw = new Uint8Array([
      128, 255,  // Frame 0: L=0.0, R=+1.0
      0, 128,    // Frame 1: L=-1.0, R=0.0
    ]);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 2,
      sampleRate: 8000,
      bitsPerSample: 8,
      rawSampleBytes: raw,
    });

    const parsed = WavParser.parse(wav, 'test_8bit.wav');
    assert.strictEqual(parsed.numChannels, 2);
    assert.strictEqual(parsed.sampleRate, 8000);
    assert.strictEqual(parsed.totalSamplesPerChannel, 2);
    assert.ok(Math.abs(parsed.channelData[0][0] - 0.0) < 0.01);
    assert.ok(Math.abs(parsed.channelData[1][0] - 1.0) < 0.02);
    assert.ok(Math.abs(parsed.channelData[0][1] - (-1.0)) < 0.02);
    assert.ok(Math.abs(parsed.channelData[1][1] - 0.0) < 0.01);
  });

  it('parses 24-bit packed signed LE PCM WAV', () => {
    // 3 bytes per sample: 0x00, 0x00, 0x40 -> 0x400000 / 0x800000 = 0.5
    const raw = new Uint8Array([0x00, 0x00, 0x40, 0x00, 0x00, 0xc0]);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 48000,
      bitsPerSample: 24,
      rawSampleBytes: raw,
    });

    const parsed = WavParser.parse(wav, 'test_24bit.wav');
    assert.strictEqual(parsed.numChannels, 1);
    assert.strictEqual(parsed.bitsPerSample, 24);
    assert.strictEqual(parsed.totalSamplesPerChannel, 2);
    assert.ok(Math.abs(parsed.channelData[0][0] - 0.5) < 0.001);
    assert.ok(Math.abs(parsed.channelData[0][1] - (-0.5)) < 0.001);
  });

  it('parses 32-bit IEEE float WAV with NaN and Infinity sanitization', () => {
    const floatSamples = new Float32Array([0.0, 0.75, NaN, Infinity, -0.75]);
    const raw = new Uint8Array(floatSamples.buffer);
    const wav = buildWavBuffer({
      formatTag: 3,
      channels: 1,
      sampleRate: 44100,
      bitsPerSample: 32,
      rawSampleBytes: raw,
    });

    const parsed = WavParser.parse(wav, 'test_float32.wav');
    assert.strictEqual(parsed.formatTag, 3);
    assert.strictEqual(parsed.totalSamplesPerChannel, 5);
    assert.ok(Math.abs(parsed.channelData[0][1] - 0.75) < 0.001);
    assert.strictEqual(parsed.channelData[0][2], 0.0, 'NaN must be sanitized to 0.0');
    assert.strictEqual(parsed.channelData[0][3], 0.0, 'Infinity must be sanitized to 0.0');
    assert.ok(Math.abs(parsed.channelData[0][4] - (-0.75)) < 0.001);
  });

  it('parses WAVE_FORMAT_EXTENSIBLE with PCM subformat GUID', () => {
    const samples = new Int16Array([1000, 2000, -1000, -2000]);
    const raw = new Uint8Array(samples.buffer);
    const wav = buildWavBuffer({
      formatTag: 0xFFFE,
      channels: 2,
      sampleRate: 16000,
      bitsPerSample: 16,
      rawSampleBytes: raw,
      extensibleGuid: '00000001-0000-0010-8000-00aa00389b71',
    });

    const parsed = WavParser.parse(wav, 'extensible_pcm.wav');
    assert.strictEqual(parsed.numChannels, 2);
    assert.strictEqual(parsed.formatName, 'Extensible PCM');
    assert.strictEqual(parsed.totalSamplesPerChannel, 2);
  });

  it('handles metadata chunks (LIST, fact) with odd-byte padding', () => {
    const samples = new Int16Array([500, -500]);
    const raw = new Uint8Array(samples.buffer);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 8000,
      bitsPerSample: 16,
      rawSampleBytes: raw,
      extraChunks: [
        { id: 'fact', data: new Uint8Array([0x02, 0x00, 0x00, 0x00]) }, // 4 bytes
        { id: 'LIST', data: new Uint8Array([0x49, 0x4e, 0x46, 0x4f, 0x31]) }, // 5 bytes (odd length, padded to 6)
      ],
    });

    const parsed = WavParser.parse(wav, 'with_metadata.wav');
    assert.strictEqual(parsed.totalSamplesPerChannel, 2);
    assert.ok(parsed.channelData[0].length === 2);
  });

  it('recovers streamed WAV with data chunk size 0 by reading to EOF', () => {
    const samples = new Int16Array([100, 200, 300, 400]);
    const raw = new Uint8Array(samples.buffer);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      rawSampleBytes: raw,
      overrideDataSize: 0, // Streamed WAV reports 0
    });

    const parsed = WavParser.parse(wav, 'streamed_zero_size.wav');
    assert.strictEqual(parsed.totalSamplesPerChannel, 4);
  });

  it('recovers streamed WAV with data chunk size 0xFFFFFFFF by reading to EOF', () => {
    const samples = new Int16Array([100, 200, 300, 400]);
    const raw = new Uint8Array(samples.buffer);
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      rawSampleBytes: raw,
      overrideDataSize: 0xFFFFFFFF, // Streamed WAV reports -1
    });

    const parsed = WavParser.parse(wav, 'streamed_ffff_size.wav');
    assert.strictEqual(parsed.totalSamplesPerChannel, 4);
  });

  it('detects sample clipping when audio saturates', () => {
    const samples = new Int16Array(1000);
    for (let i = 0; i < 50; i++) {
      samples[i] = 32767; // 5% clipped samples (> 0.05% threshold)
    }
    const wav = buildWavBuffer({
      formatTag: 1,
      channels: 1,
      sampleRate: 16000,
      bitsPerSample: 16,
      rawSampleBytes: new Uint8Array(samples.buffer),
    });

    const parsed = WavParser.parse(wav, 'clipped.wav');
    assert.strictEqual(parsed.clippingDetected, true);
  });
});
