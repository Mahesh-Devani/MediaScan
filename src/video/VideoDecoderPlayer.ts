import { H264Depacketizer } from './H264Depacketizer.ts';
import type { H264VideoMetadata } from './H264Depacketizer.ts';
import { Vp8Depacketizer } from './Vp8Depacketizer.ts';
import type { Vp8VideoMetadata, Vp8Frame } from './Vp8Depacketizer.ts';
import { Mp4Muxer } from './Mp4Muxer.ts';
import type { RtpStream } from '../rtp/RtpDemuxer.ts';

export interface DecodedVideoFrameInfo {
  frameIndex: number;
  timestampUs: number;
  width: number;
  height: number;
}

export class VideoDecoderPlayer {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private decoder: any = null;
  private h264Meta: H264VideoMetadata | null = null;
  private vp8Meta: Vp8VideoMetadata | null = null;
  private isPlaying = false;
  private currentFrameIndex = 0;
  private animFrameId: any = null;
  private decodedFrames: Map<number, any> = new Map(); // timestampUs -> VideoFrame
  private lastRenderedTimestamp = -1;

  public onFrameDecoded?: (info: DecodedVideoFrameInfo) => void;
  public onStateChanged?: (isPlaying: boolean) => void;

  constructor(canvas?: HTMLCanvasElement) {
    if (canvas) {
      this.attachCanvas(canvas);
    }
  }

  public attachCanvas(canvas: HTMLCanvasElement): void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  /**
   * Loads an RTP video stream (H.264 or VP8) and initializes the WebCodecs decoder.
   */
  public async loadStream(stream: RtpStream, codecHint?: string): Promise<{
    codec: string;
    width: number;
    height: number;
    fps: number;
    totalFrames: number;
  }> {
    this.stop();
    this.closeDecoder();

    const isVp8 = (codecHint && codecHint.toUpperCase().includes('VP8')) || stream.payloadType === 96;

    if (isVp8) {
      this.vp8Meta = Vp8Depacketizer.depacketize(stream);
      this.h264Meta = null;

      if (this.canvas) {
        this.canvas.width = this.vp8Meta.width;
        this.canvas.height = this.vp8Meta.height;
      }

      await this.initVp8Decoder();

      return {
        codec: 'VP8',
        width: this.vp8Meta.width,
        height: this.vp8Meta.height,
        fps: this.vp8Meta.fps,
        totalFrames: this.vp8Meta.totalFrameCount,
      };
    } else {
      // H.264 (Default)
      this.h264Meta = H264Depacketizer.depacketize(stream);
      this.vp8Meta = null;

      if (this.canvas) {
        this.canvas.width = this.h264Meta.width;
        this.canvas.height = this.h264Meta.height;
      }

      await this.initH264Decoder();

      return {
        codec: 'H264',
        width: this.h264Meta.width,
        height: this.h264Meta.height,
        fps: this.h264Meta.fps,
        totalFrames: this.h264Meta.totalNalCount,
      };
    }
  }

  private async initH264Decoder(): Promise<void> {
    if (typeof window === 'undefined' || typeof (window as any).VideoDecoder === 'undefined') {
      return;
    }

    if (!this.h264Meta) return;

    try {
      this.decoder = new (window as any).VideoDecoder({
        output: (frame: any) => {
          this.handleVideoFrame(frame);
        },
        error: (err: any) => {
          console.warn('[VideoDecoderPlayer] H.264 WebCodecs error:', err);
        },
      });

      const config = {
        codec: this.h264Meta.profileLevelId ? `avc1.${this.h264Meta.profileLevelId}` : 'avc1.42e01e',
        codedWidth: this.h264Meta.width,
        codedHeight: this.h264Meta.height,
        optimizeForLatency: true,
      };

      const support = await (window as any).VideoDecoder.isConfigSupported(config);
      if (support.supported) {
        this.decoder.configure(config);
        this.feedH264Chunks();
      } else {
        console.warn('[VideoDecoderPlayer] WebCodecs H.264 config unsupported:', config);
      }
    } catch (err) {
      console.warn('[VideoDecoderPlayer] Failed to initialize H.264 decoder:', err);
    }
  }

  private async initVp8Decoder(): Promise<void> {
    if (typeof window === 'undefined' || typeof (window as any).VideoDecoder === 'undefined') {
      return;
    }

    if (!this.vp8Meta) return;

    try {
      this.decoder = new (window as any).VideoDecoder({
        output: (frame: any) => {
          this.handleVideoFrame(frame);
        },
        error: (err: any) => {
          console.warn('[VideoDecoderPlayer] VP8 WebCodecs error:', err);
        },
      });

      const config = {
        codec: 'vp8',
        codedWidth: this.vp8Meta.width,
        codedHeight: this.vp8Meta.height,
        optimizeForLatency: true,
      };

      const support = await (window as any).VideoDecoder.isConfigSupported(config);
      if (support.supported) {
        this.decoder.configure(config);
        this.feedVp8Chunks();
      }
    } catch (err) {
      console.warn('[VideoDecoderPlayer] Failed to initialize VP8 decoder:', err);
    }
  }

