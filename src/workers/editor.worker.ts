/**
 * editor.worker.ts
 * Web Worker for the Audio Editor.
 * Offloads heavy computational tasks:
 * 1. Multi-resolution min/max peak pyramids for 60 fps smooth zooming.
 * 2. Channel peak dBFS, RMS dBFS, and clipping detection.
 * 3. Background mix rendering and DSP filtering.
 */

export interface PeakLevel {
  samplesPerBucket: number;
  // Per channel: [minFloat32, maxFloat32]
  channels: Array<{
    min: Float32Array;
    max: Float32Array;
  }>;
}

export interface ChannelStats {
  channelIndex: number;
  peakAmplitude: number;
  peakDbfs: number;
  rmsDbfs: number;
  clippingCount: number;
  isClipped: boolean;
}

export interface PyramidResult {
  type: 'PYRAMID_READY';
  bufferId: string;
  levels: Array<{
    samplesPerBucket: number;
    channels: Array<{
      min: Float32Array;
      max: Float32Array;
    }>;
  }>;
  stats: ChannelStats[];
}

const BUCKET_SIZES = [16, 64, 256, 1024, 4096];

self.onmessage = (event: MessageEvent) => {
  const data = event.data;
  if (!data) return;

  if (data.type === 'COMPUTE_PYRAMID') {
    const { bufferId, channelData } = data as { bufferId: string; channelData: Float32Array[] };
    const numChannels = channelData.length;
    const numSamples = channelData[0] ? channelData[0].length : 0;

    // 1. Compute stats per channel
    const stats: ChannelStats[] = [];
    for (let c = 0; c < numChannels; c++) {
      const ch = channelData[c];
      let peak = 0;
      let sumSq = 0;
      let clipCount = 0;

      for (let i = 0; i < ch.length; i++) {
        const absVal = Math.abs(ch[i]);
        if (absVal > peak) peak = absVal;
        sumSq += ch[i] * ch[i];
        if (absVal >= 0.9999) clipCount++;
      }

      const rms = ch.length > 0 ? Math.sqrt(sumSq / ch.length) : 0;
      const peakDbfs = peak > 1e-6 ? 20 * Math.log10(peak) : -96.0;
      const rmsDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -96.0;

      stats.push({
        channelIndex: c,
        peakAmplitude: peak,
        peakDbfs: Math.round(peakDbfs * 10) / 10,
        rmsDbfs: Math.round(rmsDbfs * 10) / 10,
        clippingCount: clipCount,
        isClipped: clipCount > 0
      });
    }

    // 2. Compute peak pyramid levels
    const levels: PeakLevel[] = [];
    const transferList: ArrayBuffer[] = [];

    for (const bucketSize of BUCKET_SIZES) {
      const numBuckets = Math.ceil(numSamples / bucketSize);
      const levelChannels: Array<{ min: Float32Array; max: Float32Array }> = [];

      for (let c = 0; c < numChannels; c++) {
        const src = channelData[c];
        const minArr = new Float32Array(numBuckets);
        const maxArr = new Float32Array(numBuckets);

        for (let b = 0; b < numBuckets; b++) {
          const start = b * bucketSize;
          const end = Math.min(start + bucketSize, numSamples);
          let bMin = 1.0;
          let bMax = -1.0;

          for (let i = start; i < end; i++) {
            const v = src[i];
            if (v < bMin) bMin = v;
            if (v > bMax) bMax = v;
          }

          minArr[b] = bMin <= bMax ? bMin : 0;
          maxArr[b] = bMax >= bMin ? bMax : 0;
        }

        transferList.push(minArr.buffer, maxArr.buffer);
        levelChannels.push({ min: minArr, max: maxArr });
      }

      levels.push({
        samplesPerBucket: bucketSize,
        channels: levelChannels
      });
    }

    const response: PyramidResult = {
      type: 'PYRAMID_READY',
      bufferId,
      levels,
      stats
    };

    self.postMessage(response, transferList as any);
  }
};
