import { StreamAudioDecoder } from '../decoders/StreamAudioDecoder.ts';
import { WavExporter } from './WavExporter.ts';
import type { RtpStream } from '../rtp/RtpDemuxer.ts';
import type { SipDialog } from '../sip/DialogManager.ts';
import type { Leg, Conversation } from '../ladder/LadderTypes.ts';

export interface TimeSelection {
  startSec: number;
  endSec: number;
}

export interface MultiTrack {
  id: string;
  ssrc: number;
  direction: 'inbound' | 'outbound';
  legId: string;
  codec: string;
  sampleRate: number;
  startTime: number; // Absolute PCAP seconds
  endTime: number;
  relativeStartTime: number; // Seconds from session start
  relativeEndTime: number;
  duration: number;
  srcEp: string;
  dstEp: string;
  srcPort: number;
  dstPort: number;
  packetCount: number;
  color: string;
  pcm16: Int16Array;
  peaks: number[];
  bitstream?: Uint8Array;
  bitstreamExt?: string;
  isMuted: boolean;
  isSolo: boolean;
  volume: number; // 0.0 to 1.0
  telephoneEvents?: Array<{ event: number; time: number; duration: number }>;
  // Web Audio runtime nodes
  audioBuffer?: any;
  sourceNode?: any;
  gainNode?: any;
}

const TRACK_PALETTE = [
  '#7aa2f7', // Soft Blue
  '#2ac3de', // Cyan
  '#e0af68', // Warm Amber/Yellow
  '#ff9e64', // Orange
  '#bb9af7', // Purple
  '#9d7cd8', // Deep Lavender
  '#f7768e', // Coral Red
  '#73daca', // Mint / Teal
  '#b4f9f8', // Ice Blue
  '#cfc9c2', // Cool Silver
];

export class MultiTrackPlayer {
  private ctx: any = null;
  private masterGain: any = null;
  private allTracks: MultiTrack[] = [];
  private tracks: MultiTrack[] = [];
  private conversations: Conversation[] = [];
  private currentConvFilter: string = 'all';
  private currentSortOrder: 'leg-pairs' | 'in-first' | 'out-first' | 'chronological' = 'leg-pairs';
  private globalStartTime: number = 0;
  private globalEndTime: number = 0;
  private totalDuration: number = 0;
  private playheadSec: number = 0;
  private startTimeOffset: number = 0;
  private isPlaying: boolean = false;
  private animFrameId: any = null;
  private masterVolume: number = 0.8;
  private selection: TimeSelection | null = null;
  private isLooping: boolean = false;

  public onTimeUpdate?: (currentSec: number, totalDurationSec: number) => void;
  public onTracksUpdated?: () => void;
  public onEnded?: () => void;

  constructor() {
    // Lazy AudioContext initialization
  }

  private initContext(): void {
    if (!this.ctx && typeof (globalThis as any).AudioContext !== 'undefined') {
      this.ctx = new (globalThis as any).AudioContext();
      this.masterGain = this.ctx.createGain();
      this.masterGain.gain.value = this.masterVolume;
      this.masterGain.connect(this.ctx.destination);
    }
  }

