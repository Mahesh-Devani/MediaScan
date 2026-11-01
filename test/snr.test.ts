import { test, describe } from 'node:test';
import assert from 'node:assert';
import { SnrEngine } from '../src/analysis/SnrEngine.ts';
import { AudioFilters } from '../src/analysis/AudioFilters.ts';
import { VadDetector } from '../src/analysis/VadDetector.ts';

// Deterministic Pseudo-Random Number Generator (LCG)
function createRng(seed = 123456789) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/**
 * Generates synthetic speech with clear speech bursts and pause periods.
 * Total duration: 10 seconds.
 */
function generateSyntheticSpeech(sampleRate: number): Float32Array {
  const totalDuration = 10.0;
  const numSamples = Math.round(totalDuration * sampleRate);
  const speech = new Float32Array(numSamples);

  // Bursts: [startSec, endSec]
  const bursts = [
    [0.2, 1.8],
    [2.5, 4.0],
    [4.8, 6.5],
    [7.3, 8.8],
  ];

  for (const [start, end] of bursts) {
    const sIdx = Math.round(start * sampleRate);
    const eIdx = Math.round(end * sampleRate);
    const burstLen = eIdx - sIdx;

    for (let i = 0; i < burstLen; i++) {
      const t = i / sampleRate;
      // Multi-harmonic vocal glottal tone: 160Hz fundamental, 640Hz, 1280Hz
      const raw = (
        0.6 * Math.sin(2 * Math.PI * 160 * t) +
        0.3 * Math.sin(2 * Math.PI * 640 * t) +
        0.2 * Math.sin(2 * Math.PI * 1280 * t)
      );

      // Trapezoidal envelope (50ms attack, 50ms decay)
      const attackSec = 0.05;
      const decaySec = 0.05;
      let env = 1.0;
      if (t < attackSec) {
        env = t / attackSec;
      } else if (t > (burstLen / sampleRate) - decaySec) {
        env = Math.max(0, ((burstLen / sampleRate) - t) / decaySec);
      }

      speech[sIdx + i] = raw * env * 14000; // Peak amplitude ~14000 (around -7 dBFS)
    }
  }

  return speech;
}

/**
 * Generates white noise of specified duration and RMS amplitude.
 */
function generateWhiteNoise(sampleRate: number, durationSec: number, targetRms: number, rng: () => number): Float32Array {
  const numSamples = Math.round(durationSec * sampleRate);
  const noise = new Float32Array(numSamples);

  let sumSq = 0;
  for (let i = 0; i < numSamples; i++) {
    // Box-Muller transform for Gaussian noise
    const u1 = Math.max(1e-10, rng());
    const u2 = rng();
    const g = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
    noise[i] = g;
    sumSq += g * g;
  }

  const currentRms = Math.sqrt(sumSq / numSamples);
  const scale = targetRms / (currentRms || 1);
  for (let i = 0; i < numSamples; i++) {
    noise[i] *= scale;
  }

  return noise;
}

/**
 * Generates pink noise (1/f) using Paul Kellet's filter.
 */
function generatePinkNoise(sampleRate: number, durationSec: number, targetRms: number, rng: () => number): Float32Array {
  const numSamples = Math.round(durationSec * sampleRate);
  const noise = new Float32Array(numSamples);

  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let sumSq = 0;

  for (let i = 0; i < numSamples; i++) {
    const white = rng() * 2 - 1;
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.96900 * b2 + white * 0.1538520;
    b3 = 0.86650 * b3 + white * 0.3104856;
    b4 = 0.55000 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.0168980;
    const pink = b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362;
    b6 = white * 0.115926;
    noise[i] = pink;
    sumSq += pink * pink;
  }

  const currentRms = Math.sqrt(sumSq / numSamples);
  const scale = targetRms / (currentRms || 1);
  for (let i = 0; i < numSamples; i++) {
    noise[i] *= scale;
  }

  return noise;
}

/**
 * Mixes speech and noise at a calibrated target SNR (dB).
 */
