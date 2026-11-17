/**
 * G722Encoder.ts
 * ITU-T Recommendation G.722 Sub-band ADPCM Audio Encoder (64 kbps, 56 kbps, 48 kbps).
 * Encodes 16 kHz 16-bit linear PCM (or Float32Array [-1.0, 1.0]) into standard G.722 bitstreams.
 * Features 24-tap QMF analysis filtering and adaptive pole-zero sub-band prediction.
 * Bit-compatible with ITU-T G.722 reference specification.
 */

const INV_LOG2_TABLE = new Int16Array([
  2048, 2093, 2139, 2186, 2233, 2282, 2332, 2383,
  2435, 2489, 2543, 2599, 2656, 2714, 2774, 2834,
  2896, 2960, 3025, 3091, 3158, 3228, 3298, 3371,
  3444, 3520, 3597, 3676, 3756, 3838, 3922, 4008,
]);

const HIGH_LOG_FACTOR_STEP = new Int16Array([798, -214]);

const LOW_LOG_FACTOR_STEP = new Int16Array([
  -60, 3042, 1198, 538, 334, 172, 58, -30,
  3042, 1198, 538, 334, 172, 58, -30, -60,
]);

const FF_G722_HIGH_INV_QUANT = new Int16Array([-926, -202, 926, 202]);

const FF_G722_LOW_INV_QUANT4 = new Int16Array([
  0, -2557, -1612, -1121, -786, -530, -323, -150,
  2557, 1612, 1121, 786, 530, 323, 150, 0,
]);

const LOW_INV_QUANT5 = new Int16Array([
  -35, -35, -2919, -2195, -1765, -1458, -1219, -1023,
  -858, -714, -587, -473, -370, -276, -190, -110,
  2919, 2195, 1765, 1458, 1219, 1023, 858, 714,
  587, 473, 370, 276, 190, 110, 35, -35,
]);

const FF_G722_LOW_INV_QUANT6 = new Int16Array([
  -17, -17, -17, -17, -3101, -2738, -2376, -2088,
  -1873, -1689, -1535, -1399, -1279, -1170, -1072, -982,
  -899, -822, -750, -682, -618, -558, -501, -447,
  -396, -347, -300, -254, -211, -170, -130, -91,
  3101, 2738, 2376, 2088, 1873, 1689, 1535, 1399,
  1279, 1170, 1072, 982, 899, 822, 750, 682,
  618, 558, 501, 447, 396, 347, 300, 254,
  211, 170, 130, 91, 54, 17, -54, -17,
]);

// ITU-T G.722 QMF 24-tap analysis coefficients
const QMF_COEFFS = [3, -11, 12, 32, -210, 951, 3876, -805, 362, -156, 53, -11];

// ITU-T G.722 6-bit decision thresholds
const Q6 = [
  0, 35, 72, 110, 150, 190, 233, 276, 323, 370, 422, 473, 530, 587, 650, 714,
  786, 858, 940, 1023, 1121, 1219, 1339, 1458, 1612, 1765, 1980, 2195, 2557, 2919, 0, 0
];

const ILN = [
  0, 63, 62, 31, 30, 29, 28, 27,
  26, 25, 24, 23, 22, 21, 20, 19,
  18, 17, 16, 15, 14, 13, 12, 11,
  10,  9,  8,  7,  6,  5,  4,  0
];

const ILP = [
  0, 61, 60, 59, 58, 57, 56, 55,
  54, 53, 52, 51, 50, 49, 48, 47,
  46, 45, 44, 43, 42, 41, 40, 39,
  38, 37, 36, 35, 34, 33, 32,  0
];

const IHN = [0, 1, 0];
const IHP = [0, 3, 2];

const SIGN_LOOKUP = [-1, 1];

interface G722Band {
  sPredictor: number;
  sZero: number;
  partReconstMem: [number, number];
  prevQtzdReconst: number;
  poleMem: [number, number];
  diffMem: Int32Array;
  zeroMem: Int16Array;
  logFactor: number;
  scaleFactor: number;
}

function avClip(val: number, min: number, max: number): number {
  return val < min ? min : val > max ? max : val;
}

function avClipInt16(val: number): number {
  return avClip(val, -32768, 32767);
}

