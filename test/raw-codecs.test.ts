/**
 * raw-codecs.test.ts
 * Tests for RawAudioLoader:
 * - Codec auto-detection from magic bytes and extensions
 * - G.711 mu-law, G.711 A-law, G.722, G.726, G.729 decoders
 * - User-parameterized raw PCM decoding (16-bit, 24-bit, float)
 * - Tier 3 lazy fallback flags for iLBC and Speex
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { RawAudioLoader } from '../src/audio/RawAudioLoader.ts';

describe('Raw Bitstream & Codec Decoders Tests', () => {

  it('auto-detects codecs from magic bytes', () => {
    // AMR-NB magic: #!AMR\n
    const amrNbBytes = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a, 0x00]);
    assert.strictEqual(RawAudioLoader.detectCodec(amrNbBytes, 'unknown.bin'), 'amr-nb');

    // AMR-WB magic: #!AMR-WB\n
    const amrWbBytes = new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a]);
    assert.strictEqual(RawAudioLoader.detectCodec(amrWbBytes, 'stream.dat'), 'amr-wb');

    // OggS magic
    const oggBytes = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]);
    assert.strictEqual(RawAudioLoader.detectCodec(oggBytes, 'audio.bin'), 'opus');

    // Extension fallback
    assert.strictEqual(RawAudioLoader.detectCodec(new Uint8Array(10), 'voice.g722'), 'g722');
    assert.strictEqual(RawAudioLoader.detectCodec(new Uint8Array(10), 'call.ulaw'), 'g711u');
    assert.strictEqual(RawAudioLoader.detectCodec(new Uint8Array(10), 'call.alaw'), 'g711a');
  });

  it('decodes raw G.711 mu-law and A-law bitstreams into normalized Float32', async () => {
    // 0xFF in mu-law is digital silence (0)
    const ulawBytes = new Uint8Array([0xff, 0xff, 0xff, 0xff]);
    const uLoaded = await RawAudioLoader.load(ulawBytes, 'test.ulaw', 'g711u');
    assert.strictEqual(uLoaded.sampleRate, 8000);
    assert.strictEqual(uLoaded.channelData.length, 1);
    assert.strictEqual(uLoaded.channelData[0].length, 4);
    assert.ok(Math.abs(uLoaded.channelData[0][0]) < 0.001);

    // 0xD5 in A-law is digital silence (0)
    const alawBytes = new Uint8Array([0xd5, 0xd5, 0xd5, 0xd5]);
    const aLoaded = await RawAudioLoader.load(alawBytes, 'test.alaw', 'g711a');
    assert.strictEqual(aLoaded.sampleRate, 8000);
    assert.strictEqual(aLoaded.channelData[0].length, 4);
    assert.ok(Math.abs(aLoaded.channelData[0][0]) < 0.001);
  });

  it('decodes raw G.722 SB-ADPCM bitstream into 16 kHz Float32', async () => {
    const g722Bytes = new Uint8Array(100);
    const loaded = await RawAudioLoader.load(g722Bytes, 'test.g722', 'g722');
    assert.strictEqual(loaded.sampleRate, 16000);
    assert.strictEqual(loaded.codec, 'G722');
    assert.strictEqual(loaded.channelData[0].length, 200); // 2 samples per input octet
  });

  it('decodes raw G.726 32kbps ADPCM bitstream into 8 kHz Float32', async () => {
    const g726Bytes = new Uint8Array(50);
    const loaded = await RawAudioLoader.load(g726Bytes, 'test.g726', 'g726');
    assert.strictEqual(loaded.sampleRate, 8000);
    assert.strictEqual(loaded.codec, 'G726');
    assert.strictEqual(loaded.channelData[0].length, 100); // 2 samples per input octet
  });

  it('decodes raw G.729 CS-ACELP bitstream into 8 kHz Float32', async () => {
    // 20 bytes = two 10ms frames (160 samples at 8kHz)
    const g729Bytes = new Uint8Array(20);
    const loaded = await RawAudioLoader.load(g729Bytes, 'test.g729', 'g729');
    assert.strictEqual(loaded.sampleRate, 8000);
    assert.strictEqual(loaded.codec, 'G729');
    assert.strictEqual(loaded.channelData[0].length, 160);
  });

  it('decodes user-parameterized raw PCM buffers (16-bit, 24-bit, 32-bit)', async () => {
    // Stereo 16-bit PCM (2 frames, 4 samples total)
    const pcm16Bytes = new Uint8Array([
      0x00, 0x40,  // L = 16384 (0.5)
      0x00, 0x20,  // R = 8192 (0.25)
      0x00, 0xc0,  // L = -16384 (-0.5)
      0x00, 0xe0,  // R = -8192 (-0.25)
    ]);

    const loaded = await RawAudioLoader.load(pcm16Bytes, 'raw_test.pcm', 'pcm', {
      sampleRate: 48000,
      numChannels: 2,
      bitDepth: 16,
    });

    assert.strictEqual(loaded.sampleRate, 48000);
    assert.strictEqual(loaded.numChannels, 2);
    assert.strictEqual(loaded.channelData[0].length, 2);
    assert.ok(Math.abs(loaded.channelData[0][0] - 0.5) < 0.001);
    assert.ok(Math.abs(loaded.channelData[1][0] - 0.25) < 0.001);
  });

  it('flags iLBC and Speex as requiring optional ffmpeg.wasm lazy fallback', async () => {
    const ilbcLoaded = await RawAudioLoader.load(new Uint8Array(10), 'call.ilbc', 'ilbc');
    assert.strictEqual(ilbcLoaded.requiresLazyFallback, true);
    assert.ok(ilbcLoaded.lazyFallbackReason?.includes('ffmpeg.wasm'));

    const spxLoaded = await RawAudioLoader.load(new Uint8Array(10), 'voice.spx', 'speex');
    assert.strictEqual(spxLoaded.requiresLazyFallback, true);
    assert.ok(spxLoaded.lazyFallbackReason?.includes('ffmpeg.wasm'));
  });
});