function mixSpeechAndNoise(
  speech: Float32Array,
  sampleRate: number,
  targetSnrDb: number,
  noiseType: 'white' | 'pink',
  rng: () => number
): { pcm16: Int16Array; theoreticalSnr: number } {
  // Measure active speech RMS during known burst period [0.5, 1.5]
  const sStart = Math.round(0.5 * sampleRate);
  const sEnd = Math.round(1.5 * sampleRate);
  let sSum = 0;
  for (let i = sStart; i < sEnd; i++) {
    sSum += speech[i] * speech[i];
  }
  const speechBurstRms = Math.sqrt(sSum / (sEnd - sStart));

  // Required noise RMS for target SNR: SNR = 20 * log10(speechBurstRms / noiseRms)
  const targetNoiseRms = speechBurstRms / Math.pow(10, targetSnrDb / 20);

  const durationSec = speech.length / sampleRate;
  const noise = noiseType === 'white'
    ? generateWhiteNoise(sampleRate, durationSec, targetNoiseRms, rng)
    : generatePinkNoise(sampleRate, durationSec, targetNoiseRms, rng);

  const pcm16 = new Int16Array(speech.length);
  for (let i = 0; i < speech.length; i++) {
    const mixed = speech[i] + noise[i];
    pcm16[i] = Math.max(-32768, Math.min(32767, Math.round(mixed)));
  }

  return { pcm16, theoreticalSnr: targetSnrDb };
}