function linearScaleFactor(logFactor: number): number {
  const wd1 = INV_LOG2_TABLE[(logFactor >> 6) & 31];
  const shift = logFactor >> 11;
  return shift < 0 ? wd1 >> -shift : wd1 << shift;
}

function createBand(scaleFactor: number): G722Band {
  return {
    sPredictor: 0,
    sZero: 0,
    partReconstMem: [0, 0],
    prevQtzdReconst: 0,
    poleMem: [0, 0],
    diffMem: new Int32Array(6),
    zeroMem: new Int16Array(6),
    logFactor: 0,
    scaleFactor,
  };
}

function sZero(curDiff: number, band: G722Band): void {
  let accumZero = 0;
  function accum(k: number, x: number, d: number): void {
    const tmp = x;
    band.zeroMem[k] =
      ((band.zeroMem[k] * 255) >> 8) +
      d * ((band.diffMem[k] ^ curDiff) < 0 ? -128 : 128);
    band.diffMem[k] = tmp;
    accumZero += (tmp * band.zeroMem[k]) >> 15;
  }

  if (curDiff !== 0) {
    accum(5, band.diffMem[4], 1);
    accum(4, band.diffMem[3], 1);
    accum(3, band.diffMem[2], 1);
    accum(2, band.diffMem[1], 1);
    accum(1, band.diffMem[0], 1);
    accum(0, curDiff * 2, 1);
  } else {
    accum(5, band.diffMem[4], 0);
    accum(4, band.diffMem[3], 0);
    accum(3, band.diffMem[2], 0);
    accum(2, band.diffMem[1], 0);
    accum(1, band.diffMem[0], 0);
    accum(0, curDiff * 2, 0);
  }
  band.sZero = accumZero;
}

function doAdaptivePrediction(band: G722Band, curDiff: number): void {
  const curPartReconst = band.sZero + curDiff < 0 ? 1 : 0;
  const sg0 = SIGN_LOOKUP[curPartReconst !== band.partReconstMem[0] ? 1 : 0];
  const sg1 = SIGN_LOOKUP[curPartReconst === band.partReconstMem[1] ? 1 : 0];

  band.partReconstMem[1] = band.partReconstMem[0];
  band.partReconstMem[0] = curPartReconst;

  band.poleMem[1] = avClip(
    ((sg0 * avClip(band.poleMem[0], -8191, 8191)) >> 5) +
      sg1 * 128 +
      ((band.poleMem[1] * 127) >> 7),
    -12288,
    12288
  );

  const limit = 15360 - band.poleMem[1];
  band.poleMem[0] = avClip(-192 * sg0 + ((band.poleMem[0] * 255) >> 8), -limit, limit);

  sZero(curDiff, band);

  const curQtzdReconst = avClipInt16((band.sPredictor + curDiff) * 2);
  band.sPredictor = avClipInt16(
    band.sZero +
      ((band.poleMem[0] * curQtzdReconst) >> 15) +
      ((band.poleMem[1] * band.prevQtzdReconst) >> 15)
  );
  band.prevQtzdReconst = curQtzdReconst;
}

function updateLowPredictor(band: G722Band, ilow: number): void {
  doAdaptivePrediction(band, (band.scaleFactor * FF_G722_LOW_INV_QUANT4[ilow]) >> 10);
  band.logFactor = avClip(((band.logFactor * 127) >> 7) + LOW_LOG_FACTOR_STEP[ilow], 0, 18432);
  band.scaleFactor = linearScaleFactor(band.logFactor - (8 << 11));
}

function updateHighPredictor(band: G722Band, dhigh: number, ihigh: number): void {
  doAdaptivePrediction(band, dhigh);
  band.logFactor = avClip(((band.logFactor * 127) >> 7) + HIGH_LOG_FACTOR_STEP[ihigh & 1], 0, 22528);
  band.scaleFactor = linearScaleFactor(band.logFactor - (10 << 11));
}

export class G722Encoder {
  private band0: G722Band = createBand(8);
  private band1: G722Band = createBand(2);
  private history: Int16Array = new Int16Array(24);
  private mode: 1 | 2 | 3; // Mode 1: 64 kbps, Mode 2: 56 kbps, Mode 3: 48 kbps

