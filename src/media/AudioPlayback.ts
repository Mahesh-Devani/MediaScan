export class AudioPlayback {
  private ctx: any = null;
  private source: any = null;
  private gainNode: any = null;
  private audioBuffer: any = null;
  private startTime: number = 0;
  private pauseOffset: number = 0;
  private isPlaying: boolean = false;
  private updateTimer: any = null;

  public onTimeUpdate?: (currentTimeSec: number, durationSec: number) => void;
  public onEnded?: () => void;

  constructor() {
    // Lazy AudioContext initialization on user gesture
  }

  private initContext(): void {
    if (!this.ctx && typeof (globalThis as any).AudioContext !== 'undefined') {
      this.ctx = new (globalThis as any).AudioContext();
      this.gainNode = this.ctx.createGain();
      this.gainNode.connect(this.ctx.destination);
    }
  }

  public loadPcm16(pcm16: Int16Array, sampleRate: number = 8000): void {
    this.initContext();
    if (!this.ctx) return;

    this.stop();
    this.pauseOffset = 0;

    const floatData = new Float32Array(pcm16.length);
    for (let i = 0; i < pcm16.length; i++) {
      floatData[i] = pcm16[i] / 32768.0;
    }

    this.audioBuffer = this.ctx.createBuffer(1, floatData.length, sampleRate);
    this.audioBuffer.copyToChannel(floatData, 0);
  }

  public loadStereoPcm16(left: Int16Array, right: Int16Array, sampleRate: number = 8000): void {
    this.initContext();
    if (!this.ctx) return;

    this.stop();
    this.pauseOffset = 0;

    const maxLen = Math.max(left.length, right.length);
    const floatL = new Float32Array(maxLen);
    const floatR = new Float32Array(maxLen);

    for (let i = 0; i < left.length; i++) floatL[i] = left[i] / 32768.0;
    for (let i = 0; i < right.length; i++) floatR[i] = right[i] / 32768.0;

    this.audioBuffer = this.ctx.createBuffer(2, maxLen, sampleRate);
    this.audioBuffer.copyToChannel(floatL, 0);
    this.audioBuffer.copyToChannel(floatR, 1);
  }

  public play(): void {
    this.initContext();
    if (!this.ctx || !this.audioBuffer) return;

    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
      } catch {}
      this.source = null;
    }

    if (this.ctx.state === 'suspended') {
      this.ctx.resume();
    }

    this.source = this.ctx.createBufferSource();
    this.source.buffer = this.audioBuffer;
    this.source.connect(this.gainNode);

    const currentSource = this.source;
    currentSource.onended = () => {
      if (this.source === currentSource) {
        this.isPlaying = false;
        this.pauseOffset = 0;
        this.stopTimer();
        this.source = null;
        this.onEnded?.();
      }
    };

    const offset = Math.min(this.pauseOffset, this.audioBuffer.duration);
    currentSource.start(0, offset);
    this.startTime = this.ctx.currentTime - offset;
    this.isPlaying = true;

    this.startTimer();
  }

  public pause(): void {
    if (!this.isPlaying || !this.ctx) return;
    this.pauseOffset = this.ctx.currentTime - this.startTime;
    this.isPlaying = false;
    this.stopTimer();
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
  }

  public stop(): void {
    if (this.source) {
      try {
        this.source.onended = null;
        this.source.stop();
        this.source.disconnect();
      } catch {}
      this.source = null;
    }
    this.isPlaying = false;
    this.pauseOffset = 0;
    this.stopTimer();
  }

  public seek(timeSec: number): void {
    const wasPlaying = this.isPlaying;
    this.stop();
    this.pauseOffset = Math.max(0, Math.min(timeSec, this.getDuration()));
    if (wasPlaying) {
      this.play();
    } else {
      this.onTimeUpdate?.(this.pauseOffset, this.getDuration());
    }
  }

  public setVolume(volume: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, volume));
    }
  }

  public isPlayingNow(): boolean {
    return this.isPlaying;
  }

  public getDuration(): number {
    return this.audioBuffer ? this.audioBuffer.duration : 0;
  }

  public getCurrentTime(): number {
    if (!this.ctx) return 0;
    if (this.isPlaying) {
      return Math.min(this.getDuration(), this.ctx.currentTime - this.startTime);
    }
    return this.pauseOffset;
  }

  private animFrameId: any = null;

  private startTimer(): void {
    this.stopTimer();
    const tick = () => {
      if (this.isPlaying) {
        this.onTimeUpdate?.(this.getCurrentTime(), this.getDuration());
        if (typeof (globalThis as any).requestAnimationFrame !== 'undefined') {
          this.animFrameId = (globalThis as any).requestAnimationFrame(tick);
        }
      }
    };

    if (typeof (globalThis as any).requestAnimationFrame !== 'undefined') {
      this.animFrameId = (globalThis as any).requestAnimationFrame(tick);
    } else {
      this.updateTimer = setInterval(() => {
        this.onTimeUpdate?.(this.getCurrentTime(), this.getDuration());
      }, 50);
    }
  }

  private stopTimer(): void {
    if (this.animFrameId !== null && typeof (globalThis as any).cancelAnimationFrame !== 'undefined') {
      (globalThis as any).cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
  }

  /**
   * Generates normalized peak values for rendering waveforms on canvas.
   */
  public static generateWaveformPeaks(pcm16: Int16Array, buckets: number = 200): number[] {
    if (pcm16.length === 0 || buckets <= 0) return new Array(buckets).fill(0);

    const peaks: number[] = new Array(buckets);
    const bucketSize = Math.floor(pcm16.length / buckets);

    for (let b = 0; b < buckets; b++) {
      const start = b * bucketSize;
      const end = Math.min(pcm16.length, start + bucketSize);
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
   * Plays a synthesized DTMF tone for telephone-event playback.
   */
  public playDtmf(digit: number | string, durationMs: number = 200): void {
    this.initContext();
    if (!this.ctx) return;

    // RFC 4733 / DTMF frequency matrix
    const dtmfFreqs: Record<string, [number, number]> = {
      '0': [941, 1336], '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
      '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
      '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
      '*': [941, 1209], '#': [941, 1477],
      'A': [697, 1633], 'B': [770, 1633], 'C': [852, 1633], 'D': [941, 1633],
    };

    const key = String(digit).toUpperCase();
    const freqs = dtmfFreqs[key];
    if (!freqs) return;

    const osc1 = this.ctx.createOscillator();
    const osc2 = this.ctx.createOscillator();
    const toneGain = this.ctx.createGain();

    osc1.frequency.value = freqs[0];
    osc2.frequency.value = freqs[1];
    toneGain.gain.value = 0.2;

    osc1.connect(toneGain);
    osc2.connect(toneGain);
    toneGain.connect(this.ctx.destination);

    const now = this.ctx.currentTime;
    osc1.start(now);
    osc2.start(now);

    const stopTime = now + durationMs / 1000;
    osc1.stop(stopTime);
    osc2.stop(stopTime);
  }
}