  private feedH264Chunks(): void {
    if (!this.decoder || !this.h264Meta) return;

    for (let i = 0; i < this.h264Meta.nalUnits.length; i++) {
      const nal = this.h264Meta.nalUnits[i];
      // WebCodecs requires Annex B start code prefix for avc1 or AVCC length-prefixed
      const chunkData = new Uint8Array(4 + nal.data.length);
      chunkData.set([0x00, 0x00, 0x00, 0x01], 0);
      chunkData.set(nal.data, 4);

      const timestampUs = Math.round(nal.timeSec * 1_000_000);
      const chunk = new (window as any).EncodedVideoChunk({
        type: nal.isKeyframe ? 'key' : 'delta',
        timestamp: timestampUs,
        data: chunkData,
      });

      try {
        this.decoder.decode(chunk);
      } catch (err) {
        console.warn(`[VideoDecoderPlayer] Chunk ${i} decode error:`, err);
      }
    }
  }

  private feedVp8Chunks(): void {
    if (!this.decoder || !this.vp8Meta) return;

    for (let i = 0; i < this.vp8Meta.frames.length; i++) {
      const f = this.vp8Meta.frames[i];
      const timestampUs = Math.round(f.timeSec * 1_000_000);
      const chunk = new (window as any).EncodedVideoChunk({
        type: f.isKeyframe ? 'key' : 'delta',
        timestamp: timestampUs,
        data: f.data,
      });

      try {
        this.decoder.decode(chunk);
      } catch (err) {
        console.warn(`[VideoDecoderPlayer] VP8 chunk ${i} decode error:`, err);
      }
    }
  }

  private handleVideoFrame(frame: any): void {
    const ts = frame.timestamp;
    this.decodedFrames.set(ts, frame);

    // If first frame or canvas not rendered yet, draw immediately
    if (this.lastRenderedTimestamp < 0) {
      this.renderFrame(frame);
    }

    this.onFrameDecoded?.({
      frameIndex: this.decodedFrames.size,
      timestampUs: ts,
      width: frame.displayWidth,
      height: frame.displayHeight,
    });
  }

  public renderFrame(frame: any): void {
    if (!this.ctx || !this.canvas) return;

    if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
      this.canvas.width = frame.displayWidth;
      this.canvas.height = frame.displayHeight;
    }

    this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);
    this.lastRenderedTimestamp = frame.timestamp;
  }

  /**
   * Synchronizes the video frame to an external audio playhead time in seconds.
   */
  public seekToTime(timeSec: number): void {
    const targetUs = Math.round(timeSec * 1_000_000);
    let bestFrame: any = null;
    let minDiff = Infinity;

    for (const [ts, frame] of this.decodedFrames.entries()) {
      const diff = Math.abs(ts - targetUs);
      if (diff < minDiff) {
        minDiff = diff;
        bestFrame = frame;
      }
    }

    if (bestFrame) {
      this.renderFrame(bestFrame);
    }
  }

  public stop(): void {
    this.isPlaying = false;
    if (this.animFrameId) {
      cancelAnimationFrame(this.animFrameId);
      this.animFrameId = null;
    }
    this.onStateChanged?.(false);
  }

  public closeDecoder(): void {
    if (this.decoder) {
      try {
        this.decoder.close();
      } catch {}
      this.decoder = null;
    }
    // Clean up stored VideoFrames to prevent WebGL/GPU memory leaks
    for (const frame of this.decodedFrames.values()) {
      try {
        frame.close();
      } catch {}
    }
    this.decodedFrames.clear();
    this.lastRenderedTimestamp = -1;
  }

  /**
   * Exports an MP4 container file for H.264 streams, or an IVF file for VP8 streams.
   */
  public exportContainerFile(): { data: Uint8Array; filename: string; mimeType: string } | null {
    if (this.h264Meta) {
      const mp4 = Mp4Muxer.mux(this.h264Meta);
      return {
        data: mp4,
        filename: 'video_stream.mp4',
        mimeType: 'video/mp4',
      };
    } else if (this.vp8Meta) {
      return {
        data: this.vp8Meta.ivfBytes,
        filename: 'video_stream.ivf',
        mimeType: 'video/x-ivf',
      };
    }
    return null;
  }

  /**
   * Exports raw elementary bitstream (.264 Annex B or raw VP8).
   */
  public exportRawBitstream(): { data: Uint8Array; filename: string } | null {
    if (this.h264Meta) {
      return {
        data: this.h264Meta.bitstream,
        filename: 'video_stream.264',
      };
    } else if (this.vp8Meta) {
      return {
        data: this.vp8Meta.ivfBytes,
        filename: 'video_stream.ivf',
      };
    }
    return null;
  }
}
