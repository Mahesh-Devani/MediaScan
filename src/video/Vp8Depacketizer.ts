import type { RtpStream, StoredRtpPacket } from '../rtp/RtpDemuxer.ts';

export interface Vp8Frame {
  isKeyframe: boolean;
  data: Uint8Array;
  timestamp: number;     // RTP 90kHz timestamp
  timeSec: number;       // Arrival time in seconds
  width?: number;
  height?: number;
}

export interface Vp8VideoMetadata {
  codec: 'VP8';
  width: number;
  height: number;
  fps: number;
  frames: Vp8Frame[];
  ivfBytes: Uint8Array; // IVF container file bytes
  keyframesCount: number;
  totalFrameCount: number;
}

export class Vp8Depacketizer {
  /**
   * Depacketizes an RTP stream carrying VP8 video according to RFC 7741.
   * Assembles fragmented partition packets into complete VP8 frames and builds IVF file.
   */
  public static depacketize(stream: RtpStream): Vp8VideoMetadata {
    const packets = stream.packets || [];
    const frames: Vp8Frame[] = [];

    let currentFrameChunks: Uint8Array[] = [];
    let currentFrameTimestamp = 0;
    let currentFrameTimeSec = 0;
    let currentFrameIsKey = false;
    let frameWidth = 0;
    let frameHeight = 0;

    const finalizeCurrentFrame = () => {
      if (currentFrameChunks.length === 0) return;

      const totalLen = currentFrameChunks.reduce((acc, c) => acc + c.length, 0);
      const frameData = new Uint8Array(totalLen);
      let offset = 0;
      for (const c of currentFrameChunks) {
        frameData.set(c, offset);
        offset += c.length;
      }
      currentFrameChunks = [];

      frames.push({
        isKeyframe: currentFrameIsKey,
        data: frameData,
        timestamp: currentFrameTimestamp,
        timeSec: currentFrameTimeSec,
        width: currentFrameIsKey ? frameWidth : undefined,
        height: currentFrameIsKey ? frameHeight : undefined,
      });
    };

    for (let i = 0; i < packets.length; i++) {
      const pkt = packets[i];
      const payload = pkt.payload;
      if (!payload || payload.length === 0) continue;

      // 1. Parse RFC 7741 VP8 Payload Descriptor
      let headerLen = 1;
      const b0 = payload[0];
      const hasExtended = (b0 & 0x80) !== 0;
      const isStart = (b0 & 0x10) !== 0;
      const partId = b0 & 0x0f;

      if (hasExtended && payload.length > 1) {
        headerLen++;
        const b1 = payload[1];
        const hasPictureId = (b1 & 0x80) !== 0;
        const hasTl0PicIdx = (b1 & 0x40) !== 0;
        const hasTid = (b1 & 0x20) !== 0;
        const hasKeyIdx = (b1 & 0x10) !== 0;

        if (hasPictureId && payload.length > headerLen) {
          const picIdB0 = payload[headerLen];
          headerLen++;
          if ((picIdB0 & 0x80) !== 0 && payload.length > headerLen) {
            headerLen++; // 15-bit PictureID
          }
        }
        if (hasTl0PicIdx && payload.length > headerLen) {
          headerLen++;
        }
        if ((hasTid || hasKeyIdx) && payload.length > headerLen) {
          headerLen++;
        }
      }

      if (headerLen >= payload.length) continue;
      const vp8Payload = payload.subarray(headerLen);

      // Start of a new frame
      if (isStart && partId === 0) {
        finalizeCurrentFrame();
        currentFrameTimestamp = pkt.timestamp;
        currentFrameTimeSec = pkt.pktTime;

        // Check uncompressed chunk header for keyframe
        if (vp8Payload.length >= 1) {
          const frameType = vp8Payload[0] & 0x01; // 0 = keyframe, 1 = interframe
          currentFrameIsKey = frameType === 0;

          if (currentFrameIsKey && vp8Payload.length >= 10) {
            // Check VP8 sync code: 0x9D 0x01 0x2A
            if (vp8Payload[3] === 0x9d && vp8Payload[4] === 0x01 && vp8Payload[5] === 0x2a) {
              const w = vp8Payload[6] | ((vp8Payload[7] & 0x3f) << 8);
              const h = vp8Payload[8] | ((vp8Payload[9] & 0x3f) << 8);
              if (w > 0 && h > 0) {
                frameWidth = w;
                frameHeight = h;
              }
            }
          }
        }
      }

      currentFrameChunks.push(vp8Payload);

      // End of frame indicated by RTP marker bit
      if (pkt.marker) {
        finalizeCurrentFrame();
      }
    }

    // Flush last frame if any
    finalizeCurrentFrame();

    const duration = Math.max(0.1, stream.endTime - stream.startTime);
    const fps = frames.length > 0 ? Math.round((frames.length / duration) * 10) / 10 : 30;
    const finalWidth = frameWidth || 640;
    const finalHeight = frameHeight || 480;

    const ivfBytes = Vp8Depacketizer.createIvf(frames, finalWidth, finalHeight, fps);

    return {
      codec: 'VP8',
      width: finalWidth,
      height: finalHeight,
      fps: fps > 0 && fps <= 120 ? fps : 30,
      frames,
      ivfBytes,
      keyframesCount: frames.filter(f => f.isKeyframe).length,
      totalFrameCount: frames.length,
    };
  }

  /**
   * Encapsulates VP8 raw frames into an IVF (Indeo Video Format) container file.
   * IVF is standard for VP8 elementary streams and playable by VLC, Chrome, and ffplay.
   */
  public static createIvf(frames: Vp8Frame[], width: number, height: number, fps: number): Uint8Array {
    let totalFramesLen = 0;
    for (const f of frames) {
      totalFramesLen += 12 + f.data.length; // 12-byte frame header
    }

    const totalLen = 32 + totalFramesLen; // 32-byte IVF file header
    const ivf = new Uint8Array(totalLen);
    const view = new DataView(ivf.buffer, ivf.byteOffset, ivf.byteLength);

    // 1. 32-byte IVF File Header
    // Magic bytes: 'DKIF' (0x44, 0x4B, 0x49, 0x46)
    ivf[0] = 0x44; ivf[1] = 0x4b; ivf[2] = 0x49; ivf[3] = 0x46;
    view.setUint16(4, 0, true); // version = 0
    view.setUint16(6, 32, true); // header size = 32
    // FourCC: 'VP80'
    ivf[8] = 0x56; ivf[9] = 0x50; ivf[10] = 0x38; ivf[11] = 0x30;
    view.setUint16(12, width, true);
    view.setUint16(14, height, true);
    view.setUint32(16, Math.round(fps * 1000) || 30000, true); // timebase rate
    view.setUint32(20, 1000, true); // timebase scale
    view.setUint32(24, frames.length, true); // num frames
    view.setUint32(28, 0, true); // unused

    // 2. Frame Headers and Payloads
    let offset = 32;
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      view.setUint32(offset, f.data.length, true); // Frame size (4 bytes)
      view.setUint32(offset + 4, i, true); // Timestamp low 32 bits
      view.setUint32(offset + 8, 0, true); // Timestamp high 32 bits
      offset += 12;

      ivf.set(f.data, offset);
      offset += f.data.length;
    }

    return ivf;
  }
}
