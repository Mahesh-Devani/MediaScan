import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AmrDepacketizer } from '../src/decoders/AmrDepacketizer.ts';
import { AmrDecoder } from '../src/decoders/AmrDecoder.ts';
import { CapturePipeline } from '../src/CapturePipeline.ts';

describe('Phase 3: AMR-NB & AMR-WB Depacketizer & Decoder', () => {
  const fixtureDir = path.resolve('test/fixtures/mrfp-o');
  const pcapFile = path.join(fixtureDir, 'mrfp-o.pcap');
  const amrNbRefFile = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-10242-pt100.amr');
  const amrNbPcmRefFile = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-10242-pt100.amr.pcm');
  const amrWbRefFile = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-11266-pt101.amrwb');
  const amrWbPcmRefFile = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-11266-pt101.amrwb.pcm');

  it('depacketizes AMR-NB RTP stream matching reference .amr file byte-for-byte', () => {
    const pcapBytes = new Uint8Array(fs.readFileSync(pcapFile));
    const result = CapturePipeline.process(pcapBytes);

    const s100 = result.streams.find((s) => s.payloadType === 100 && s.packets.length === 2921);
    assert.ok(s100, 'AMR-NB stream with 2921 packets should be detected');

    const depacketized = AmrDepacketizer.depacketize(
      s100.packets.map((p) => p.payload),
      false,
      false
    );

    const refAmrBytes = new Uint8Array(fs.readFileSync(amrNbRefFile));
    assert.strictEqual(depacketized.length, refAmrBytes.length, 'AMR-NB length must match reference file');

    for (let i = 0; i < depacketized.length; i++) {
      if (depacketized[i] !== refAmrBytes[i]) {
        assert.fail(`Byte mismatch at offset ${i}: got 0x${depacketized[i].toString(16)}, expected 0x${refAmrBytes[i].toString(16)}`);
      }
    }
  });

  it('depacketizes AMR-WB RTP stream matching reference .amrwb file byte-for-byte', () => {
    const pcapBytes = new Uint8Array(fs.readFileSync(pcapFile));
    const result = CapturePipeline.process(pcapBytes);

    const s101 = result.streams.find((s) => s.payloadType === 101 && s.packets.length === 2919);
    assert.ok(s101, 'AMR-WB stream with 2919 packets should be detected');

    const depacketized = AmrDepacketizer.depacketize(
      s101.packets.map((p) => p.payload),
      true,
      false
    );

    const refAmrwbBytes = new Uint8Array(fs.readFileSync(amrWbRefFile));
    assert.strictEqual(depacketized.length, refAmrwbBytes.length, 'AMR-WB length must match reference file');

    for (let i = 0; i < depacketized.length; i++) {
      if (depacketized[i] !== refAmrwbBytes[i]) {
        assert.fail(`Byte mismatch at offset ${i}: got 0x${depacketized[i].toString(16)}, expected 0x${refAmrwbBytes[i].toString(16)}`);
      }
    }
  });

  it('decodes AMR-NB stream bit-exact against 3GPP TS 26.101 reference PCM output', async () => {
    const refPcmBytes = fs.readFileSync(amrNbPcmRefFile);
    const refPcm = new Int16Array(
      refPcmBytes.buffer,
      refPcmBytes.byteOffset,
      refPcmBytes.byteLength / 2
    );

    const amrBytes = new Uint8Array(fs.readFileSync(amrNbRefFile));
    const { pcm, sampleRate } = await AmrDecoder.decodeAmrFile(amrBytes);

    assert.strictEqual(sampleRate, 8000, 'AMR-NB sample rate must be 8000 Hz');
    assert.strictEqual(pcm.length, refPcm.length, 'AMR-NB sample count must match reference');

    let maxDiff = 0;
    for (let i = 0; i < pcm.length; i++) {
      const diff = Math.abs(pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }

    assert.strictEqual(maxDiff, 0, `AMR-NB PCM must match reference output with 0 sample difference (maxDiff=${maxDiff})`);
  });

  it('decodes AMR-WB stream bit-exact against 3GPP TS 26.201 reference PCM output', async () => {
    const refPcmBytes = fs.readFileSync(amrWbPcmRefFile);
    const refPcm = new Int16Array(
      refPcmBytes.buffer,
      refPcmBytes.byteOffset,
      refPcmBytes.byteLength / 2
    );

    const amrwbBytes = new Uint8Array(fs.readFileSync(amrWbRefFile));
    const { pcm, sampleRate } = await AmrDecoder.decodeAmrFile(amrwbBytes);

    assert.strictEqual(sampleRate, 16000, 'AMR-WB sample rate must be 16000 Hz');
    assert.strictEqual(pcm.length, refPcm.length, 'AMR-WB sample count must match reference');

    let maxDiff = 0;
    for (let i = 0; i < pcm.length; i++) {
      const diff = Math.abs(pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }

    assert.strictEqual(maxDiff, 0, `AMR-WB PCM must match reference output with 0 sample difference (maxDiff=${maxDiff})`);
  });
});
