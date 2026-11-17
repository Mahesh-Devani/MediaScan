import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioMixer } from '../src/clipstudio/editor/AudioMixer.ts';

describe('Audio Editor Mixer & Concatenation Engine', () => {
  it('correctly sums two signals with per-clip gains in mix mode', () => {
    const a = [new Float32Array([0.2, 0.4, 0.2])];
    const b = [new Float32Array([0.1, 0.2])];

    const result = AudioMixer.mix(
      a,
      b,
      {
        mode: 'mix',
        offsetSample: 1,
        gainA: 1.0,
        gainB: 0.5,
        clippingStrategy: 'leave',
        extendLength: false
      },
      8000
    );

    // a[0] = 0.2
    // a[1] + 0.5 * b[0] = 0.4 + 0.05 = 0.45
    // a[2] + 0.5 * b[1] = 0.2 + 0.1 = 0.3
    assert.equal(result.channels[0].length, 3);
    assert.ok(Math.abs(result.channels[0][0] - 0.2) < 1e-5);
    assert.ok(Math.abs(result.channels[0][1] - 0.45) < 1e-5);
    assert.ok(Math.abs(result.channels[0][2] - 0.3) < 1e-5);
    assert.equal(result.isClipped, false);
  });

  it('detects clipping and automatically attenuates when auto-reduce is enabled', () => {
    const a = [new Float32Array([0.8, 0.8])];
    const b = [new Float32Array([0.8, 0.8])]; // Sum is 1.6 (> 1.0, ~+4 dBFS)

    const result = AudioMixer.mix(
      a,
      b,
      {
        mode: 'mix',
        offsetSample: 0,
        gainA: 1.0,
        gainB: 1.0,
        clippingStrategy: 'auto-reduce',
        extendLength: false
      },
      8000
    );

    assert.equal(result.isClipped, true);
    assert.ok(result.attenuationGainDb < 0);
    // Attenuated peak should be ~ -0.5 dBFS (~0.944)
    let max = 0;
    for (let i = 0; i < result.channels[0].length; i++) {
      if (Math.abs(result.channels[0][i]) > max) max = Math.abs(result.channels[0][i]);
    }
    assert.ok(max <= 0.95);
  });

  it('applies smooth saturation with soft-knee limiter', () => {
    const a = [new Float32Array([0.9, 0.9])];
    const b = [new Float32Array([0.9, 0.9])];

    const result = AudioMixer.mix(
      a,
      b,
      {
        mode: 'mix',
        offsetSample: 0,
        gainA: 1.0,
        gainB: 1.0,
        clippingStrategy: 'soft-limiter',
        extendLength: false
      },
      8000
    );

    assert.equal(result.isClipped, true);
    for (let i = 0; i < result.channels[0].length; i++) {
      assert.ok(result.channels[0][i] <= 1.0);
      assert.ok(result.channels[0][i] >= -1.0);
    }
  });

  it('concatenates multiple clips with silence gap', () => {
    const c1 = [new Float32Array([1, 1])];
    const c2 = [new Float32Array([2, 2])];
    const gap = 2; // 2 silence samples

    const merged = AudioMixer.concat([c1, c2], gap);
    assert.equal(merged[0].length, 6);
    assert.deepEqual(Array.from(merged[0]), [1, 1, 0, 0, 2, 2]);
  });
});
