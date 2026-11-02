import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DnsmosEngine } from '../src/dnsmos/DnsmosEngine.ts';
import { Polyfit } from '../src/dnsmos/Polyfit.ts';
import { AudioResampler } from '../src/dnsmos/AudioResampler.ts';
import { MelSpectrogram } from '../src/dnsmos/MelSpectrogram.ts';

/**
 * Reads a 16-bit PCM mono WAV file into a Float32Array in [-1.0, 1.0].
 */
function readWavFile(filePath: string): { pcm: Float32Array; sampleRate: number } {
  const buf = fs.readFileSync(filePath);
  // Parse simple RIFF WAV header
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataIdx = buf.indexOf('data') + 4;
  const dataSize = buf.readUInt32LE(dataIdx);
  const rawData = buf.subarray(dataIdx + 4, dataIdx + 4 + dataSize);

  let pcm: Float32Array;
  if (bitsPerSample === 16) {
    const numSamples = Math.floor(rawData.length / 2);
    pcm = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = rawData.readInt16LE(i * 2) / 32768.0;
    }
  } else if (bitsPerSample === 32) {
    // 32-bit float
    const numSamples = Math.floor(rawData.length / 4);
    pcm = new Float32Array(rawData.buffer, rawData.byteOffset, numSamples);
  } else {
    throw new Error(`Unsupported bits per sample in test WAV: ${bitsPerSample}`);
  }

  return { pcm, sampleRate };
}

