/**
 * MelSpectrogram.ts
 * Pure TypeScript implementation of Librosa's Mel-Spectrogram front-end for DNSMOS P.808.
 * Parameters:
 * - sr = 16000
 * - n_fft = 321 (frame_size = 320)
 * - hop_length = 160
 * - n_mels = 120
 * - Slaney area-normalized Mel filterbank
 * - power_to_db with ref=max, top_db=80.0
 * - Output shape: [900, 120] Float32Array (normalized via (db + 40) / 40)
 */

export class MelSpectrogram {
  public static readonly SR = 16000;
  public static readonly N_FFT = 321;
  public static readonly NUM_BINS = 161; // 1 + n_fft // 2
  public static readonly HOP = 160;
  public static readonly N_MELS = 120;
  public static readonly NUM_FRAMES = 900;

  private static cosTable: Float32Array | null = null;
  private static sinTable: Float32Array | null = null;
  private static hannWindow: Float32Array | null = null;
  private static melWeights: Float32Array | null = null;

  private static initTables(): void {
    if (this.cosTable && this.sinTable && this.hannWindow && this.melWeights) return;

    const n_fft = this.N_FFT;
    const num_bins = this.NUM_BINS;
    const n_mels = this.N_MELS;
    const sr = this.SR;

    // 1. Cosine & Sine tables for RFFT
    this.cosTable = new Float32Array(num_bins * n_fft);
    this.sinTable = new Float32Array(num_bins * n_fft);
    for (let k = 0; k < num_bins; k++) {
      const offset = k * n_fft;
      for (let n = 0; n < n_fft; n++) {
        const angle = (2.0 * Math.PI * k * n) / n_fft;
        this.cosTable[offset + n] = Math.cos(angle);
        this.sinTable[offset + n] = Math.sin(angle);
      }
    }

    // 2. Periodic Hann window (321 points)
    this.hannWindow = new Float32Array(n_fft);
    for (let n = 0; n < n_fft; n++) {
      this.hannWindow[n] = 0.5 * (1.0 - Math.cos((2.0 * Math.PI * n) / n_fft));
    }

    // 3. Slaney Mel Filterbank Matrix (120 x 161)
    this.melWeights = new Float32Array(n_mels * num_bins);

    const hzToMel = (hz: number): number => {
      if (hz < 1000.0) return hz / (200.0 / 3.0);
      return 15.0 + Math.log(hz / 1000.0) / (Math.log(6.4) / 27.0);
    };

    const melToHz = (mel: number): number => {
      if (mel < 15.0) return mel * (200.0 / 3.0);
      return 1000.0 * Math.exp((mel - 15.0) * (Math.log(6.4) / 27.0));
    };

    const minMel = hzToMel(0.0);
    const maxMel = hzToMel(sr / 2.0);
    const melPoints = new Float64Array(n_mels + 2);
    const melStep = (maxMel - minMel) / (n_mels + 1);
    for (let i = 0; i < n_mels + 2; i++) {
      melPoints[i] = melToHz(minMel + i * melStep);
    }

    const fftFreqs = new Float64Array(num_bins);
    for (let i = 0; i < num_bins; i++) {
      fftFreqs[i] = (i * sr) / n_fft;
    }

    for (let m = 0; m < n_mels; m++) {
      const f_left = melPoints[m];
      const f_center = melPoints[m + 1];
      const f_right = melPoints[m + 2];
      const fdiff_left = f_center - f_left;
      const fdiff_right = f_right - f_center;
      const enorm = 2.0 / (f_right - f_left);

      const mOffset = m * num_bins;
      for (let k = 0; k < num_bins; k++) {
        const freq = fftFreqs[k];
        let weight = 0.0;
        if (freq >= f_left && freq <= f_center && fdiff_left > 0) {
          weight = (freq - f_left) / fdiff_left;
        } else if (freq > f_center && freq <= f_right && fdiff_right > 0) {
          weight = (f_right - freq) / fdiff_right;
        }
        this.melWeights[mOffset + k] = Math.max(0.0, weight) * enorm;
      }
    }
  }

  /**
   * Computes P.808 input features from a 144,000-sample audio segment (16kHz).
   * Returns a Float32Array of shape [1, 900, 120].
   */
  public static compute(audio144k: Float32Array): Float32Array {
    this.initTables();

    const n_fft = this.N_FFT;
    const num_bins = this.NUM_BINS;
    const hop = this.HOP;
    const n_mels = this.N_MELS;
    const num_frames = this.NUM_FRAMES;

    const cosTable = this.cosTable!;
    const sinTable = this.sinTable!;
    const hann = this.hannWindow!;
    const melWeights = this.melWeights!;

    // 1. Pad input audio with 160 zeros on left and 160 zeros on right (center=True, pad_mode='constant')
    const paddedLen = audio144k.length + 320;
    const padded = new Float32Array(paddedLen);
    padded.set(audio144k, 160);

    // 2. Spectrogram computation [num_frames][n_mels]
    const melPower = new Float32Array(num_frames * n_mels);
    const framePower = new Float32Array(num_bins);

    let maxMelVal = 1e-10;

    for (let f = 0; f < num_frames; f++) {
      const frameStart = f * hop;

      // Real FFT of 321 points
      for (let k = 0; k < num_bins; k++) {
        const offset = k * n_fft;
        let real = 0.0;
        let imag = 0.0;
        for (let n = 0; n < n_fft; n++) {
          const sample = padded[frameStart + n] * hann[n];
          real += sample * cosTable[offset + n];
          imag -= sample * sinTable[offset + n];
        }
        framePower[k] = real * real + imag * imag;
      }

      // Project onto 120 Mel filters
      const fOffset = f * n_mels;
      for (let m = 0; m < n_mels; m++) {
        const mOffset = m * num_bins;
        let sum = 0.0;
        for (let k = 0; k < num_bins; k++) {
          sum += melWeights[mOffset + k] * framePower[k];
        }
        melPower[fOffset + m] = sum;
        if (sum > maxMelVal) maxMelVal = sum;
      }
    }

    // 3. Power to dB: 10 * log10(max(amin, S) / max(amin, ref)), top_db = 80.0
    // Then normalize: (db + 40) / 40
    const amin = 1e-10;
    const top_db = 80.0;
    const log10Ref = 10.0 * Math.log10(Math.max(amin, maxMelVal));

    const result = new Float32Array(num_frames * n_mels);
    let maxDb = -Infinity;

    // First pass: compute raw dB
    for (let i = 0; i < result.length; i++) {
      const val = melPower[i];
      const db = 10.0 * Math.log10(Math.max(amin, val)) - log10Ref;
      result[i] = db;
      if (db > maxDb) maxDb = db;
    }

    // Second pass: clamp to top_db and scale: (db + 40) / 40
    const minThreshold = maxDb - top_db;
    for (let i = 0; i < result.length; i++) {
      let db = result[i];
      if (db < minThreshold) db = minThreshold;
      result[i] = (db + 40.0) / 40.0;
    }

    return result;
  }
}