  /**
   * Initializes multi-track session from detected streams and SIP dialogs.
   */
  public async loadSession(
    streams: RtpStream[],
    dialogs: SipDialog[] = [],
    mediaServerIp: string = '',
    legs: Leg[] = [],
    conversations: Conversation[] = []
  ): Promise<void> {
    this.stop();
    this.allTracks = [];
    this.tracks = [];
    this.conversations = conversations;

    // Filter out trivial non-audio packet probes (<= 2 packets of unknown payload type)
    const validStreams = streams.filter(s => {
      if (s.packetCount <= 2) {
        const info = StreamAudioDecoder.resolveCodec(s, dialogs);
        if (info.normalizedCodec === 'UNKNOWN') return false;
      }
      return true;
    });

    if (validStreams.length === 0) {
      this.totalDuration = 0;
      this.playheadSec = 0;
      return;
    }

    // Determine global session boundaries
    this.globalStartTime = Math.min(...validStreams.map(s => s.startTime));
    this.globalEndTime = Math.max(...validStreams.map(s => s.endTime));
    this.totalDuration = Math.max(0.1, this.globalEndTime - this.globalStartTime);

    // Decode all streams and build tracks
    for (let i = 0; i < validStreams.length; i++) {
      const s = validStreams[i];
      try {
        const info = StreamAudioDecoder.resolveCodec(s, dialogs);

        // Determine leg association and direction
        let legId = `Stream ${this.allTracks.length + 1}`;
        let direction: 'inbound' | 'outbound' = 'inbound';

        const matchedLeg = legs.find(
          l => l.inboundStream?.ssrc === s.ssrc || l.outboundStream?.ssrc === s.ssrc
        );
        if (matchedLeg) {
          legId = matchedLeg.id;
          direction = matchedLeg.inboundStream?.ssrc === s.ssrc ? 'inbound' : 'outbound';
        } else if (mediaServerIp) {
          direction = s.dstIp === mediaServerIp ? 'inbound' : 'outbound';
        }

        // Decode PCM with silence padding so timestamps align with PCAP clock
        const decoded = await StreamAudioDecoder.decodeStream(s, dialogs, true);
        if (decoded.pcm.length === 0 && s.packetCount <= 5) {
          continue; // Skip probe packets that yield no audio
        }

        const relStart = Math.max(0, s.startTime - this.globalStartTime);
        const audioDuration = decoded.sampleRate > 0
          ? decoded.pcm.length / decoded.sampleRate
          : Math.max(0.02, s.endTime - s.startTime);
        const relEnd = Math.min(this.totalDuration, relStart + audioDuration);

        const peaks = MultiTrackPlayer.generateNormalizedPeaks(decoded.pcm, 300);

        this.allTracks.push({
          id: `track-${s.ssrc}`,
          ssrc: s.ssrc,
          direction,
          legId,
          codec: decoded.codec,
          sampleRate: decoded.sampleRate,
          startTime: s.startTime,
          endTime: s.endTime,
          relativeStartTime: relStart,
          relativeEndTime: relEnd,
          duration: s.endTime - s.startTime,
          srcEp: `${s.srcIp}:${s.srcPort}`,
          dstEp: `${s.dstIp}:${s.dstPort}`,
          srcPort: s.srcPort,
          dstPort: s.dstPort,
          packetCount: s.packetCount,
          color: TRACK_PALETTE[this.allTracks.length % TRACK_PALETTE.length],
          pcm16: decoded.pcm,
          peaks,
          bitstream: decoded.bitstream,
          bitstreamExt: decoded.bitstreamExt,
          telephoneEvents: s.telephoneEvents,
          isMuted: false,
          isSolo: false,
          volume: 1.0,
        });
      } catch (err) {
        console.warn(`[MultiTrackPlayer] Error decoding stream ${s.ssrc}:`, err);
      }
    }

    this.applyFilterAndSort();
    this.playheadSec = 0;
    this.onTracksUpdated?.();
  }

  public setConversationFilter(filter: string): void {
    if (this.currentConvFilter === filter) return;
    this.currentConvFilter = filter;
    const wasPlaying = this.isPlaying;
    if (wasPlaying) {
      this.stopActiveSources();
    }
    this.applyFilterAndSort();
    if (wasPlaying) {
      this.play();
    }
    this.onTracksUpdated?.();
  }

  public getConversationFilter(): string {
    return this.currentConvFilter;
  }

  public setSortOrder(order: 'leg-pairs' | 'in-first' | 'out-first' | 'chronological'): void {
    if (this.currentSortOrder === order) return;
    this.currentSortOrder = order;
    this.applyFilterAndSort();
    this.onTracksUpdated?.();
  }

  public getSortOrder(): 'leg-pairs' | 'in-first' | 'out-first' | 'chronological' {
    return this.currentSortOrder;
  }

  public getAllTracks(): MultiTrack[] {
    return this.allTracks;
  }

