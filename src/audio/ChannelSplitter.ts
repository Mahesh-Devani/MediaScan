/**
 * ChannelSplitter.ts
 * Multi-channel handler, channel names, RMS/Peak telemetry, silence detection,
 * and optional mono downmix.
 */

export interface ChannelAudio {
  channelIndex: number;
  channelName: string;
  totalChannels: number;
  data: Float32Array; // Normalized [-1.0, 1.0]
  rmsDbfs: number;
  peakDbfs: number;
  isSilent: boolean;
  silenceReason?: string;
  isMonoDownmix?: boolean;
}

export class ChannelSplitter {
  private static readonly STANDARD_NAMES: Record<number, string[]> = {
    1: ['Mono'],
    2: ['Left', 'Right'],
    3: ['Left', 'Right', 'Center'],
    4: ['Front Left', 'Front Right', 'Surround Left', 'Surround Right'],
    5: ['Front Left', 'Front Right', 'Center', 'Surround Left', 'Surround Right'],
    6: ['Front Left', 'Front Right', 'Center', 'LFE (Subwoofer)', 'Back Left', 'Back Right'], // 5.1
    7: ['Front Left', 'Front Right', 'Center', 'LFE', 'Back Center', 'Side Left', 'Side Right'], // 6.1
    8: ['Front Left', 'Front Right', 'Center', 'LFE', 'Back Left', 'Back Right', 'Side Left', 'Side Right'], // 7.1
  };

  /**
   * Split de-interleaved channel arrays into detailed ChannelAudio objects.
   */
  public static splitChannels(
    channelData: Float32Array[],
    includeMonoDownmix: boolean = false
  ): ChannelAudio[] {
    const numChannels = channelData.length;
    const names = this.STANDARD_NAMES[numChannels] || Array.from({ length: numChannels }, (_, i) => `Ch ${i + 1}`);

    const result: ChannelAudio[] = [];

    for (let c = 0; c < numChannels; c++) {
      const data = channelData[c];
      const { rmsDbfs, peakDbfs, isSilent, silenceReason } = this.analyzeChannel(data);

      result.push({
        channelIndex: c,
        channelName: names[c] || `Ch ${c + 1}`,
        totalChannels: numChannels,
        data,
        rmsDbfs,
        peakDbfs,
        isSilent,
        silenceReason,
        isMonoDownmix: false,
      });
    }

    if (includeMonoDownmix && numChannels > 1) {
      const downmixData = this.createDownmix(channelData);
      const { rmsDbfs, peakDbfs, isSilent, silenceReason } = this.analyzeChannel(downmixData);

      result.push({
        channelIndex: numChannels,
        channelName: 'Mono Downmix',
        totalChannels: numChannels,
        data: downmixData,
        rmsDbfs,
        peakDbfs,
        isSilent,
        silenceReason,
        isMonoDownmix: true,
      });
    }

    return result;
  }

  /**
   * Creates a normalized arithmetic mean mono downmix across all channels.
   */
  public static createDownmix(channels: Float32Array[]): Float32Array {
    if (channels.length === 0) return new Float32Array(0);
    const len = channels[0].length;
    const downmix = new Float32Array(len);
    const numCh = channels.length;

    for (let i = 0; i < len; i++) {
      let sum = 0.0;
      for (let c = 0; c < numCh; c++) {
        sum += channels[c][i];
      }
      downmix[i] = sum / numCh;
    }

    return downmix;
  }

  /**
   * Computes RMS, Peak, and silence metrics for a normalized float32 channel.
   */
  public static analyzeChannel(
    data: Float32Array
  ): { rmsDbfs: number; peakDbfs: number; isSilent: boolean; silenceReason?: string } {
    if (!data || data.length === 0) {
      return {
        rmsDbfs: -100.0,
        peakDbfs: -100.0,
        isSilent: true,
        silenceReason: 'Empty channel buffer (0 samples).',
      };
    }

    let sumSq = 0.0;
    let maxAbs = 0.0;

    for (let i = 0; i < data.length; i++) {
      const s = data[i];
      const absS = Math.abs(s);
      if (absS > maxAbs) maxAbs = absS;
      sumSq += s * s;
    }

    const rms = Math.sqrt(sumSq / data.length);
    const rmsDbfs = rms > 1e-5 ? Number((20 * Math.log10(rms)).toFixed(1)) : -100.0;
    const peakDbfs = maxAbs > 1e-5 ? Number((20 * Math.log10(maxAbs)).toFixed(1)) : -100.0;

    // A channel is digitally silent if peak is below -90 dBFS or strictly 0
    const isSilent = maxAbs < 0.0000316; // 10^(-90/20) ~ 3.16e-5
    const silenceReason = isSilent ? 'Channel digitally silent (peak < -90 dBFS); skipped' : undefined;

    return { rmsDbfs, peakDbfs, isSilent, silenceReason };
  }
}
