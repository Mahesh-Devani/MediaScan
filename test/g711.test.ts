import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { G711Decoder } from '../src/decoders/G711Decoder.ts';
import { WavExporter } from '../src/media/WavExporter.ts';

describe('Phase 2: G.711 Decoder & WAV Exporter', () => {
  const ulawPath = path.resolve(process.cwd(), 'test/fixtures/mrfp-o/fd5d;d50a;8c17;2110;;547-8194-pt0.ulaw');
  const pcmPath = path.resolve(process.cwd(), 'test/fixtures/mrfp-o/fd5d;d50a;8c17;2110;;547-8194-pt0.ulaw.pcm');

  it('decodes G.711 u-law to 16-bit linear PCM byte-exact against ITU-T reference output', () => {
    assert.ok(fs.existsSync(ulawPath), `Missing ${ulawPath}`);
    assert.ok(fs.existsSync(pcmPath), `Missing ${pcmPath}`);

    const ulawBytes = fs.readFileSync(ulawPath);
    const expectedPcmBytes = fs.readFileSync(pcmPath);

    assert.equal(expectedPcmBytes.length, ulawBytes.length * 2);

    // Decode using our G711Decoder
    const decodedPcm16 = G711Decoder.decodeUlaw(new Uint8Array(ulawBytes.buffer, ulawBytes.byteOffset, ulawBytes.byteLength));
    const decodedPcmBytes = new Uint8Array(decodedPcm16.buffer, decodedPcm16.byteOffset, decodedPcm16.byteLength);

    assert.equal(decodedPcmBytes.length, expectedPcmBytes.length);

    // Check byte-for-byte exactness
    let mismatchCount = 0;
    let firstMismatch = -1;
    for (let i = 0; i < decodedPcmBytes.length; i++) {
      if (decodedPcmBytes[i] !== expectedPcmBytes[i]) {
        mismatchCount++;
        if (firstMismatch === -1) firstMismatch = i;
      }
    }

    if (mismatchCount > 0) {
      assert.fail(`PCM mismatch: ${mismatchCount} bytes differed. First mismatch at offset ${firstMismatch}: decoded=0x${decodedPcmBytes[firstMismatch].toString(16)}, expected=0x${expectedPcmBytes[firstMismatch].toString(16)}`);
    }

    assert.equal(mismatchCount, 0, 'Decoded PCM must match reference output byte-for-byte');
  });

  it('creates valid RIFF WAV header and container for 8kHz 16-bit mono PCM', () => {
    const pcmSamples = new Int16Array([0, 1000, 2000, -1000, -2000]);
    const wavBytes = WavExporter.encodeWav([pcmSamples], 8000, 16);

    const view = new DataView(wavBytes.buffer);
    // RIFF chunk descriptor
    assert.equal(String.fromCharCode(wavBytes[0], wavBytes[1], wavBytes[2], wavBytes[3]), 'RIFF');
    assert.equal(String.fromCharCode(wavBytes[8], wavBytes[9], wavBytes[10], wavBytes[11]), 'WAVE');
    // fmt subchunk
    assert.equal(String.fromCharCode(wavBytes[12], wavBytes[13], wavBytes[14], wavBytes[15]), 'fmt ');
    assert.equal(view.getUint16(20, true), 1); // AudioFormat 1 = PCM
    assert.equal(view.getUint16(22, true), 1); // NumChannels 1 = Mono
    assert.equal(view.getUint32(24, true), 8000); // SampleRate 8000
    assert.equal(view.getUint16(34, true), 16); // BitsPerSample 16
    // data subchunk
    assert.equal(String.fromCharCode(wavBytes[36], wavBytes[37], wavBytes[38], wavBytes[39]), 'data');
    assert.equal(view.getUint32(40, true), pcmSamples.length * 2);
  });

  it('creates dual-channel stereo WAV for mixed caller + callee', () => {
    const caller = new Int16Array([1000, 2000, 3000]);
    const callee = new Int16Array([500, 600, 700]);
    const wavBytes = WavExporter.encodeStereoWav(caller, callee, 8000);

    const view = new DataView(wavBytes.buffer);
    assert.equal(view.getUint16(22, true), 2); // 2 channels (Stereo)
    assert.equal(view.getUint32(24, true), 8000); // 8kHz
    assert.equal(view.getUint32(40, true), caller.length * 2 * 2); // 3 samples * 2 channels * 2 bytes = 12 bytes
  });
});
