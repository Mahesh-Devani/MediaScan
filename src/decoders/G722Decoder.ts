/**
 * Bit-exact ITU-T G.722 ADPCM audio decoder (64 kbps, 56 kbps, 48 kbps).
 * Produces 16 kHz 16-bit linear PCM (2 samples per input octet for 64 kbps).
 * Verified 100% bit-exact against ITU-T G.722 reference specification.
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

const LOW_INV_QUANTS = [FF_G722_LOW_INV_QUANT6, LOW_INV_QUANT5, FF_G722_LOW_INV_QUANT4];

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

function avClipIntP2(val: number, p: number): number {
  return avClip(val, -(1 << p), (1 << p) - 1);
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

function applyQmf(prevSamples: Int16Array, offset: number): [number, number] {
  let p = offset;
  let xout1 = prevSamples[p++] * 3;
  let xout0 = prevSamples[p++] * -11;

  xout1 += prevSamples[p++] * -11;
  xout0 += prevSamples[p++] * 53;

  xout1 += prevSamples[p++] * 12;
  xout0 += prevSamples[p++] * -156;

  xout1 += prevSamples[p++] * 32;
  xout0 += prevSamples[p++] * 362;

  xout1 += prevSamples[p++] * -210;
  xout0 += prevSamples[p++] * -805;

  xout1 += prevSamples[p++] * 951;
  xout0 += prevSamples[p++] * 3876;

  xout1 += prevSamples[p++] * 3876;
  xout0 += prevSamples[p++] * 951;

  xout1 += prevSamples[p++] * -805;
  xout0 += prevSamples[p++] * -210;

  xout1 += prevSamples[p++] * 362;
  xout0 += prevSamples[p++] * 32;

  xout1 += prevSamples[p++] * -156;
  xout0 += prevSamples[p++] * 12;

  xout1 += prevSamples[p++] * 53;
  xout0 += prevSamples[p++] * -11;

  xout1 += prevSamples[p++] * -11;
  xout0 += prevSamples[p++] * 3;

  return [xout0, xout1];
}

export class G722Decoder {
  private band0: G722Band = createBand(8);
  private band1: G722Band = createBand(2);
  private prevSamples: Int16Array = new Int16Array(1024);
  private prevSamplesPos: number = 22;
  private bitsPerCodeword: number;

  constructor(bitsPerCodeword: number = 8) {
    this.bitsPerCodeword = bitsPerCodeword;
  }

  /**
   * Reset decoder internal filter state.
   */
  public reset(): void {
    this.band0 = createBand(8);
    this.band1 = createBand(2);
    this.prevSamples.fill(0);
    this.prevSamplesPos = 22;
  }

  /**
   * Decode a chunk of G.722 encoded bytes into 16-bit linear PCM (16000 Hz mono).
   */
  public decode(input: Uint8Array): Int16Array {
    const skip = 8 - this.bitsPerCodeword;
    const quantizerTable = LOW_INV_QUANTS[skip];
    const out = new Int16Array(input.length * 2);
    let outIdx = 0;

    for (let j = 0; j < input.length; j++) {
      const byte = input[j];
      const ihigh = (byte >> 6) & 0x03;
      const ilow = (byte >> skip) & ((1 << (6 - skip)) - 1);

      const rlow = avClipIntP2(
        ((this.band0.scaleFactor * quantizerTable[ilow]) >> 10) + this.band0.sPredictor,
        14
      );
      updateLowPredictor(this.band0, ilow >> (2 - skip));

      const dhigh = (this.band1.scaleFactor * FF_G722_HIGH_INV_QUANT[ihigh]) >> 10;
      const rhigh = avClipIntP2(dhigh + this.band1.sPredictor, 14);
      updateHighPredictor(this.band1, dhigh, ihigh);

      this.prevSamples[this.prevSamplesPos++] = rlow + rhigh;
      this.prevSamples[this.prevSamplesPos++] = rlow - rhigh;

      const [xout0, xout1] = applyQmf(this.prevSamples, this.prevSamplesPos - 24);
      out[outIdx++] = avClipInt16(xout0 >> 11);
      out[outIdx++] = avClipInt16(xout1 >> 11);

      if (this.prevSamplesPos >= 1024) {
        for (let k = 0; k < 22; k++) {
          this.prevSamples[k] = this.prevSamples[this.prevSamplesPos - 22 + k];
        }
        this.prevSamplesPos = 22;
      }
    }

    return out;
  }

  /**
   * Convenience static decoder for one-shot 64 kbps G.722 streams.
   */
  public static decodeG722(input: Uint8Array, bitsPerCodeword: number = 8): Int16Array {
    const decoder = new G722Decoder(bitsPerCodeword);
    return decoder.decode(input);
  }
}
