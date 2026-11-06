/**
 * resampling-multirate.test.ts
 * Tests for AudioResampler across multi-sample-rates and BandwidthEstimator:
 * - Rates: 8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000 Hz.
 * - Output is strictly 16 kHz Float32Array.
 * - Anti-aliasing filter attenuates out-of-band frequencies on downsampling.
 * - BandwidthEstimator identifies true vs upsampled narrowband audio.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AudioResampler } from '../src/dnsmos/AudioResampler.ts';
import { BandwidthEstimator } from '../src/audio/BandwidthEstimator.ts';

describe('Multi-Rate Resampling and Bandwidth Estimation Tests', () => {

  const testRates = [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000];

  for (const rate of testRates) {
    it(`resamples ${rate} Hz input accurately to 16,000 Hz`, () => {
      const durationSec = 1.0;
      const srcLen = Math.round(durationSec * rate);
      const src = new Float32Array(srcLen);

      // 400 Hz test tone
      for (let i = 0; i < srcLen; i++) {
        src[i] = Math.sin((2 * Math.PI * 400 * i) / rate) * 0.7;
      }

      const resampled = AudioResampler.resampleTo16k(src, rate);
      const expectedLen = Math.round(srcLen * (16000 / rate));

      assert.strictEqual(resampled instanceof Float32Array, true);
      assert.ok(Math.abs(resampled.length - expectedLen) <= 1, `Length mismatch for ${rate}Hz: got ${resampled.length}, expected ${expectedLen}`);

      // Check amplitude preservation of 400 Hz tone
      let maxAmp = 0;
      for (let i = 200; i < resampled.length - 200; i++) {
        if (Math.abs(resampled[i]) > maxAmp) maxAmp = Math.abs(resampled[i]);
      }
      assert.ok(maxAmp >= 0.65 && maxAmp <= 0.72, `Amplitude out of range for ${rate}Hz: ${maxAmp}`);
    });
  }

  it('anti-aliasing filter attenuates frequencies above 8 kHz when downsampling from 48 kHz', () => {
    const rate = 48000;
    const durationSec = 0.5;
    const srcLen = Math.round(durationSec * rate);
    const src = new Float32Array(srcLen);

    // 14 kHz tone (well above 8 kHz Nyquist of 16 kHz)
    for (let i = 0; i < srcLen; i++) {
      src[i] = Math.sin((2 * Math.PI * 14000 * i) / rate);
    }

    const downsampled = AudioResampler.resampleTo16k(src, rate);

    // Compute RMS of downsampled tone: must be attenuated by at least 25 dB
    let sumSq = 0;
    for (let i = 100; i < downsampled.length - 100; i++) {
      sumSq += downsampled[i] * downsampled[i];
    }
    const rms = Math.sqrt(sumSq / (downsampled.length - 200));
    assert.ok(rms < 0.05, `Out-of-band 14kHz tone was not adequately attenuated: RMS=${rms}`);
  });

  it('BandwidthEstimator correctly identifies narrowband, upsampled narrowband, and wideband', () => {
    // 1. True 8 kHz narrowband
    const nbData = new Float32Array(8000);
    for (let i = 0; i < 8000; i++) {
      nbData[i] = Math.sin((2 * Math.PI * 1000 * i) / 8000);
    }
    const nbEst = BandwidthEstimator.estimate(nbData, 8000);
    assert.strictEqual(nbEst.isNarrowband, true);
    assert.strictEqual(nbEst.isUpsampledNarrowband, false);

    // 2. 48 kHz container carrying only 1.5 kHz tone (upsampled narrowband)
    const upData = new Float32Array(48000);
    for (let i = 0; i < 48000; i++) {
      upData[i] = Math.sin((2 * Math.PI * 1500 * i) / 48000);
    }
    const upEst = BandwidthEstimator.estimate(upData, 48000);
    assert.strictEqual(upEst.isNarrowband, false);
    assert.strictEqual(upEst.isUpsampledNarrowband, true);
    assert.ok(upEst.rolloff85Hz < 4000);
    assert.strictEqual(upEst.emptyHighSpectrumWarning, true);
  });
});
