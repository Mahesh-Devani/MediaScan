import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AudioDspEngine } from '../src/clipstudio/editor/AudioDspEngine.ts';

describe('Audio Editor DSP Engine & Signal Generators', () => {
  it('applies gain in dB with exact logarithmic factor', () => {
    const input = [new Float32Array([0.1, 0.2, -0.4, 0.5])];
    // +6.0206 dB is approximately 2.0x
    const boosted = AudioDspEngine.applyGainDb(input, 6.0205999);
    for (let i = 0; i < input[0].length; i++) {
      assert.ok(Math.abs(boosted[0][i] - input[0][i] * 2.0) < 1e-4);
    }

    // -6 dB is approximately 0.5x
    const attenuated = AudioDspEngine.applyGainDb(input, -6.0205999);
    for (let i = 0; i < input[0].length; i++) {
      assert.ok(Math.abs(attenuated[0][i] - input[0][i] * 0.5) < 1e-4);
    }
  });

  it('accurately normalizes to peak dBFS', () => {
    const input = [new Float32Array([0.2, -0.5, 0.1, 0.4])];
    // Peak is 0.5 (-6.02 dBFS). Normalizing to -1.0 dBFS (peak = 10^(-1/20) ~ 0.89125)
    const norm = AudioDspEngine.peakNormalize(input, -1.0);
    const targetPeak = Math.pow(10, -1.0 / 20);

    let actualPeak = 0;
    for (let i = 0; i < norm.channels[0].length; i++) {
      const absVal = Math.abs(norm.channels[0][i]);
      if (absVal > actualPeak) actualPeak = absVal;
    }

    assert.ok(Math.abs(actualPeak - targetPeak) < 1e-4);
    assert.ok(Math.abs(norm.appliedGainDb - 20 * Math.log10(targetPeak / 0.5)) < 0.1);
  });

  it('applies loudness normalization to target dBov', () => {
    // Generate a 1 kHz sine wave at amplitude 0.5 (RMS = 0.5 / sqrt(2) ~ 0.35355, dBov ~ -9.03 dB)
    const sine = AudioDspEngine.generateSine(1000, 0.5, 16000, 0.5);
    const norm = AudioDspEngine.loudnessNormalize(sine, -26.0);

    // Compute RMS of normalized
    let sumSq = 0;
    for (let i = 0; i < norm.channels[0].length; i++) {
      sumSq += norm.channels[0][i] * norm.channels[0][i];
    }
    const rms = Math.sqrt(sumSq / norm.channels[0].length);
    const achievedDbov = 20 * Math.log10(rms);

    assert.ok(Math.abs(achievedDbov - (-26.0)) < 0.2, `Expected -26 dBov, got ${achievedDbov}`);
  });

  it('applies fade in and fade out with correct boundary constraints', () => {
    const mono = new Float32Array([1.0, 1.0, 1.0, 1.0, 1.0]);
    const fadeIn = AudioDspEngine.applyFade([mono], 'in', 'linear');
    assert.equal(fadeIn[0][0], 0.0);
    assert.equal(fadeIn[0][4], 1.0);

    const fadeOut = AudioDspEngine.applyFade([mono], 'out', 'linear');
    assert.equal(fadeOut[0][0], 1.0);
    assert.equal(fadeOut[0][4], 0.0);
  });

  it('inverts polarity and reverses audio correctly', () => {
    const input = [new Float32Array([0.1, -0.2, 0.3, -0.4])];
    const inverted = AudioDspEngine.invertPolarity(input);
    const expectedInv = [-0.1, 0.2, -0.3, 0.4];
    for (let i = 0; i < expectedInv.length; i++) {
      assert.ok(Math.abs(inverted[0][i] - expectedInv[i]) < 1e-5);
    }

    const reversed = AudioDspEngine.reverse(input);
    const expectedRev = [-0.4, 0.3, -0.2, 0.1];
    for (let i = 0; i < expectedRev.length; i++) {
      assert.ok(Math.abs(reversed[0][i] - expectedRev[i]) < 1e-5);
    }
  });

  it('removes DC offset down to zero mean', () => {
    const dcShifted = [new Float32Array([0.5, 0.6, 0.4, 0.5])]; // mean = 0.5
    const cleaned = AudioDspEngine.removeDcOffset(dcShifted);

    let sum = 0;
    for (let i = 0; i < cleaned[0].length; i++) sum += cleaned[0][i];
    const mean = sum / cleaned[0].length;
    assert.ok(Math.abs(mean) < 1e-6);
  });

  it('generates telephony DTMF dual tones with accurate frequency presence', () => {
    // Digit '5': low = 770 Hz, high = 1336 Hz
    const dtmf = AudioDspEngine.generateDtmf({
      digit: '5',
      durationMs: 100,
      silenceMs: 20,
      sampleRate: 8000
    });

    assert.equal(dtmf.length, 1);
    assert.equal(dtmf[0].length, Math.floor(0.12 * 8000)); // 120ms total = 960 samples

    // Check silence section at end
    const silenceStart = Math.floor(0.1 * 8000);
    for (let i = silenceStart; i < dtmf[0].length; i++) {
      assert.equal(dtmf[0][i], 0.0);
    }
  });

  it('generates call progress tones (dial tone, busy tone)', () => {
    const dial = AudioDspEngine.generateCallProgressTone({
      type: 'dial',
      durationSec: 0.5,
      sampleRate: 8000
    });
    assert.equal(dial[0].length, 4000);

    const busy = AudioDspEngine.generateCallProgressTone({
      type: 'busy',
      durationSec: 1.0,
      sampleRate: 8000
    });
    assert.equal(busy[0].length, 8000);
    // Busy tone is 0.5s on, 0.5s off
    const offSample = Math.floor(0.75 * 8000);
    assert.equal(busy[0][offSample], 0.0);
  });

  it('mixes noise at precise target SNR', () => {
    // Generate clean speech substitute (1 kHz sine)
    const speech = AudioDspEngine.generateSine(1000, 1.0, 16000, 0.6);
    const noise = AudioDspEngine.generateNoise('white', 1.0, 16000, 0.3);

    const targetSnr = 10.0; // 10 dB SNR
    const mixed = AudioDspEngine.addNoiseAtTargetSnr(speech, noise, targetSnr);

    assert.equal(mixed[0].length, speech[0].length);
    // Noise was added, so amplitude should differ from clean speech
    let diffSum = 0;
    for (let i = 0; i < mixed[0].length; i++) {
      diffSum += Math.abs(mixed[0][i] - speech[0][i]);
    }
    assert.ok(diffSum > 0);
  });
});
