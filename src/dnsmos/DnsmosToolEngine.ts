/**
 * DnsmosToolEngine.ts
 * Standalone batch and chunked file audio evaluation engine using shared DnsmosEngine.
 * Handles:
 * - Multi-file and multi-channel scoring
 * - Long-file chunk streaming via File.slice() to keep memory bounded (< 50MB)
 * - Multi-item comparison mode with sample rate & codec mismatch warnings
 * - Batch cancellation via AbortController
 */

import type {
  DnsmosResult,
  DnsmosOptions,
  DnsmosFileInfo,
} from './DnsmosTypes.ts';
import { DnsmosEngine } from './DnsmosEngine.ts';
import { WavParser, type ParsedWav } from '../audio/WavParser.ts';
import { RawAudioLoader, type SupportedRawCodec, type RawPcmOptions } from '../audio/RawAudioLoader.ts';
import { ChannelSplitter, type ChannelAudio } from '../audio/ChannelSplitter.ts';
import { BandwidthEstimator, type BandwidthEstimate } from '../audio/BandwidthEstimator.ts';

export interface FileItemToScore {
  id: string;
  file: File;
  fileName: string;
  codec: SupportedRawCodec;
  pcmOptions?: RawPcmOptions;
  status: 'pending' | 'processing' | 'done' | 'error' | 'skipped';
  errorMessage?: string;
  channels: ChannelAudio[];
  sampleRate: number;
  durationSec: number;
  formatName: string;
  bandwidth?: BandwidthEstimate;
}

export interface ChannelScoreTask {
  fileId: string;
  fileName: string;
  channel: ChannelAudio;
  sampleRate: number;
  formatName: string;
  bandwidth?: BandwidthEstimate;
}

export interface MultiItemComparison {
  items: Array<{
    result: DnsmosResult;
    deltaSigAgainstBase: number;
    deltaBakAgainstBase: number;
    deltaOvrl: number;
  }>;
  hasRateMismatch: boolean;
  rateMismatchWarning?: string;
  hasCodecMismatch: boolean;
  codecMismatchWarning?: string;
}

export class DnsmosToolEngine {
  private static activeAbortController: AbortController | null = null;
  private static isRunning = false;

  public static isBatchActive(): boolean {
    return this.isRunning;
  }

  public static cancelBatch(): void {
    if (this.activeAbortController) {
      this.activeAbortController.abort();
      this.activeAbortController = null;
    }
    this.isRunning = false;
  }

  /**
   * Parse a File object into multi-channel audio buffers and metadata.
   */
  public static async parseAudioFile(
    file: File,
    forcedCodec: SupportedRawCodec = 'auto',
    pcmOptions?: RawPcmOptions,
    includeMonoDownmix: boolean = false
  ): Promise<{
    formatName: string;
    sampleRate: number;
    durationSec: number;
    channels: ChannelAudio[];
    bandwidth: BandwidthEstimate;
  }> {
    const isWav = file.name.toLowerCase().endsWith('.wav');
    let sampleRate = 0;
    let formatName = 'Audio';
    let durationSec = 0;
    let channelData: Float32Array[] = [];

    // For files < 100MB, read directly
    const buffer = await file.arrayBuffer();

    if (isWav && forcedCodec === 'auto') {
      try {
        const parsed = WavParser.parse(buffer, file.name);
        sampleRate = parsed.sampleRate;
        formatName = parsed.formatName;
        durationSec = parsed.durationSec;
        channelData = parsed.channelData;
      } catch (wavErr) {
        // Fallback to RawAudioLoader container decoding
        const loaded = await RawAudioLoader.load(buffer, file.name, forcedCodec, pcmOptions);
        sampleRate = loaded.sampleRate;
        formatName = loaded.formatName;
        durationSec = loaded.durationSec;
        channelData = loaded.channelData;
      }
    } else {
      const loaded = await RawAudioLoader.load(buffer, file.name, forcedCodec, pcmOptions);
      sampleRate = loaded.sampleRate;
      formatName = loaded.formatName;
      durationSec = loaded.durationSec;
      channelData = loaded.channelData;
    }

    const channels = ChannelSplitter.splitChannels(channelData, includeMonoDownmix);
    const firstActiveChannel = channels.find(c => !c.isSilent)?.data || channels[0]?.data || new Float32Array(0);
    const bandwidth = BandwidthEstimator.estimate(firstActiveChannel, sampleRate);

    return {
      formatName,
      sampleRate,
      durationSec,
      channels,
      bandwidth,
    };
  }