  private applyFilterAndSort(): void {
    let result = [...this.allTracks];

    // 1. Filter by conversation if specified
    if (this.currentConvFilter !== 'all' && this.conversations.length > 0) {
      const idx = parseInt(this.currentConvFilter, 10);
      const conv = !isNaN(idx)
        ? this.conversations[idx]
        : this.conversations.find(c => c.id === this.currentConvFilter);

      if (conv && conv.legs && conv.legs.length > 0) {
        const ssrcSet = new Set<number>();
        for (const leg of conv.legs) {
          if (leg.inboundStream) ssrcSet.add(leg.inboundStream.ssrc);
          if (leg.outboundStream) ssrcSet.add(leg.outboundStream.ssrc);
        }
        const filtered = this.allTracks.filter(t => ssrcSet.has(t.ssrc));
        if (filtered.length > 0) {
          result = filtered;
        }
      }
    }

    // 2. Sort tracks according to currentSortOrder
    result.sort((a, b) => {
      if (this.currentSortOrder === 'leg-pairs') {
        const legCmp = a.legId.localeCompare(b.legId, undefined, { numeric: true, sensitivity: 'base' });
        if (legCmp !== 0) return legCmp;
        if (a.direction !== b.direction) {
          return a.direction === 'inbound' ? -1 : 1;
        }
        return a.startTime - b.startTime;
      } else if (this.currentSortOrder === 'in-first') {
        if (a.direction !== b.direction) {
          return a.direction === 'inbound' ? -1 : 1;
        }
        const legCmp = a.legId.localeCompare(b.legId, undefined, { numeric: true, sensitivity: 'base' });
        if (legCmp !== 0) return legCmp;
        return a.startTime - b.startTime;
      } else if (this.currentSortOrder === 'out-first') {
        if (a.direction !== b.direction) {
          return a.direction === 'outbound' ? -1 : 1;
        }
        const legCmp = a.legId.localeCompare(b.legId, undefined, { numeric: true, sensitivity: 'base' });
        if (legCmp !== 0) return legCmp;
        return a.startTime - b.startTime;
      } else {
        // chronological
        return a.startTime - b.startTime;
      }
    });

    this.tracks = result;
  }

  public setSelection(startSec: number, endSec: number): void {
    if (this.totalDuration <= 0) return;
    const clamped1 = Math.max(0, Math.min(this.totalDuration, startSec));
    const clamped2 = Math.max(0, Math.min(this.totalDuration, endSec));
    const s1 = Math.min(clamped1, clamped2);
    const s2 = Math.max(clamped1, clamped2);

    if (s2 - s1 < 0.05) {
      this.selection = null;
    } else {
      this.selection = { startSec: s1, endSec: s2 };
      this.playheadSec = s1;
    }
    this.onTimeUpdate?.(this.playheadSec, this.totalDuration);
  }

  public getSelection(): TimeSelection | null {
    return this.selection;
  }

  public clearSelection(): void {
    this.selection = null;
    this.onTimeUpdate?.(this.playheadSec, this.totalDuration);
  }

  public setIsLooping(loop: boolean): void {
    this.isLooping = loop;
  }

  public getIsLooping(): boolean {
    return this.isLooping;
  }

  public getTracks(): MultiTrack[] {
    return this.tracks;
  }

  public getTotalDuration(): number {
    return this.totalDuration;
  }

  public getCurrentTime(): number {
    if (!this.ctx || !this.isPlaying) return this.playheadSec;
    const elapsed = this.ctx.currentTime - this.startTimeOffset;
    return Math.min(this.totalDuration, Math.max(0, elapsed));
  }

  public getIsPlaying(): boolean {
    return this.isPlaying;
  }

  public play(): void {
    this.initContext();
    if (!this.ctx || this.tracks.length === 0) return;

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.stopActiveSources();

    let startSec = this.playheadSec;
    let stopSec = this.totalDuration;

    if (this.selection && this.selection.endSec > this.selection.startSec) {
      if (startSec < this.selection.startSec || startSec >= this.selection.endSec) {
        startSec = this.selection.startSec;
        this.playheadSec = startSec;
      }
      stopSec = this.selection.endSec;
    } else {
      if (startSec >= this.totalDuration) {
        startSec = 0;
        this.playheadSec = 0;
      }
    }

    const cur = startSec;
    const now = this.ctx.currentTime;
    this.startTimeOffset = now - cur;

    const hasSolo = this.tracks.some(t => t.isSolo);

    for (const track of this.tracks) {
      // Determine effective volume
      let effectiveVol = track.volume;
      if (hasSolo) {
        effectiveVol = track.isSolo ? track.volume : 0;
      } else if (track.isMuted) {
        effectiveVol = 0;
      }

      // Check if track is active during remaining session
      const trackStart = track.relativeStartTime;
      const trackDur = track.pcm16.length / track.sampleRate;
      const trackEnd = trackStart + trackDur;

      if (cur >= trackEnd || trackStart >= stopSec) continue; // Track finished or starts after stopSec

      // Ensure AudioBuffer exists
      if (!track.audioBuffer) {
        const floatData = new Float32Array(track.pcm16.length);
        for (let j = 0; j < track.pcm16.length; j++) {
          floatData[j] = track.pcm16[j] / 32768.0;
        }
        track.audioBuffer = this.ctx.createBuffer(1, floatData.length, track.sampleRate);
        track.audioBuffer.copyToChannel(floatData, 0);
      }

      const source = this.ctx.createBufferSource();
      source.buffer = track.audioBuffer;

      const gain = this.ctx.createGain();
      gain.gain.value = effectiveVol;
      source.connect(gain).connect(this.masterGain);

      track.sourceNode = source;
      track.gainNode = gain;

      let startDelay = 0;
      let trackOffset = 0;

      if (cur < trackStart) {
        startDelay = trackStart - cur;
        trackOffset = 0;
      } else {
        startDelay = 0;
        trackOffset = cur - trackStart;
      }

      const trackRemaining = trackDur - trackOffset;
      const maxPlaySec = stopSec - Math.max(cur, trackStart);
      const playDuration = Math.min(trackRemaining, maxPlaySec);

      if (playDuration > 0) {
        source.start(now + startDelay, trackOffset, playDuration);
      }
    }

    this.isPlaying = true;
    this.startProgressTicker();
  }