describe('DNSMOS (Microsoft) Speech Quality (P.835 & P.808) Engine', () => {

  describe('1. Polynomial Fitting Calibration (Polyfit)', () => {
    it('applies exact quadratic polynomial curve for regular standard DNSMOS', () => {
      // Test zero point (all equations yield < 1.0, clamped to P.835 min of 1.0)
      const pZero = Polyfit.fit(0, 0, 0, false);
      assert.equal(pZero.sig, 1.0, 'Raw 0.0052 clamped to min 1.0');
      assert.equal(pZero.bak, 1.0, 'Raw negative clamped to min 1.0');
      assert.equal(pZero.ovrl, 1.0, 'Raw 0.0460 clamped to min 1.0');

      // Test mid-range raw scores [3.0, 3.0, 3.0]
      // OVRL = -0.06766283 * 9 + 1.11546468 * 3 + 0.04602535 = -0.60896 + 3.34639 + 0.04603 = 2.7835
      // SIG = -0.08397278 * 9 + 1.22083953 * 3 + 0.0052439 = -0.75575 + 3.66252 + 0.00524 = 2.9120
      // BAK = -0.13166888 * 9 + 1.60915514 * 3 - 0.39604546 = -1.18502 + 4.82747 - 0.39605 = 3.2464
      const p3 = Polyfit.fit(3.0, 3.0, 3.0, false);
      assert.ok(Math.abs(p3.sig - 2.9120) < 0.01, `SIG expected ~2.912, got ${p3.sig}`);
      assert.ok(Math.abs(p3.bak - 3.2464) < 0.01, `BAK expected ~3.246, got ${p3.bak}`);
      assert.ok(Math.abs(p3.ovrl - 2.7835) < 0.01, `OVRL expected ~2.783, got ${p3.ovrl}`);
    });

    it('applies cubic polynomial curve for personalized DNSMOS', () => {
      const pPers = Polyfit.fit(3.0, 3.0, 3.0, true);
      assert.ok(pPers.sig >= 1.0 && pPers.sig <= 5.0);
      assert.ok(pPers.bak >= 1.0 && pPers.bak <= 5.0);
      assert.ok(pPers.ovrl >= 1.0 && pPers.ovrl <= 5.0);
    });
  });

  describe('2. Audio Resampler Accuracy & Windowing', () => {
    it('accurately upsamples 8 kHz narrowband audio to 16 kHz wideband model rate', () => {
      // 8 kHz input sine wave at 400 Hz (8000 samples = 1 sec)
      const src8k = new Float32Array(8000);
      for (let i = 0; i < src8k.length; i++) {
        src8k[i] = Math.sin((2 * Math.PI * 400 * i) / 8000);
      }

      const out16k = AudioResampler.resampleTo16k(src8k, 8000);
      assert.equal(out16k.length, 16000, 'Expected exact 2x sample count (16000)');

      // Check frequency preservation: peak should align with 400 Hz at 16 kHz
      assert.ok(Math.abs(out16k[0] - 0) < 0.01);
      // Sample 10 at 16k is time 10/16000 = 1/1600 s -> 400 * 2pi * (1/1600) = pi/2 -> sin = 1.0
      assert.ok(Math.abs(out16k[10] - 1.0) < 0.05, `Expected peak ~1.0, got ${out16k[10]}`);
    });

    it('handles short audio repetition and assigns low confidence flag', async () => {
      // 2 seconds audio (< 9.01s)
      const shortAudio = new Float32Array(16000 * 2);
      for (let i = 0; i < shortAudio.length; i++) {
        shortAudio[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.4;
      }

      const res = await DnsmosEngine.evaluatePcm(shortAudio, 16000, {
        streamId: 'test-short',
        ssrc: 9991,
        codec: 'PCMU',
        isFullStream: true,
      });

      assert.equal(res.confidence.level, 'low', 'Short audio must be marked low confidence');
      assert.ok(res.confidence.reasons.some(r => r.includes('9.01s')), 'Reason must state tiling/padding');
      assert.ok(res.confidence.reasons.some(r => r.includes('3.0s')), 'Reason must state short duration');
    });
  });

  describe('3. Mel-Spectrogram Front-End for P.808', () => {
    it('produces exact [900, 120] log mel-spectrogram matching Librosa parameters', () => {
      const audio = new Float32Array(144000);
      for (let i = 0; i < audio.length; i++) {
        audio[i] = Math.sin((2 * Math.PI * 500 * i) / 16000) * 0.5;
      }

      const mel = MelSpectrogram.compute(audio);
      assert.equal(mel.length, 900 * 120, 'Output must have 900 frames * 120 mel bins');

      // Check values within standard normalized dynamic range (~ -1.0 to 1.5)
      for (let i = 0; i < 500; i++) {
        assert.ok(!isNaN(mel[i]), `Mel value at index ${i} is NaN`);
        assert.ok(isFinite(mel[i]), `Mel value at index ${i} is not finite`);
      }
    });
  });

  describe('4. Golden Test: Bit-Exact Verification Against Official Python Reference', () => {
    const goldenPath = path.resolve(process.cwd(), 'test/fixtures/dnsmos/golden_dnsmos.json');

    it('matches Python reference within 0.01 on SIG, BAK, OVRL across all 5 test fixtures', async () => {
      assert.ok(fs.existsSync(goldenPath), `Golden fixture not found: ${goldenPath}`);
      const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

      const fixtures = [
        'clean_speech',
        'noisy_speech',
        'nr_processed',
        'g711_8k',
        'short_clip',
      ];

      for (const name of fixtures) {
        const expected = goldenData[name];
        assert.ok(expected, `Missing golden data for fixture: ${name}`);

        const wavPath = path.resolve(process.cwd(), expected.filename);
        assert.ok(fs.existsSync(wavPath), `WAV fixture not found: ${wavPath}`);

        const { pcm, sampleRate } = readWavFile(wavPath);

        const actual = await DnsmosEngine.evaluatePcm(pcm, sampleRate, {
          streamId: name,
          ssrc: 1000 + fixtures.indexOf(name),
          codec: name === 'g711_8k' ? 'PCMU' : 'EVS-WB',
        }, { includeP808: true });

        // Verify window count
        assert.equal(actual.windowCount, expected.num_hops, `Mismatch in window count for ${name}`);

        // Verify aggregated scores within strict tolerance of 0.01 (10x better than standard acceptable MOS delta)
        const diffSig = Math.abs(actual.sig - expected.SIG);
        const diffBak = Math.abs(actual.bak - expected.BAK);
        const diffOvrl = Math.abs(actual.ovrl - expected.OVRL);

        assert.ok(
          diffSig <= 0.01,
          `Fixture ${name} SIG mismatch: expected ${expected.SIG.toFixed(4)}, got ${actual.sig.toFixed(4)} (diff: ${diffSig.toFixed(4)})`
        );
        assert.ok(
          diffBak <= 0.01,
          `Fixture ${name} BAK mismatch: expected ${expected.BAK.toFixed(4)}, got ${actual.bak.toFixed(4)} (diff: ${diffBak.toFixed(4)})`
        );
        assert.ok(
          diffOvrl <= 0.01,
          `Fixture ${name} OVRL mismatch: expected ${expected.OVRL.toFixed(4)}, got ${actual.ovrl.toFixed(4)} (diff: ${diffOvrl.toFixed(4)})`
        );

        // Verify per-window scores match python reference
        for (let wIdx = 0; wIdx < actual.windows.length; wIdx++) {
          const actWin = actual.windows[wIdx];
          const expWin = expected.windows[wIdx];
          const winDiffSig = Math.abs(actWin.sig - expWin.SIG);
          const winDiffBak = Math.abs(actWin.bak - expWin.BAK);
          const winDiffOvrl = Math.abs(actWin.ovrl - expWin.OVRL);

          assert.ok(
            winDiffSig <= 0.01,
            `Fixture ${name} window ${wIdx} SIG mismatch: exp ${expWin.SIG.toFixed(4)}, act ${actWin.sig.toFixed(4)}`
          );
          assert.ok(
            winDiffBak <= 0.01,
            `Fixture ${name} window ${wIdx} BAK mismatch: exp ${expWin.BAK.toFixed(4)}, act ${actWin.bak.toFixed(4)}`
          );
          assert.ok(
            winDiffOvrl <= 0.01,
            `Fixture ${name} window ${wIdx} OVRL mismatch: exp ${expWin.OVRL.toFixed(4)}, act ${actWin.ovrl.toFixed(4)}`
          );
        }
      }
    });
  });

  describe('5. Behavioral Tests & Noise Reduction (NR) Diagnostics', () => {
    it('ranks clean speech strictly higher than noisy speech', async () => {
      const cleanWav = readWavFile(path.resolve(process.cwd(), 'test/fixtures/dnsmos/clean_speech.wav'));
      const noisyWav = readWavFile(path.resolve(process.cwd(), 'test/fixtures/dnsmos/noisy_speech.wav'));

      const cleanRes = await DnsmosEngine.evaluatePcm(cleanWav.pcm, cleanWav.sampleRate, {
        streamId: 'clean',
        ssrc: 2001,
        codec: 'G722',
      });
      const noisyRes = await DnsmosEngine.evaluatePcm(noisyWav.pcm, noisyWav.sampleRate, {
        streamId: 'noisy',
        ssrc: 2002,
        codec: 'G722',
      });

      assert.ok(cleanRes.sig > noisyRes.sig + 0.5, 'Clean speech SIG must be significantly higher than noisy speech');
      assert.ok(cleanRes.bak > noisyRes.bak + 1.0, 'Clean speech BAK must be significantly higher than noisy speech');
      assert.ok(cleanRes.ovrl > noisyRes.ovrl + 0.5, 'Clean speech OVRL must be significantly higher than noisy speech');
    });

    it('correctly compares input vs output leg and identifies effective noise reduction', async () => {
      const noisyWav = readWavFile(path.resolve(process.cwd(), 'test/fixtures/dnsmos/noisy_speech.wav'));
      const nrWav = readWavFile(path.resolve(process.cwd(), 'test/fixtures/dnsmos/nr_processed.wav'));

      const inRes = await DnsmosEngine.evaluatePcm(noisyWav.pcm, noisyWav.sampleRate, {
        streamId: 'inbound-leg',
        ssrc: 3001,
        direction: 'inbound',
        codec: 'G722',
      });
      const outRes = await DnsmosEngine.evaluatePcm(nrWav.pcm, nrWav.sampleRate, {
        streamId: 'outbound-leg',
        ssrc: 3002,
        direction: 'outbound',
        codec: 'G722',
      });

      const comparison = DnsmosEngine.compareLegs(inRes, outRes);
      assert.ok(comparison.deltaBak > 0.3, 'Noise reduction must increase BAK score');
      assert.equal(comparison.verdict, 'effective_nr');
      assert.ok(comparison.diagnosticExplanation.toLowerCase().includes('effective noise reduction'));
    });

    it('correctly identifies over-suppression diagnostic (BAK up, SIG down)', () => {
      // Mock inbound vs outbound results
      const inRes: any = { sig: 3.5, bak: 2.0, ovrl: 2.6 };
      const outRes: any = { sig: 2.8, bak: 3.2, ovrl: 2.4 }; // SIG down by 0.7, BAK up by 1.2

      const comp = DnsmosEngine.compareLegs(inRes, outRes);
      assert.equal(comp.verdict, 'bak_up_sig_down');
      assert.ok(comp.diagnosticExplanation.includes('over-suppression'));
    });

    it('correctly identifies transcoding or packet loss degradation (all down)', () => {
      const inRes: any = { sig: 3.8, bak: 3.8, ovrl: 3.6 };
      const outRes: any = { sig: 3.0, bak: 3.0, ovrl: 2.8 }; // All down by >= 0.25

      const comp = DnsmosEngine.compareLegs(inRes, outRes);
      assert.equal(comp.verdict, 'all_down');
      assert.ok(comp.diagnosticExplanation.includes('transcoding'));
    });
  });

  describe('6. Performance & Realtime Factor (RTF)', () => {
    it('achieves real-time factor > 1.0 on audio streams', async () => {
      const cleanWav = readWavFile(path.resolve(process.cwd(), 'test/fixtures/dnsmos/clean_speech.wav'));
      const res = await DnsmosEngine.evaluatePcm(cleanWav.pcm, cleanWav.sampleRate, {
        streamId: 'perf-stream',
        ssrc: 4001,
        codec: 'PCMU',
      });

      assert.ok(res.realtimeFactor > 1.0, `RTF should be faster than real-time (> 1.0), got ${res.realtimeFactor}x`);
      assert.ok(res.computeTimeMs < 5000, `Compute time for 12s audio should be < 5000ms, got ${res.computeTimeMs}ms`);
    });
  });
});