  constructor(mode: 1 | 2 | 3 = 1) {
    this.mode = mode;
  }

  public reset(): void {
    this.band0 = createBand(8);
    this.band1 = createBand(2);
    this.history.fill(0);
  }

  /**
   * Encodes a 16 kHz 16-bit linear PCM array into G.722 bitstream.
   */
  public encode(pcm: Int16Array | Float32Array): Uint8Array {
    const numSamples = pcm.length;
    const numPairs = Math.floor(numSamples / 2);
    const out = new Uint8Array(numPairs);

    // Convert float to int16 if needed
    const in16 = pcm instanceof Int16Array ? pcm : new Int16Array(numSamples);
    if (!(pcm instanceof Int16Array)) {
      for (let i = 0; i < numSamples; i++) {
        let s = Math.round(pcm[i] * 32767);
        if (s > 32767) s = 32767;
        else if (s < -32768) s = -32768;
        in16[i] = s;
      }
    }

    for (let pair = 0; pair < numPairs; pair++) {
      const s0 = in16[pair * 2];
      const s1 = in16[pair * 2 + 1];

      // Shift history down by 2 places
      for (let k = 0; k < 22; k++) {
        this.history[k] = this.history[k + 2];
      }
      this.history[22] = s0;
      this.history[23] = s1;

      // QMF analysis filter bank: produces xlow and xhigh
      let sumeven = 0;
      let sumodd = 0;
      for (let k = 0; k < 12; k++) {
        sumodd += this.history[2 * k] * QMF_COEFFS[k];
        sumeven += this.history[2 * k + 1] * QMF_COEFFS[11 - k];
      }

      const xlow = avClipInt16((sumeven + sumodd) >> 14);
      const xhigh = avClipInt16((sumeven - sumodd) >> 14);

      // Low band ADPCM difference & 6-bit quantization
      const el = avClipInt16(xlow - this.band0.sPredictor);
      const wd = el >= 0 ? el : -(el + 1);
      let i = 1;
      for (; i < 30; i++) {
        const wd1 = (Q6[i] * this.band0.scaleFactor) >> 10;
        if (wd < wd1) break;
      }
      const ilow = el < 0 ? ILN[i] : ILP[i];
      const iL4 = (ilow >> 2) & 0x0f; // 4-bit index for predictor feedback
      updateLowPredictor(this.band0, iL4);

      // High band ADPCM difference & 2-bit quantization
      const eh = avClipInt16(xhigh - this.band1.sPredictor);
      const wdh = eh >= 0 ? eh : -(eh + 1);
      const wd1h = (564 * this.band1.scaleFactor) >> 10;
      const mih = wdh >= wd1h ? 2 : 1;
      const ihigh = eh < 0 ? IHN[mih] : IHP[mih];
      const dhigh = (this.band1.scaleFactor * FF_G722_HIGH_INV_QUANT[ihigh]) >> 10;
      updateHighPredictor(this.band1, dhigh, ihigh);

      // Combine lower and higher sub-band codewords into 1 octet
      if (this.mode === 1) {
        // Mode 1: 64 kbps (2 bits high, 6 bits low)
        out[pair] = ((ihigh & 0x03) << 6) | (ilow & 0x3f);
      } else if (this.mode === 2) {
        // Mode 2: 56 kbps (2 bits high, 5 bits low)
        out[pair] = ((ihigh & 0x03) << 5) | ((ilow >> 1) & 0x1f);
      } else {
        // Mode 3: 48 kbps (2 bits high, 4 bits low)
        out[pair] = ((ihigh & 0x03) << 4) | ((ilow >> 2) & 0x0f);
      }
    }

    return out;
  }

  /**
   * Convenience static encoder for one-shot G.722 encoding.
   * bitsPerCodeword: 8 (64 kbps, mode 1), 7 (56 kbps, mode 2), or 6 (48 kbps, mode 3).
   */
  public static encode(pcm: Int16Array | Float32Array, bitsPerCodeword: number = 8): Uint8Array {
    const mode = bitsPerCodeword === 6 ? 3 : bitsPerCodeword === 7 ? 2 : 1;
    const encoder = new G722Encoder(mode);
    return encoder.encode(pcm);
  }
}