  public pause(): void {
    if (!this.isPlaying) return;
    this.playheadSec = this.getCurrentTime();
    this.stopActiveSources();
    this.isPlaying = false;
    this.stopProgressTicker();
    this.onTimeUpdate?.(this.playheadSec, this.totalDuration);
  }

  public stop(): void {
    this.stopActiveSources();
    this.isPlaying = false;
    this.playheadSec = 0;
    this.stopProgressTicker();
    this.onTimeUpdate?.(0, this.totalDuration);
  }

  public seek(targetSec: number): void {
    const wasPlaying = this.isPlaying;
    this.stopActiveSources();
    this.playheadSec = Math.max(0, Math.min(this.totalDuration, targetSec));

    if (wasPlaying) {
      this.play();
    } else {
      this.onTimeUpdate?.(this.playheadSec, this.totalDuration);
    }
  }

  public setTrackMute(ssrc: number, isMuted: boolean): void {
    const t = this.allTracks.find(tr => tr.ssrc === ssrc) || this.tracks.find(tr => tr.ssrc === ssrc);
    if (!t) return;
    t.isMuted = isMuted;
    this.updateGainNodes();
    this.onTracksUpdated?.();
  }

  public setTrackSolo(ssrc: number, isSolo: boolean): void {
    const t = this.allTracks.find(tr => tr.ssrc === ssrc) || this.tracks.find(tr => tr.ssrc === ssrc);
    if (!t) return;
    t.isSolo = isSolo;
    this.updateGainNodes();
    this.onTracksUpdated?.();
  }

  public soloSingleStreamAndPlay(ssrc: number): void {
    if (!this.tracks.some(t => t.ssrc === ssrc)) {
      this.currentConvFilter = 'all';
      this.applyFilterAndSort();
    }
    for (const t of this.tracks) {
      t.isSolo = t.ssrc === ssrc;
      t.isMuted = false;
    }
    this.updateGainNodes();
    this.onTracksUpdated?.();
    this.play();
  }

  public muteAll(muted: boolean = true): void {
    for (const t of this.allTracks) {
      t.isMuted = muted;
      t.isSolo = false;
    }
    this.updateGainNodes();
    this.onTracksUpdated?.();
  }

  public filterByDirection(direction: 'inbound' | 'outbound'): void {
    for (const t of this.allTracks) {
      t.isSolo = false;
      t.isMuted = t.direction !== direction;
    }
    this.updateGainNodes();
    this.onTracksUpdated?.();
  }

  public setMasterVolume(vol: number): void {
    this.masterVolume = Math.max(0, Math.min(1, vol));
    if (this.masterGain) {
      this.masterGain.gain.value = this.masterVolume;
    }
  }

  private updateGainNodes(): void {
    const hasSolo = this.tracks.some(t => t.isSolo);
    for (const t of this.tracks) {
      if (t.gainNode) {
        let vol = t.volume;
        if (hasSolo) {
          vol = t.isSolo ? t.volume : 0;
        } else if (t.isMuted) {
          vol = 0;
        }
        t.gainNode.gain.value = vol;
      }
    }
  }

  private stopActiveSources(): void {
    for (const t of this.tracks) {
      if (t.sourceNode) {
        try {
          t.sourceNode.onended = null;
          t.sourceNode.stop();
          t.sourceNode.disconnect();
        } catch {}
        t.sourceNode = null;
      }
      if (t.gainNode) {
        try {
          t.gainNode.disconnect();
        } catch {}
        t.gainNode = null;
      }
    }
  }