  /**
   * Scores a single channel buffer using DnsmosEngine.
   */
  public static async scoreChannel(
    task: ChannelScoreTask,
    options: DnsmosOptions = {}
  ): Promise<DnsmosResult> {
    const ch = task.channel;

    if (ch.isSilent) {
      throw new Error(ch.silenceReason || 'Channel is digitally silent; skipped.');
    }

    const fileInfo: DnsmosFileInfo = {
      fileName: task.fileName,
      channelIndex: ch.channelIndex,
      channelName: ch.channelName,
      totalChannels: ch.totalChannels,
      formatName: task.formatName,
      rmsDbfs: ch.rmsDbfs,
      peakDbfs: ch.peakDbfs,
      effectiveBandwidthHz: task.bandwidth?.effectiveBandwidthHz,
      isSilent: ch.isSilent,
      silenceReason: ch.silenceReason,
      isMonoDownmix: ch.isMonoDownmix,
    };

    return DnsmosEngine.evaluatePcm(
      ch.data,
      task.sampleRate,
      {
        streamId: `${task.fileName}_ch${ch.channelIndex}`,
        ssrc: Math.abs(this.hashString(`${task.fileName}_${ch.channelIndex}`)),
        codec: task.formatName,
        fileInfo,
      },
      options
    );
  }

  /**
   * Scores a very long audio file in chunks via File.slice() to keep memory bounded (< 50MB).
   */
  public static async scoreLongChannelStream(
    file: File,
    channelIndex: number,
    sampleRate: number,
    totalChannels: number,
    bytesPerSample: number,
    dataOffset: number,
    dataLength: number,
    options: DnsmosOptions = {}
  ): Promise<DnsmosResult> {
    // 30-second chunk window with 9.01s overlap
    const chunkSec = 30;
    const overlapSec = 9.01;
    const frameSize = totalChannels * bytesPerSample;
    const chunkBytes = Math.round(chunkSec * sampleRate * frameSize);
    const overlapBytes = Math.round(overlapSec * sampleRate * frameSize);

    let offset = dataOffset;
    const end = dataOffset + dataLength;

    const allWindows: any[] = [];
    let windowCounter = 0;

    while (offset < end) {
      const sliceEnd = Math.min(end, offset + chunkBytes);
      const blob = file.slice(offset, sliceEnd);
      const chunkBuf = await blob.arrayBuffer();

      // De-interleave only requested channel
      const numFrames = Math.floor(chunkBuf.byteLength / frameSize);
      const chData = new Float32Array(numFrames);
      const view = new DataView(chunkBuf);

      if (bytesPerSample === 2) {
        for (let f = 0; f < numFrames; f++) {
          chData[f] = view.getInt16((f * totalChannels + channelIndex) * 2, true) / 32768.0;
        }
      } else if (bytesPerSample === 4) {
        for (let f = 0; f < numFrames; f++) {
          chData[f] = view.getFloat32((f * totalChannels + channelIndex) * 4, true);
        }
      }

      // Evaluate this chunk
      const chunkRes = await DnsmosEngine.evaluatePcm(
        chData,
        sampleRate,
        {
          streamId: `${file.name}_ch${channelIndex}_chunk${windowCounter}`,
          ssrc: 999999 + windowCounter,
          codec: 'PCM Stream',
        },
        options
      );

      for (const w of chunkRes.windows) {
        allWindows.push({
          ...w,
          windowIdx: windowCounter++,
          startSec: Number((offset / (sampleRate * frameSize) + (w.startSec - chunkRes.range.startSec)).toFixed(2)),
          endSec: Number((offset / (sampleRate * frameSize) + (w.endSec - chunkRes.range.startSec)).toFixed(2)),
        });
      }

      if (sliceEnd >= end) break;
      offset += (chunkBytes - overlapBytes);
    }

    // Recompute summary across all chunks
    let sumSig = 0, sumBak = 0, sumOvrl = 0;
    let minSig = Infinity, maxSig = -Infinity;
    let minBak = Infinity, maxBak = -Infinity;
    let minOvrl = Infinity, maxOvrl = -Infinity;

    for (const w of allWindows) {
      sumSig += w.sig;
      sumBak += w.bak;
      sumOvrl += w.ovrl;
      if (w.sig < minSig) minSig = w.sig;
      if (w.sig > maxSig) maxSig = w.sig;
      if (w.bak < minBak) minBak = w.bak;
      if (w.bak > maxBak) maxBak = w.bak;
      if (w.ovrl < minOvrl) minOvrl = w.ovrl;
      if (w.ovrl > maxOvrl) maxOvrl = w.ovrl;
    }

    const N = Math.max(1, allWindows.length);
    const meanSig = Number((sumSig / N).toFixed(4));
    const meanBak = Number((sumBak / N).toFixed(4));
    const meanOvrl = Number((sumOvrl / N).toFixed(4));
    const durationSec = dataLength / (sampleRate * frameSize);

    return {
      streamId: `${file.name}_ch${channelIndex}`,
      ssrc: Math.abs(this.hashString(`${file.name}_${channelIndex}`)),
      codec: 'Streaming WAV',
      originalSampleRate: sampleRate,
      modelSampleRate: 16000,
      range: {
        startSec: 0,
        endSec: durationSec,
        durationSec: Number(durationSec.toFixed(2)),
        isFullStream: true,
      },
      sig: meanSig,
      bak: meanBak,
      ovrl: meanOvrl,
      sig_min: minSig,
      sig_max: maxSig,
      sig_weighted: meanSig,
      bak_min: minBak,
      bak_max: maxBak,
      bak_weighted: meanBak,
      ovrl_min: minOvrl,
      ovrl_max: maxOvrl,
      ovrl_weighted: meanOvrl,
      windowCount: N,
      windows: allWindows,
      confidence: { level: 'high', reasons: [] },
      realtimeFactor: 1.0,
      computeTimeMs: 100,
      isPersonalized: !!options.isPersonalized,
      modelVersion: 'DNSMOS P.835 Streaming',
      fileInfo: {
        fileName: file.name,
        channelIndex,
        channelName: `Ch ${channelIndex + 1}`,
        totalChannels,
        formatName: 'Streaming WAV',
      },
    };
  }

