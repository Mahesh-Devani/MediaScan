/**
 * AudioFilters.ts
 * Signal conditioning filters for Audio Quality & SNR analysis:
 * 1. 2nd-order Butterworth High-Pass Filter (50-100 Hz, default 80 Hz) for DC & rumble removal.
 * 2. Cascaded Biquad IEC 61672:2003 A-weighting IIR Filter.
 */

export interface BiquadCoeffs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

export class AudioFilters {
  /**
   * Designs a 2nd-order Butterworth High-Pass Filter via bilinear transform.
   */
  public static designHighPass(sampleRate: number, cutoffHz: number): BiquadCoeffs {
    const nyquist = sampleRate / 2;
    const clampedCutoff = Math.max(10, Math.min(cutoffHz, nyquist * 0.9));
    const omega = 2 * Math.PI * clampedCutoff;
    const c = Math.tan(omega / (2 * sampleRate));

    const a0 = 1 + Math.SQRT2 * c + c * c;
    return {
      b0: 1 / a0,
      b1: -2 / a0,
      b2: 1 / a0,
      a1: (2 * (c * c - 1)) / a0,
      a2: (1 - Math.SQRT2 * c + c * c) / a0,
    };
  }

  /**
   * Designs a 3-stage cascaded Biquad filter for IEC 61672:2003 A-Weighting.
   * Matches the analog curve:
   *   Ra(f) = (12194^2 * f^4) / ((f^2 + 20.6^2) * sqrt(f^2 + 107.7^2)(f^2 + 737.9^2) * (f^2 + 12194^2))
   * Bilinear transform with gain normalization to 0 dB at 1000 Hz.
   */
  public static designAWeighting(sampleRate: number): BiquadCoeffs[] {
    const k = 2 * sampleRate;

    const w1 = 2 * Math.PI * 20.598997;
    const w2 = 2 * Math.PI * 107.65265;
    const w3 = 2 * Math.PI * 737.86223;
    const w4 = 2 * Math.PI * 12194.217;

    // Section 1: s^2 / (s + w1)^2
    const d1 = (k + w1) * (k + w1);
    const sec1: BiquadCoeffs = {
      b0: (k * k) / d1,
      b1: (-2 * k * k) / d1,
      b2: (k * k) / d1,
      a1: (-2 * (k * k - w1 * w1)) / d1,
      a2: ((k - w1) * (k - w1)) / d1,
    };

    // Section 2: s^2 / (s + w4)^2
    const d2 = (k + w4) * (k + w4);
    const sec2: BiquadCoeffs = {
      b0: (k * k) / d2,
      b1: (-2 * k * k) / d2,
      b2: (k * k) / d2,
      a1: (-2 * (k * k - w4 * w4)) / d2,
      a2: ((k - w4) * (k - w4)) / d2,
    };

    // Section 3: 1 / ((s + w2) * (s + w3))
    const d3 = (k + w2) * (k + w3);
    const sec3: BiquadCoeffs = {
      b0: 1 / d3,
      b1: 2 / d3,
      b2: 1 / d3,
      a1: (-2 * (k * k - w2 * w3)) / d3,
      a2: ((k - w2) * (k - w3)) / d3,
    };

    const sections = [sec1, sec2, sec3];

    // Compute magnitude at 1000 Hz for exact 0 dB calibration
    const fRef = 1000;
    const thetaRef = (2 * Math.PI * fRef) / sampleRate;
    const cos1 = Math.cos(thetaRef);
    const sin1 = Math.sin(thetaRef);
    const cos2 = Math.cos(2 * thetaRef);
    const sin2 = Math.sin(2 * thetaRef);

    let totalGain = 1.0;
    for (const s of sections) {
      const numR = s.b0 + s.b1 * cos1 + s.b2 * cos2;
      const numI = -(s.b1 * sin1 + s.b2 * sin2);
      const denR = 1 + s.a1 * cos1 + s.a2 * cos2;
      const denI = -(s.a1 * sin1 + s.a2 * sin2);

      const numMag2 = numR * numR + numI * numI;
      const denMag2 = denR * denR + denI * denI;
      totalGain *= Math.sqrt(numMag2 / denMag2);
    }

    if (totalGain > 0) {
      // Normalize gain on the first section
      sec1.b0 /= totalGain;
      sec1.b1 /= totalGain;
      sec1.b2 /= totalGain;
    }

    return sections;
  }

  /**
   * Applies a single Biquad IIR filter to an in-place Float32Array.
   */
  public static applyBiquadInPlace(samples: Float32Array, filter: BiquadCoeffs): void {
    let x1 = 0, x2 = 0;
    let y1 = 0, y2 = 0;
    const { b0, b1, b2, a1, a2 } = filter;

    for (let i = 0; i < samples.length; i++) {
      const x0 = samples[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      samples[i] = y0;
    }
  }

  /**
   * Applies cascaded Biquad sections in-place.
   */
  public static applyBiquadCascadeInPlace(samples: Float32Array, filters: BiquadCoeffs[]): void {
    for (const f of filters) {
      this.applyBiquadInPlace(samples, f);
    }
  }
}