  private startProgressTicker(): void {
    this.stopProgressTicker();
    const tick = () => {
      if (this.isPlaying) {
        const cur = this.getCurrentTime();
        const limitSec = (this.selection && this.selection.endSec > this.selection.startSec)
          ? this.selection.endSec
          : this.totalDuration;

        if (cur >= limitSec) {
          if (this.isLooping) {
            const restartSec = this.selection ? this.selection.startSec : 0;
            this.seek(restartSec);
            return;
          }
          this.pause();
          this.playheadSec = this.selection ? this.selection.startSec : this.totalDuration;
          this.onTimeUpdate?.(this.playheadSec, this.totalDuration);
          this.onEnded?.();
          return;
        }
        this.onTimeUpdate?.(cur, this.totalDuration);
        if (typeof (globalThis as any).requestAnimationFrame !== 'undefined') {
          this.animFrameId = (globalThis as any).requestAnimationFrame(tick);
        }
      }
    };

    if (typeof (globalThis as any).requestAnimationFrame !== 'undefined') {
      this.animFrameId = (globalThis as any).requestAnimationFrame(tick);
    }
  }

  private stopProgressTicker(): void {
    if (this.animFrameId !== null && typeof (globalThis as any).cancelAnimationFrame !== 'undefined') {
      (globalThis as any).cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
  }

  /**
   * Generates amplitude peaks for rendering track waveforms.
   */
  public static generateNormalizedPeaks(pcm16: Int16Array, buckets: number = 300): number[] {
    if (pcm16.length === 0 || buckets <= 0) return new Array(buckets).fill(0);
    const peaks = new Array(buckets);
    const step = Math.floor(pcm16.length / buckets);

    for (let b = 0; b < buckets; b++) {
      const start = b * step;
      const end = Math.min(pcm16.length, start + step);
      let max = 0;
      for (let i = start; i < end; i++) {
        const abs = Math.abs(pcm16[i]);
        if (abs > max) max = abs;
      }
      peaks[b] = Math.min(1.0, max / 32768.0);
    }
    return peaks;
  }

  /**
   * Exports all currently active (unmuted & solo-respected) tracks as a mixed 16-bit linear PCM WAV.
   * If a timeRange or selection is active, exports only the selected slice.
   */
  public exportMixedWav(timeRange?: TimeSelection): Uint8Array {
    if (this.tracks.length === 0 || this.totalDuration <= 0) {
      return new Uint8Array(0);
    }

    const range = timeRange || this.selection;
    const startSec = range ? range.startSec : 0;
    const endSec = range ? range.endSec : this.totalDuration;
    const durationSec = Math.max(0.01, endSec - startSec);

    const mixSampleRate = 16000;
    const totalSamples = Math.ceil(durationSec * mixSampleRate);
    const mixedFloat = new Float32Array(totalSamples);

    const hasSolo = this.tracks.some(t => t.isSolo);
    const activeTracks = this.tracks.filter(t => (hasSolo ? t.isSolo : !t.isMuted));

    if (activeTracks.length === 0) {
      return WavExporter.encodeWav([new Int16Array(totalSamples)], mixSampleRate, 16);
    }

    for (const t of activeTracks) {
      const trackStartInSelection = t.relativeStartTime - startSec;
      const trackOffsetSamples = Math.round(trackStartInSelection * mixSampleRate);
      const ratio = mixSampleRate / t.sampleRate;
      const outTrackLen = Math.round(t.pcm16.length * ratio);

      for (let i = 0; i < outTrackLen; i++) {
        const destIdx = trackOffsetSamples + i;
        if (destIdx < 0) continue;
        if (destIdx >= totalSamples) break;

        const srcPos = i / ratio;
        const idx0 = Math.floor(srcPos);
        const frac = srcPos - idx0;
        const s0 = t.pcm16[idx0] || 0;
        const s1 = t.pcm16[Math.min(idx0 + 1, t.pcm16.length - 1)] || 0;
        const interpolated = s0 + frac * (s1 - s0);

        mixedFloat[destIdx] += (interpolated / 32768.0) * t.volume;
      }
    }

    // Convert mixed float to 16-bit PCM with soft limiting
    const mixedPcm16 = new Int16Array(totalSamples);
    for (let i = 0; i < totalSamples; i++) {
      const v = Math.max(-1.0, Math.min(1.0, mixedFloat[i]));
      mixedPcm16[i] = Math.round(v * 32767);
    }

    return WavExporter.encodeWav([mixedPcm16], mixSampleRate, 16);
  }
}
