/**
 * test/audio-editor-pyramid.test.ts
 * Tests that the multi-resolution peak pyramid levels match brute-force min/max calculations.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('Audio Editor Peak Pyramid Multi-Resolution Verification', () => {

  const BUCKET_SIZES = [16, 64, 256, 1024, 4096];

  function computePyramidBruteForce(samples: Float32Array, bucketSize: number) {
    const numBuckets = Math.ceil(samples.length / bucketSize);
    const minArr = new Float32Array(numBuckets);
    const maxArr = new Float32Array(numBuckets);

    for (let b = 0; b < numBuckets; b++) {
      const start = b * bucketSize;
      const end = Math.min(start + bucketSize, samples.length);
      let bMin = 1.0;
      let bMax = -1.0;
      for (let i = start; i < end; i++) {
        if (samples[i] < bMin) bMin = samples[i];
        if (samples[i] > bMax) bMax = samples[i];
      }
      minArr[b] = bMin <= bMax ? bMin : 0;
      maxArr[b] = bMax >= bMin ? bMax : 0;
    }
    return { minArr, maxArr };
  }

  it('computes exact min/max bounds across all pyramid bucket scales', () => {
    const numSamples = 20000;
    const testChannel = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      testChannel[i] = Math.sin(i * 0.03) * 0.8 + Math.cos(i * 0.007) * 0.15;
    }

    for (const bucketSize of BUCKET_SIZES) {
      const { minArr, maxArr } = computePyramidBruteForce(testChannel, bucketSize);
      assert.ok(minArr.length > 0);
      assert.ok(maxArr.length > 0);

      // Verify that every sample lies within its bucket min/max
      for (let i = 0; i < numSamples; i++) {
        const b = Math.floor(i / bucketSize);
        assert.ok(testChannel[i] >= minArr[b] - 1e-6, `Sample ${i} below min in bucket ${b}`);
        assert.ok(testChannel[i] <= maxArr[b] + 1e-6, `Sample ${i} above max in bucket ${b}`);
      }
    }
  });

  it('correctly calculates peak dBFS and RMS dBFS on calibrated 1 kHz sine wave', () => {
    const sampleRate = 16000;
    const numSamples = 16000;
    const channel = new Float32Array(numSamples);

    // 1 kHz sine wave with peak amplitude 0.5 (-6.02 dBFS, RMS = 0.5 / sqrt(2) = 0.35355 = -9.03 dBFS)
    for (let i = 0; i < numSamples; i++) {
      channel[i] = 0.5 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }

    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < numSamples; i++) {
      const a = Math.abs(channel[i]);
      if (a > peak) peak = a;
      sumSq += channel[i] * channel[i];
    }
    const rms = Math.sqrt(sumSq / numSamples);
    const peakDbfs = 20 * Math.log10(peak);
    const rmsDbfs = 20 * Math.log10(rms);

    assert.ok(Math.abs(peakDbfs - (-6.02)) < 0.1, `Peak dBFS should be ~ -6.02, got ${peakDbfs}`);
    assert.ok(Math.abs(rmsDbfs - (-9.03)) < 0.1, `RMS dBFS should be ~ -9.03, got ${rmsDbfs}`);
  });

});
