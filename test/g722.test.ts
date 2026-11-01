import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { G722Decoder } from '../src/decoders/G722Decoder.ts';

describe('Phase 3: G.722 SB-ADPCM Decoder', () => {
  it('decodes G.722 bit-exact against ITU-T G.722 reference PCM output', () => {
    const fixtureDir = path.resolve('test/fixtures/mrfp-o');
    const g722File = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-9218-pt9.g722');
    const refPcmFile = path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-9218-pt9.g722.pcm');

    assert.ok(fs.existsSync(g722File), `G.722 input fixture missing: ${g722File}`);
    assert.ok(fs.existsSync(refPcmFile), `Reference PCM fixture missing: ${refPcmFile}`);

    const g722Bytes = fs.readFileSync(g722File);
    const refPcmBytes = fs.readFileSync(refPcmFile);
    const refPcm = new Int16Array(
      refPcmBytes.buffer,
      refPcmBytes.byteOffset,
      refPcmBytes.byteLength / 2
    );

    const decoded = G722Decoder.decodeG722(g722Bytes);

    assert.strictEqual(decoded.length, refPcm.length, 'Decoded sample count must match reference');

    let maxDiff = 0;
    let diffCount = 0;
    for (let i = 0; i < decoded.length; i++) {
      const diff = Math.abs(decoded[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
      if (diff > 0) diffCount++;
    }

    assert.strictEqual(maxDiff, 0, `Decoded PCM must match reference bit-for-bit (maxDiff=${maxDiff}, diffCount=${diffCount})`);
  });
});
