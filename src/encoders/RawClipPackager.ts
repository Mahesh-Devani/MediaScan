/**
 * RawClipPackager.ts
 * Assembles encoded frames into standardized raw storage files matching the reference
 * clip formats (magic headers, channel count, octet sequences) and computes detailed clip telemetry.
 */

import type { CodecProfile, AudioBandwidth } from '../codec/CodecProfileRegistry.ts';

export interface FrameClassification {
  type: 'speech' | 'sid' | 'nodata';
  payloadBytes: number;
}

export interface ClipTelemetry {
  codecId: string;
  totalBytes: number;
  headerBytes: number;
  frameCount: number;
  durationSec: number;
  averageBitrateKbps: number;
  peakBitrateKbps: number;
  speechFrames: number;
  sidFrames: number;
  noDataFrames: number;
  speechPercentage: number;
  silencePercentage: number;
  sampleRate: number;
  bandwidth: AudioBandwidth;
}

export interface PackagedClip {
  data: Uint8Array;
  telemetry: ClipTelemetry;
  suggestedFilename: string;
}

export class RawClipPackager {
  /**
   * Assembles a sequence of raw or ToC-prefixed frames into a complete raw container file.
   * Prepends container magic headers (e.g. #!AMR\n, #!AMR-WB\n, #!EVS_MC1.0\n + channel count).
   */
  public static package(
    profile: CodecProfile,
    frames: Uint8Array[],
    options: {
      baseFilename?: string;
      modeRateLabel?: string;
      dtxEnabled?: boolean;
      bandwidth?: AudioBandwidth;
      frameClassifier?: (frame: Uint8Array, index: number) => FrameClassification;
    } = {}
  ): PackagedClip {
    // 1. Calculate header size
    let headerSize = 0;
    if (profile.fileMagic) {
      headerSize += profile.fileMagic.length;
    }
    if (profile.channelCountHeader) {
      headerSize += 4; // 4-byte BE integer (1 channel = 0x00 0x00 0x00 0x01)
    }

    // 2. Calculate total body size
    let totalBodyBytes = 0;
    for (let i = 0; i < frames.length; i++) {
      totalBodyBytes += frames[i].length;
    }

    // 3. Allocate and assemble buffer
    const out = new Uint8Array(headerSize + totalBodyBytes);
    let offset = 0;

    if (profile.fileMagic) {
      out.set(profile.fileMagic, offset);
      offset += profile.fileMagic.length;
    }

    if (profile.channelCountHeader) {
      // Big-endian 32-bit integer: 1 channel
      out[offset] = 0;
      out[offset + 1] = 0;
      out[offset + 2] = 0;
      out[offset + 3] = 1;
      offset += 4;
    }

    let speechFrames = 0;
    let sidFrames = 0;
    let noDataFrames = 0;
    let maxFrameBytes = 0;

    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      out.set(f, offset);
      offset += f.length;

      if (f.length > maxFrameBytes) {
        maxFrameBytes = f.length;
      }

      if (options.frameClassifier) {
        const cls = options.frameClassifier(f, i);
        if (cls.type === 'speech') speechFrames++;
        else if (cls.type === 'sid') sidFrames++;
        else if (cls.type === 'nodata') noDataFrames++;
      } else {
        // Default classification based on length if frame is non-zero
        if (f.length === 0 || (f.length === 1 && f[0] === 0x7c)) {
          noDataFrames++;
        } else if (f.length <= 6 && (f[0] === 0x44 || f[0] === 0x4c || f[0] === 0x0c || f[0] === 0x39)) {
          sidFrames++;
        } else {
          speechFrames++;
        }
      }
    }

    const frameCount = frames.length;
    const durationSec = frameCount > 0 ? (frameCount * profile.frameDurationMs) / 1000 : 0;
    const totalBytes = out.length;
    const averageBitrateKbps = durationSec > 0 ? ((totalBodyBytes * 8) / (durationSec * 1000)) : 0;
    const peakBitrateKbps = profile.frameDurationMs > 0
      ? (maxFrameBytes * 8) / (profile.frameDurationMs / 1000) / 1000
      : averageBitrateKbps;

    const speechPercentage = frameCount > 0 ? (speechFrames / frameCount) * 100 : 100;
    const silencePercentage = frameCount > 0 ? ((sidFrames + noDataFrames) / frameCount) * 100 : 0;

    const telemetry: ClipTelemetry = {
      codecId: profile.id,
      totalBytes,
      headerBytes: headerSize,
      frameCount,
      durationSec,
      averageBitrateKbps: Math.round(averageBitrateKbps * 100) / 100,
      peakBitrateKbps: Math.round(peakBitrateKbps * 100) / 100,
      speechFrames,
      sidFrames,
      noDataFrames,
      speechPercentage: Math.round(speechPercentage * 10) / 10,
      silencePercentage: Math.round(silencePercentage * 10) / 10,
      sampleRate: profile.sampleRate,
      bandwidth: options.bandwidth || profile.bandwidth,
    };

    // Format suggested filename
    const base = options.baseFilename || 'speech';
    const suggestedFilename = this.formatSuggestedFilename(profile, base, {
      rateLabel: options.modeRateLabel,
      dtx: options.dtxEnabled,
      band: options.bandwidth,
    });

    return {
      data: out,
      telemetry,
      suggestedFilename,
    };
  }

  /**
   * Helper to format filename according to codec template.
   */
  public static formatSuggestedFilename(
    profile: CodecProfile,
    base: string,
    options: {
      rateLabel?: string;
      dtx?: boolean;
      band?: AudioBandwidth;
    } = {}
  ): string {
    const cleanBase = base.replace(/\.[^/.]+$/, '');
    const band = options.band || profile.bandwidth;
    const rate = options.rateLabel || profile.modes[profile.defaultModeIndex]?.rateLabel || '';
    const dtx = options.dtx ? 'dtx' : '';
    const ext = profile.fileExtension;

    let filename = profile.filenameTemplate
      .replace('{base}', cleanBase)
      .replace('{CODEC}', profile.name.split(' ')[0].toUpperCase())
      .replace('{band}', band)
      .replace('{rate}', rate)
      .replace('{dtx}', dtx)
      .replace('{ext}', ext);

    filename = filename.replace(/\.{2,}/g, '.');
    return filename;
  }
}
