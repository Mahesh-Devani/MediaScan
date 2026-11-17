/**
 * EditorClipboard.ts
 * App-wide shared clipboard for audio pieces across clip tabs.
 * Stores audio channel data, sample rate, bit depth, and metadata.
 */

import { AudioBufferPool } from './AudioBufferPool.ts';
import { AudioPreprocessor } from '../../codec/AudioPreprocessor.ts';

export interface ClipboardItem {
  channels: Float32Array[];
  sampleRate: number;
  numChannels: number;
  bitDepth: number;
  lengthSamples: number;
  timestamp: number;
  sourceClipName: string;
}

export class EditorClipboard {
  private static instance: EditorClipboard;
  private currentItem: ClipboardItem | null = null;
  private onClipboardChangeListeners: Array<(hasContent: boolean) => void> = [];

  public static getInstance(): EditorClipboard {
    if (!this.instance) {
      this.instance = new EditorClipboard();
    }
    return this.instance;
  }

  public get hasContent(): boolean {
    return this.currentItem !== null && this.currentItem.lengthSamples > 0;
  }

  public getItem(): ClipboardItem | null {
    return this.currentItem;
  }

  /**
   * Set clipboard contents from contiguous channel data.
   */
  public copy(
    channels: Float32Array[],
    sampleRate: number,
    bitDepth: number,
    sourceClipName: string
  ): void {
    if (!channels || channels.length === 0 || channels[0].length === 0) {
      return;
    }

    // Clone channels to decouple from any pool or tab lifecycle
    const clonedChannels: Float32Array[] = channels.map(ch => new Float32Array(ch));
    const lengthSamples = clonedChannels[0].length;

    this.currentItem = {
      channels: clonedChannels,
      sampleRate,
      numChannels: clonedChannels.length,
      bitDepth,
      lengthSamples,
      timestamp: Date.now(),
      sourceClipName
    };

    this.notifyListeners();
  }

  /**
   * Paste into target clip format.
   * If sample rates or channel layouts differ, converts to target format and returns conversion notice.
   */
  public pasteForTarget(
    targetSampleRate: number,
    targetNumChannels: number,
    targetPool: AudioBufferPool
  ): {
    bufferId: string;
    lengthSamples: number;
    notice?: string;
  } | null {
    if (!this.currentItem) return null;

    let srcChannels = this.currentItem.channels.map(ch => new Float32Array(ch));
    let srcRate = this.currentItem.sampleRate;
    const notices: string[] = [];

    // 1. Resample if sample rate differs
    if (srcRate !== targetSampleRate) {
      srcChannels = srcChannels.map(ch =>
        new Float32Array(AudioPreprocessor.resample(ch, srcRate, targetSampleRate))
      );
      notices.push(`Resampled ${srcRate.toLocaleString()} Hz → ${targetSampleRate.toLocaleString()} Hz`);
    }

    // 2. Channel adaptation
    if (srcChannels.length !== targetNumChannels) {
      if (srcChannels.length === 1 && targetNumChannels === 2) {
        // Mono to stereo: duplicate
        srcChannels = [new Float32Array(srcChannels[0]), new Float32Array(srcChannels[0])];
        notices.push('Upmixed mono → stereo');
      } else if (srcChannels.length === 2 && targetNumChannels === 1) {
        // Stereo to mono: average downmix
        const left = srcChannels[0];
        const right = srcChannels[1];
        const mono = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) {
          mono[i] = (left[i] + right[i]) * 0.5;
        }
        srcChannels = [mono];
        notices.push('Downmixed stereo → mono');
      } else if (srcChannels.length > targetNumChannels) {
        srcChannels = srcChannels.slice(0, targetNumChannels);
        notices.push(`Truncated ${srcChannels.length} ch → ${targetNumChannels} ch`);
      } else {
        while (srcChannels.length < targetNumChannels) {
          srcChannels.push(new Float32Array(srcChannels[0]));
        }
      }
    }

    const lengthSamples = srcChannels[0].length;
    const bufferId = targetPool.registerBuffer(
      srcChannels,
      targetSampleRate,
      this.currentItem.bitDepth,
      `paste-${this.currentItem.sourceClipName}`
    );

    return {
      bufferId,
      lengthSamples,
      notice: notices.length > 0 ? notices.join('; ') : undefined
    };
  }

  public addListener(listener: (hasContent: boolean) => void): () => void {
    this.onClipboardChangeListeners.push(listener);
    return () => {
      this.onClipboardChangeListeners = this.onClipboardChangeListeners.filter(l => l !== listener);
    };
  }

  private notifyListeners(): void {
    const has = this.hasContent;
    for (const listener of this.onClipboardChangeListeners) {
      try { listener(has); } catch {}
    }
  }

  public clear(): void {
    this.currentItem = null;
    this.notifyListeners();
  }
}