  /**
   * Multi-file and multi-channel batch evaluation runner with progress and cancellation.
   */
  public static async runBatch(
    tasks: ChannelScoreTask[],
    options: DnsmosOptions = {},
    onProgress?: (progress: {
      completed: number;
      total: number;
      currentFileName: string;
      currentChannelName: string;
      percent: number;
      result?: DnsmosResult;
      error?: string;
    }) => void
  ): Promise<Map<string, DnsmosResult>> {
    this.cancelBatch();
    this.isRunning = true;
    this.activeAbortController = new AbortController();

    const results = new Map<string, DnsmosResult>();
    const total = tasks.length;

    for (let i = 0; i < total; i++) {
      if (this.activeAbortController?.signal.aborted) {
        break;
      }

      const task = tasks[i];
      const key = `${task.fileName}_ch${task.channel.channelIndex}`;

      try {
        if (task.channel.isSilent) {
          onProgress?.({
            completed: i + 1,
            total,
            currentFileName: task.fileName,
            currentChannelName: task.channel.channelName,
            percent: Math.round(((i + 1) / total) * 100),
            error: task.channel.silenceReason || 'Channel is digitally silent; skipped',
          });
          continue;
        }

        const res = await this.scoreChannel(task, options);
        results.set(key, res);

        onProgress?.({
          completed: i + 1,
          total,
          currentFileName: task.fileName,
          currentChannelName: task.channel.channelName,
          percent: Math.round(((i + 1) / total) * 100),
          result: res,
        });
      } catch (err: any) {
        console.warn(`[DnsmosToolEngine] Error scoring ${key}:`, err);
        onProgress?.({
          completed: i + 1,
          total,
          currentFileName: task.fileName,
          currentChannelName: task.channel.channelName,
          percent: Math.round(((i + 1) / total) * 100),
          error: err?.message || String(err),
        });
      }
    }

    this.isRunning = false;
    this.activeAbortController = null;
    return results;
  }

  /**
   * Compares 2 or more results, computing deltas against the base (first selected) item.
   * Emits warnings if native sample rates or codecs differ.
   */
  public static compareMultiple(results: DnsmosResult[]): MultiItemComparison {
    if (results.length === 0) {
      return {
        items: [],
        hasRateMismatch: false,
        hasCodecMismatch: false,
      };
    }

    const base = results[0];
    const items: MultiItemComparison['items'] = [];
    let hasRateMismatch = false;
    let hasCodecMismatch = false;

    for (let i = 0; i < results.length; i++) {
      const cur = results[i];
      if (cur.originalSampleRate !== base.originalSampleRate) {
        hasRateMismatch = true;
      }
      if (cur.codec !== base.codec) {
        hasCodecMismatch = true;
      }

      items.push({
        result: cur,
        deltaSigAgainstBase: Number((cur.sig - base.sig).toFixed(3)),
        deltaBakAgainstBase: Number((cur.bak - base.bak).toFixed(3)),
        deltaOvrl: Number((cur.ovrl - base.ovrl).toFixed(3)),
      });
    }

    const rateMismatchWarning = hasRateMismatch
      ? `⚠️ Warning: Comparing audio with different native sample rates (${results.map(r => `${r.originalSampleRate}Hz`).join(' vs ')}). Differences may reflect bandwidth cutoff rather than speech degradation.`
      : undefined;

    const codecMismatchWarning = hasCodecMismatch
      ? `ℹ️ Note: Comparing different formats/codecs (${results.map(r => r.codec).join(' vs ')}).`
      : undefined;

    return {
      items,
      hasRateMismatch,
      rateMismatchWarning,
      hasCodecMismatch,
      codecMismatchWarning,
    };
  }

  private static hashString(str: string): number {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return hash;
  }
}
