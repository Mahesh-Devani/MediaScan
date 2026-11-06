/**
 * BandwidthEstimator.ts
 * Estimates acoustic effective bandwidth via spectral energy roll-off.
 * Detects upsampled narrowband audio, reports effective cutoffs, and sanity-checks raw streams.
 */

export interface BandwidthEstimate {
  nativeSampleRate: number;
  effectiveBandwidthHz: number;
  rolloff85Hz: number;
  rolloff95Hz: number;
  isNarrowband: boolean;
  isUpsampledNarrowband: boolean;
  emptyHighSpectrumWarning: boolean;
  classification: string;
}

export class BandwidthEstimator {
  /**
   * Estimates effective acoustic bandwidth of a channel buffer using spectral energy roll-off.
   */
  public static estimate(data: Float32Array, sampleRate: number): BandwidthEstimate {
    if (!data || data.length === 0 || sampleRate <= 0) {
      return {
        nativeSampleRate: sampleRate,
        effectiveBandwidthHz: 0,
        rolloff85Hz: 0,
        rolloff95Hz: 0,
        isNarrowband: sampleRate <= 8000,
        isUpsampledNarrowband: false,
        emptyHighSpectrumWarning: false,
        classification: 'Empty or Invalid Audio',
      };
    }

    const isNarrowband = sampleRate <= 8000;
    const nyquist = sampleRate / 2;

    // Use up to 10 frames of 1024 samples to compute average power spectrum
    const fftSize = 1024;
    const halfFft = fftSize / 2;
    const numFrames = Math.min(10, Math.floor(data.length / fftSize));

    if (numFrames === 0) {
      return {
        nativeSampleRate: sampleRate,
        effectiveBandwidthHz: Math.round(nyquist),
        rolloff85Hz: Math.round(nyquist * 0.85),
        rolloff95Hz: Math.round(nyquist * 0.95),
        isNarrowband,
        isUpsampledNarrowband: false,
        emptyHighSpectrumWarning: false,
        classification: isNarrowband ? 'Narrowband (<= 8 kHz)' : 'Short Audio',
      };
    }

    const avgPsd = new Float32Array(halfFft);
    const step = Math.floor(data.length / (numFrames + 1));

    for (let f = 0; f < numFrames; f++) {
      const offset = f * step;
      const frame = new Float32Array(fftSize);
      for (let i = 0; i < fftSize; i++) {
        // Hann window
        const win = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * i) / (fftSize - 1)));
        frame[i] = data[offset + i] * win;
      }

      // Compute Real FFT power
      const mag = this.computeRealFftMagnitude(frame);
      for (let i = 0; i < halfFft; i++) {
        avgPsd[i] += mag[i] * mag[i];
      }
    }

    // Cumulative sum
    let totalEnergy = 0.0;
    for (let i = 0; i < halfFft; i++) {
      totalEnergy += avgPsd[i];
    }

    if (totalEnergy === 0) {
      return {
        nativeSampleRate: sampleRate,
        effectiveBandwidthHz: 0,
        rolloff85Hz: 0,
        rolloff95Hz: 0,
        isNarrowband,
        isUpsampledNarrowband: false,
        emptyHighSpectrumWarning: false,
        classification: 'Digital Silence',
      };
    }

    const binWidth = nyquist / halfFft;
    let cumEnergy = 0.0;
    let rolloff85Hz = nyquist;
    let rolloff95Hz = nyquist;
    let found85 = false;
    let found95 = false;

    for (let i = 0; i < halfFft; i++) {
      cumEnergy += avgPsd[i];
      const freq = i * binWidth;
      if (!found85 && cumEnergy >= 0.85 * totalEnergy) {
        rolloff85Hz = Math.round(freq);
        found85 = true;
      }
      if (!found95 && cumEnergy >= 0.95 * totalEnergy) {
        rolloff95Hz = Math.round(freq);
        found95 = true;
      }
    }

    // Check for upsampled narrowband
    const isUpsampledNarrowband = sampleRate > 8000 && rolloff85Hz <= 3900;

    // Sanity check for headerless / raw streams: check energy in top quartile
    const topQuartileStart = Math.floor(halfFft * 0.5); // Frequencies > 0.25 * sampleRate
    let topQuartileEnergy = 0.0;
    for (let i = topQuartileStart; i < halfFft; i++) {
      topQuartileEnergy += avgPsd[i];
    }
    const emptyHighSpectrumWarning = sampleRate >= 32000 && (topQuartileEnergy / totalEnergy) < 0.005;

    let classification: string;
    if (isNarrowband) {
      classification = 'Narrowband Telephony (8 kHz)';
    } else if (isUpsampledNarrowband) {
      classification = `Upsampled Narrowband (${sampleRate} Hz header, ~${rolloff85Hz} Hz effective)`;
    } else if (rolloff85Hz >= 7000 && rolloff85Hz < 12000) {
      classification = 'Wideband Audio (16–24 kHz)';
    } else if (rolloff85Hz >= 12000) {
      classification = 'Fullband High-Definition Audio';
    } else {
      classification = `Standard Audio (~${rolloff85Hz} Hz bandwidth)`;
    }

    return {
      nativeSampleRate: sampleRate,
      effectiveBandwidthHz: rolloff95Hz,
      rolloff85Hz,
      rolloff95Hz,
      isNarrowband,
      isUpsampledNarrowband,
      emptyHighSpectrumWarning,
      classification,
    };
  }

  /**
   * Basic Real FFT magnitude for power spectrum computation.
   */
  private static computeRealFftMagnitude(frame: Float32Array): Float32Array {
    const N = frame.length;
    const half = N / 2;
    const real = new Float32Array(N);
    const imag = new Float32Array(N);
    real.set(frame);

    // Bit reversal
    let j = 0;
    for (let i = 0; i < N - 1; i++) {
      if (i < j) {
        const tr = real[i]; real[i] = real[j]; real[j] = tr;
        const ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      let k = N >> 1;
      while (k <= j) {
        j -= k;
        k >>= 1;
      }
      j += k;
    }

    // Cooley-Tukey Radix-2
    for (let len = 2; len <= N; len <<= 1) {
      const halfLen = len >> 1;
      const angle = (-2 * Math.PI) / len;
      const wStepR = Math.cos(angle);
      const wStepI = Math.sin(angle);

      for (let i = 0; i < N; i += len) {
        let wr = 1.0;
        let wi = 0.0;
        for (let k = 0; k < halfLen; k++) {
          const uR = real[i + k];
          const uI = imag[i + k];
          const vR = real[i + k + halfLen] * wr - imag[i + k + halfLen] * wi;
          const vI = real[i + k + halfLen] * wi + imag[i + k + halfLen] * wr;

          real[i + k] = uR + vR;
          imag[i + k] = uI + vI;
          real[i + k + halfLen] = uR - vR;
          imag[i + k + halfLen] = uI - vI;

          const nextWr = wr * wStepR - wi * wStepI;
          wi = wr * wStepI + wi * wStepR;
          wr = nextWr;
        }
      }
    }

    const mag = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      mag[i] = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    }
    return mag;
  }
}