describe('Standalone SNR Analysis Engine & VAD', () => {
  const rng = createRng(42);

  test('Digital Signal Conditioning Filters: High-Pass & A-Weighting', () => {
    const fs = 16000;
    // 1. High-Pass filter test (80 Hz cutoff):
    // 20 Hz rumble should be heavily attenuated; 1000 Hz tone should pass virtually unattenuated.
    const hpf = AudioFilters.designHighPass(fs, 80);
    const lowFreq = new Float32Array(fs); // 1 second of 20 Hz
    const midFreq = new Float32Array(fs); // 1 second of 1000 Hz

    for (let i = 0; i < fs; i++) {
      lowFreq[i] = Math.sin(2 * Math.PI * 20 * (i / fs)) * 10000;
      midFreq[i] = Math.sin(2 * Math.PI * 1000 * (i / fs)) * 10000;
    }

    AudioFilters.applyBiquadInPlace(lowFreq, hpf);
    AudioFilters.applyBiquadInPlace(midFreq, hpf);

    // Measure steady-state RMS (last 0.5s)
    let lowSum = 0, midSum = 0;
    const halfFs = fs / 2;
    for (let i = halfFs; i < fs; i++) {
      lowSum += lowFreq[i] * lowFreq[i];
      midSum += midFreq[i] * midFreq[i];
    }
    const lowRms = Math.sqrt(lowSum / halfFs);
    const midRms = Math.sqrt(midSum / halfFs);

    // 20 Hz should be attenuated by at least 15 dB relative to 1000 Hz
    const lowAttenDb = 20 * Math.log10(lowRms / midRms);
    assert.ok(lowAttenDb < -15, `20 Hz tone should be attenuated by >15 dB, got ${lowAttenDb.toFixed(1)} dB`);

    // 2. A-Weighting filter test:
    // IEC 61672 specification: 1000 Hz gain is exactly 0 dB (normalized).
    const aFilter = AudioFilters.designAWeighting(fs);
    const test1kHz = new Float32Array(fs);
    for (let i = 0; i < fs; i++) test1kHz[i] = Math.sin(2 * Math.PI * 1000 * (i / fs)) * 10000;
    AudioFilters.applyBiquadCascadeInPlace(test1kHz, aFilter);

    let kSum = 0;
    for (let i = halfFs; i < fs; i++) kSum += test1kHz[i] * test1kHz[i];
    const kRms = Math.sqrt(kSum / halfFs);
    const gain1kHzDb = 20 * Math.log10(kRms / (10000 / Math.SQRT2));
    assert.ok(Math.abs(gain1kHzDb) < 0.2, `1 kHz A-weighting gain should be ~0 dB, got ${gain1kHzDb.toFixed(2)} dB`);
  });

  test('Synthetic Fixtures: White and Pink Noise at Known SNRs (0, 5, 10, 20, 30 dB)', () => {
    const fs = 16000;
    const speech = generateSyntheticSpeech(fs);
    const testSnrs = [0, 5, 10, 20, 30];

    for (const targetSnr of testSnrs) {
      // Test with White Noise
      const { pcm16: whitePcm } = mixSpeechAndNoise(speech, fs, targetSnr, 'white', rng);

      // Auto Mode
      const autoRes = SnrEngine.analyze(whitePcm, fs, { mode: 'auto', highPassCutoff: 0 });
      assert.strictEqual(autoRes.status, 'ok');
      assert.ok(autoRes.snrDb !== null, `Auto SNR should not be null for ${targetSnr} dB`);
      const autoDiff = Math.abs(autoRes.snrDb! - targetSnr);
      assert.ok(
        autoDiff <= 2.5,
        `Auto mode on White Noise at ${targetSnr} dB should be within +/-2.5 dB, got ${autoRes.snrDb} dB (diff: ${autoDiff.toFixed(2)})`
      );

      // Manual Mode: Known Speech Burst [0.5s - 1.5s] and Known Pause [2.0s - 2.4s]
      const manualRes = SnrEngine.analyze(whitePcm, fs, {
        mode: 'manual',
        highPassCutoff: 0,
        manualSpeechRange: { startSec: 0.5, endSec: 1.5 },
        manualNoiseRange: { startSec: 2.0, endSec: 2.4 },
      });
      assert.strictEqual(manualRes.status, 'ok');
      assert.ok(manualRes.snrDb !== null, `Manual SNR should not be null for ${targetSnr} dB`);
      const manualDiff = Math.abs(manualRes.snrDb! - targetSnr);
      assert.ok(
        manualDiff <= 1.0,
        `Manual mode on White Noise at ${targetSnr} dB should be within +/-1.0 dB, got ${manualRes.snrDb} dB (diff: ${manualDiff.toFixed(2)})`
      );

      // Test with Pink Noise
      const { pcm16: pinkPcm } = mixSpeechAndNoise(speech, fs, targetSnr, 'pink', rng);
      const pinkAutoRes = SnrEngine.analyze(pinkPcm, fs, { mode: 'auto', highPassCutoff: 0 });
      assert.strictEqual(pinkAutoRes.status, 'ok');
      const pinkDiff = Math.abs(pinkAutoRes.snrDb! - targetSnr);
      assert.ok(
        pinkDiff <= 2.5,
        `Auto mode on Pink Noise at ${targetSnr} dB should be within +/-2.5 dB, got ${pinkAutoRes.snrDb} dB (diff: ${pinkDiff.toFixed(2)})`
      );
    }
  });

  test('Range Tests: Dual-Segment Audio (Noisy First Half vs Clean Second Half)', () => {
    const fs = 16000;
    const halfDuration = 8.0;
    const halfSamples = Math.round(halfDuration * fs);

    // Segment 1 (0 to 8s): 8 dB SNR
    const speech1 = generateSyntheticSpeech(fs).subarray(0, halfSamples);
    const { pcm16: pcmHalf1 } = mixSpeechAndNoise(speech1, fs, 8, 'white', rng);

    // Segment 2 (8 to 16s): 24 dB SNR
    const speech2 = generateSyntheticSpeech(fs).subarray(0, halfSamples);
    const { pcm16: pcmHalf2 } = mixSpeechAndNoise(speech2, fs, 24, 'white', rng);

    // Concatenate into single 16s stream
    const fullPcm = new Int16Array(halfSamples * 2);
    fullPcm.set(pcmHalf1, 0);
    fullPcm.set(pcmHalf2, halfSamples);

    // Analyze First Half [0.0 - 8.0s]
    const resHalf1 = SnrEngine.analyze(fullPcm, fs, {
      mode: 'auto',
      range: { startSec: 0.0, endSec: 8.0 },
      highPassCutoff: 0,
    });
    assert.strictEqual(resHalf1.status, 'ok');
    assert.ok(resHalf1.snrDb !== null);
    assert.ok(
      Math.abs(resHalf1.snrDb! - 8) <= 2.5,
      `Range 1 SNR should be ~8 dB, got ${resHalf1.snrDb} dB`
    );

    // Analyze Second Half [8.0 - 16.0s]
    const resHalf2 = SnrEngine.analyze(fullPcm, fs, {
      mode: 'auto',
      range: { startSec: 8.0, endSec: 16.0 },
      highPassCutoff: 0,
    });
    assert.strictEqual(resHalf2.status, 'ok');
    assert.ok(resHalf2.snrDb !== null);
    assert.ok(
      Math.abs(resHalf2.snrDb! - 24) <= 2.5,
      `Range 2 SNR should be ~24 dB, got ${resHalf2.snrDb} dB`
    );

    // Ensure the two ranges produce markedly different results
    assert.ok(resHalf2.snrDb! > resHalf1.snrDb! + 12, 'Clean half should have significantly higher SNR than noisy half');
  });

  test('Edge Cases: Digital Silence, Continuous Tone (No Pauses), Clipping & Short Range', () => {
    const fs = 16000;

    // 1. Digital silence (all zero PCM) -> must return cannot_estimate, never output a number
    const silencePcm = new Int16Array(fs * 4); // 4 seconds of zeros
    const silenceRes = SnrEngine.analyze(silencePcm, fs);
    assert.strictEqual(silenceRes.status, 'cannot_estimate');
    assert.strictEqual(silenceRes.snrDb, null, 'Must never output a number for digital silence');
    assert.ok(silenceRes.cannotEstimateReason?.includes('silence'));

    // 2. Continuous Tone / Speech (No pauses) -> must return cannot_estimate or low-confidence
    const tonePcm = new Int16Array(fs * 4);
    for (let i = 0; i < tonePcm.length; i++) {
      tonePcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * (i / fs)) * 12000);
    }
    const toneRes = SnrEngine.analyze(tonePcm, fs, { mode: 'auto' });
    assert.ok(
      toneRes.status === 'cannot_estimate' || toneRes.confidence === 'low',
      'Continuous tone without pauses must flag cannot_estimate or low confidence'
    );
    if (toneRes.status === 'cannot_estimate') {
      assert.strictEqual(toneRes.snrDb, null);
    }

    // 3. Short duration (< 3 seconds) -> flags low confidence
    const shortSpeech = generateSyntheticSpeech(fs).subarray(0, Math.round(1.5 * fs));
    const { pcm16: shortPcm } = mixSpeechAndNoise(shortSpeech, fs, 15, 'white', rng);
    const shortRes = SnrEngine.analyze(shortPcm, fs);
    assert.strictEqual(shortRes.confidence, 'low');
    assert.ok(shortRes.lowConfidenceReasons.some(r => r.includes('under 3.0s')));

    // 4. Digital Clipping detection
    const speech = generateSyntheticSpeech(fs);
    const { pcm16: clippedPcm } = mixSpeechAndNoise(speech, fs, 20, 'white', rng);
    // Force digital clipping on 5% of samples
    for (let i = 0; i < clippedPcm.length; i += 20) {
      clippedPcm[i] = 32767;
    }
    const clippedRes = SnrEngine.analyze(clippedPcm, fs);
    assert.strictEqual(clippedRes.confidence, 'low');
    assert.ok(clippedRes.clippingPct > 1, `Should detect clipping, got ${clippedRes.clippingPct}%`);
    assert.ok(clippedRes.lowConfidenceReasons.some(r => r.includes('clipping')));
  });

  test('Multi-Sample-Rate & Multi-Codec Compatibility (8 kHz, 16 kHz, 48 kHz)', () => {
    const sampleRates = [8000, 16000, 48000];

    for (const fs of sampleRates) {
      const speech = generateSyntheticSpeech(fs);
      const { pcm16 } = mixSpeechAndNoise(speech, fs, 15, 'white', rng);

      const res = SnrEngine.analyze(pcm16, fs, { mode: 'auto', highPassCutoff: 80 });
      assert.strictEqual(res.status, 'ok');
      assert.strictEqual(res.sampleRate, fs);
      assert.ok(res.snrDb !== null);
      assert.ok(
        Math.abs(res.snrDb! - 15) <= 3.0,
        `Sample rate ${fs} Hz should estimate ~15 dB SNR, got ${res.snrDb} dB`
      );
    }
  });

  test('Time-Windowed Sliding Timeline Generation', () => {
    const fs = 16000;
    const speech = generateSyntheticSpeech(fs);
    const { pcm16 } = mixSpeechAndNoise(speech, fs, 18, 'white', rng);

    const res = SnrEngine.analyze(pcm16, fs, {
      mode: 'auto',
      timeWindowSizeSec: 5.0,
      timeWindowHopSec: 1.0,
    });

    assert.strictEqual(res.status, 'ok');
    assert.ok(res.timeline.length >= 5, `Expected at least 5 timeline points, got ${res.timeline.length}`);
    assert.ok(res.timelineStats !== undefined);
    assert.ok(res.timelineStats!.minSnr <= res.timelineStats!.avgSnr);
    assert.ok(res.timelineStats!.avgSnr <= res.timelineStats!.maxSnr);
  });
});
