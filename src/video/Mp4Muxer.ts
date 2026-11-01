import type { H264NalUnit, H264VideoMetadata } from './H264Depacketizer.ts';

export class Mp4Muxer {
  /**
   * Packages H.264 NAL units into a standard, self-contained MP4 file (ISO BMFF).
   * Playable directly in browser <video> tags, VLC, QuickTime, and mobile phones.
   */
  public static mux(metadata: H264VideoMetadata): Uint8Array {
    const width = metadata.width || 640;
    const height = metadata.height || 480;
    const fps = metadata.fps || 30;
    const timescale = 90000;
    const sampleDuration = Math.round(timescale / fps);

    // Group NAL units into access units (frames)
    // Non-VCL NALs (SPS=7, PPS=8, SEI=6) belong to the following VCL slice (IDR=5, Non-IDR=1)
    const samples: Array<{ data: Uint8Array; isKey: boolean; timestamp: number }> = [];
    let currentNals: H264NalUnit[] = [];
    let currentTimestamp = 0;

    for (const nal of metadata.nalUnits) {
      if (nal.nalType === 7 || nal.nalType === 8) {
        // SPS and PPS go into avcC configuration record
        continue;
      }

      if (currentNals.length > 0 && nal.timestamp !== currentTimestamp && (nal.nalType === 1 || nal.nalType === 5)) {
        // Flush previous sample
        samples.push(Mp4Muxer.assembleSample(currentNals, currentTimestamp));
        currentNals = [];
      }

      currentTimestamp = nal.timestamp;
      currentNals.push(nal);

      // If this is a VCL slice and next NAL has different timestamp or is keyframe
      if (nal.nalType === 1 || nal.nalType === 5) {
        samples.push(Mp4Muxer.assembleSample(currentNals, currentTimestamp));
        currentNals = [];
      }
    }

    if (currentNals.length > 0) {
      samples.push(Mp4Muxer.assembleSample(currentNals, currentTimestamp));
    }

    if (samples.length === 0) {
      // Fallback: package each NAL unit as a sample
      for (const nal of metadata.nalUnits) {
        const u8 = new Uint8Array(4 + nal.data.length);
        const v = new DataView(u8.buffer);
        v.setUint32(0, nal.data.length, false);
        u8.set(nal.data, 4);
        samples.push({ data: u8, isKey: nal.isKeyframe, timestamp: nal.timestamp });
      }
    }

    // Default SPS/PPS if missing
    const sps = metadata.sps || new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x6d, 0x0a, 0x13, 0x50]);
    const pps = metadata.pps || new Uint8Array([0x68, 0xce, 0x3c, 0x80]);

    // Build ISO BMFF Boxes
    const ftyp = Mp4Muxer.box('ftyp', [
      Mp4Muxer.str('isom'),
      Mp4Muxer.u32(0x00000200), // minor version
      Mp4Muxer.str('isom'),
      Mp4Muxer.str('iso2'),
      Mp4Muxer.str('avc1'),
      Mp4Muxer.str('mp41'),
    ]);

    // Sample data for mdat
    const totalSampleDataLen = samples.reduce((acc, s) => acc + s.data.length, 0);
    const mdatPayload = new Uint8Array(totalSampleDataLen);
    let mdatOffset = 0;
    for (const s of samples) {
      mdatPayload.set(s.data, mdatOffset);
      mdatOffset += s.data.length;
    }
    const mdat = Mp4Muxer.box('mdat', [mdatPayload]);

    const duration = samples.length * sampleDuration;

    // mvhd
    const mvhd = Mp4Muxer.box('mvhd', [
      new Uint8Array([0, 0, 0, 0]), // version 0, flags
      Mp4Muxer.u32(0),              // creation time
      Mp4Muxer.u32(0),              // modification time
      Mp4Muxer.u32(timescale),      // timescale
      Mp4Muxer.u32(duration),       // duration
      Mp4Muxer.u32(0x00010000),     // rate 1.0
      Mp4Muxer.u16(0x0100),         // volume 1.0
      new Uint8Array(10),           // reserved
      Mp4Muxer.matrix(),            // transformation matrix
      new Uint8Array(24),           // pre-defined
      Mp4Muxer.u32(2),              // next track id
    ]);

    // tkhd
    const tkhd = Mp4Muxer.box('tkhd', [
      new Uint8Array([0, 0, 0, 0x0f]), // flags: enabled, in movie, in preview
      Mp4Muxer.u32(0),                 // creation
      Mp4Muxer.u32(0),                 // mod
      Mp4Muxer.u32(1),                 // track id
      Mp4Muxer.u32(0),                 // reserved
      Mp4Muxer.u32(duration),          // duration
      new Uint8Array(8),               // reserved
      Mp4Muxer.u16(0),                 // layer
      Mp4Muxer.u16(0),                 // alternate group
      Mp4Muxer.u16(0),                 // volume (video)
      Mp4Muxer.u16(0),                 // reserved
      Mp4Muxer.matrix(),               // matrix
      Mp4Muxer.u32(width << 16),       // width (fixed point 16.16)
      Mp4Muxer.u32(height << 16),      // height (fixed point 16.16)
    ]);

    // mdhd
    const mdhd = Mp4Muxer.box('mdhd', [
      new Uint8Array(4),               // version 0, flags
      Mp4Muxer.u32(0),                 // creation
      Mp4Muxer.u32(0),                 // mod
      Mp4Muxer.u32(timescale),         // timescale
      Mp4Muxer.u32(duration),          // duration
      Mp4Muxer.u16(0x55c4),            // language 'und'
      Mp4Muxer.u16(0),                 // quality
    ]);

    // hdlr
    const hdlr = Mp4Muxer.box('hdlr', [
      new Uint8Array(4),
      Mp4Muxer.u32(0),
      Mp4Muxer.str('vide'),            // handler type
      new Uint8Array(12),
      Mp4Muxer.str('VideoHandler\0'),
    ]);

    // vmhd
    const vmhd = Mp4Muxer.box('vmhd', [
      new Uint8Array([0, 0, 0, 1]),    // flags = 1
      Mp4Muxer.u16(0),                 // graphics mode
      new Uint8Array(6),               // opcolor
    ]);

    // dref & dinf
    const dref = Mp4Muxer.box('dref', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),                 // entry count
      Mp4Muxer.box('url ', [new Uint8Array([0, 0, 0, 1])]), // self-contained
    ]);
    const dinf = Mp4Muxer.box('dinf', [dref]);

    // avcC (AVCDecoderConfigurationRecord)
    const avcC = Mp4Muxer.box('avcC', [
      new Uint8Array([
        1,                             // configurationVersion = 1
        sps.length > 1 ? sps[1] : 0x42,// AVCProfileIndication
        sps.length > 2 ? sps[2] : 0xe0,// profile_compatibility
        sps.length > 3 ? sps[3] : 0x1e,// AVCLevelIndication
        0xff,                          // lengthSizeMinusOne | 0xfc (4 bytes NAL length)
        0xe1,                          // numOfSequenceParameterSets = 1
      ]),
      Mp4Muxer.u16(sps.length),
      sps,
      new Uint8Array([1]),             // numOfPictureParameterSets = 1
      Mp4Muxer.u16(pps.length),
      pps,
    ]);

    // avc1 (Sample entry)
    const avc1 = Mp4Muxer.box('avc1', [
      new Uint8Array(6),               // reserved
      Mp4Muxer.u16(1),                 // data reference index
      new Uint8Array(16),              // pre-defined, reserved
      Mp4Muxer.u16(width),             // width
      Mp4Muxer.u16(height),            // height
      Mp4Muxer.u32(0x00480000),        // horiz resolution 72 dpi
      Mp4Muxer.u32(0x00480000),        // vert resolution 72 dpi
      Mp4Muxer.u32(0),                 // reserved
      Mp4Muxer.u16(1),                 // frame count
      new Uint8Array(32),              // compressorname (32 bytes empty)
      Mp4Muxer.u16(0x0018),            // depth = 24
      Mp4Muxer.u16(0xffff),            // pre-defined = -1
      avcC,
    ]);

    // stsd
    const stsd = Mp4Muxer.box('stsd', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),                 // entry count
      avc1,
    ]);

    // stts (Time-to-sample)
    const stts = Mp4Muxer.box('stts', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),                 // entry count
      Mp4Muxer.u32(samples.length),    // sample count
      Mp4Muxer.u32(sampleDuration),    // sample duration
    ]);

    // stss (Sync samples / Keyframes)
    const keyIndices: number[] = [];
    for (let i = 0; i < samples.length; i++) {
      if (samples[i].isKey) {
        keyIndices.push(i + 1); // 1-based index
      }
    }
    const stssPayload = [
      new Uint8Array(4),
      Mp4Muxer.u32(keyIndices.length > 0 ? keyIndices.length : 1),
    ];
    if (keyIndices.length > 0) {
      for (const idx of keyIndices) {
        stssPayload.push(Mp4Muxer.u32(idx));
      }
    } else {
      stssPayload.push(Mp4Muxer.u32(1));
    }
    const stss = Mp4Muxer.box('stss', stssPayload);

    // stsc (Sample to chunk: 1 chunk with all samples)
    const stsc = Mp4Muxer.box('stsc', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),                 // entry count
      Mp4Muxer.u32(1),                 // first chunk = 1
      Mp4Muxer.u32(samples.length),    // samples per chunk
      Mp4Muxer.u32(1),                 // sample description index = 1
    ]);

    // stsz (Sample sizes)
    const stszPayload = [
      new Uint8Array(4),
      Mp4Muxer.u32(0),                 // sample size = 0 (variable)
      Mp4Muxer.u32(samples.length),    // sample count
    ];
    for (const s of samples) {
      stszPayload.push(Mp4Muxer.u32(s.data.length));
    }
    const stsz = Mp4Muxer.box('stsz', stszPayload);

    // Preliminary stco to compute moov size
    const dummyStco = Mp4Muxer.box('stco', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),
      Mp4Muxer.u32(0),
    ]);

    let stbl = Mp4Muxer.box('stbl', [stsd, stts, stss, stsc, stsz, dummyStco]);
    let minf = Mp4Muxer.box('minf', [vmhd, dinf, stbl]);
    let mdia = Mp4Muxer.box('mdia', [mdhd, hdlr, minf]);
    let trak = Mp4Muxer.box('trak', [tkhd, mdia]);
    let moov = Mp4Muxer.box('moov', [mvhd, trak]);

    // Calculate actual mdat chunk offset: ftyp length + moov length + 8 bytes mdat header
    const chunkOffset = ftyp.length + moov.length + 8;
    const realStco = Mp4Muxer.box('stco', [
      new Uint8Array(4),
      Mp4Muxer.u32(1),                 // entry count = 1
      Mp4Muxer.u32(chunkOffset),       // chunk offset
    ]);

    // Rebuild stbl and moov with real chunk offset
    stbl = Mp4Muxer.box('stbl', [stsd, stts, stss, stsc, stsz, realStco]);
    minf = Mp4Muxer.box('minf', [vmhd, dinf, stbl]);
    mdia = Mp4Muxer.box('mdia', [mdhd, hdlr, minf]);
    trak = Mp4Muxer.box('trak', [tkhd, mdia]);
    moov = Mp4Muxer.box('moov', [mvhd, trak]);

    // Combine ftyp + moov + mdat
    const totalMp4Len = ftyp.length + moov.length + mdat.length;
    const mp4 = new Uint8Array(totalMp4Len);
    let writePos = 0;

    mp4.set(ftyp, writePos); writePos += ftyp.length;
    mp4.set(moov, writePos); writePos += moov.length;
    mp4.set(mdat, writePos);

    return mp4;
  }

  private static assembleSample(nals: H264NalUnit[], timestamp: number): { data: Uint8Array; isKey: boolean; timestamp: number } {
    let totalLen = 0;
    let isKey = false;
    for (const n of nals) {
      totalLen += 4 + n.data.length; // 4-byte length prefix
      if (n.isKeyframe) isKey = true;
    }

    const buf = new Uint8Array(totalLen);
    const view = new DataView(buf.buffer);
    let offset = 0;

    for (const n of nals) {
      view.setUint32(offset, n.data.length, false);
      offset += 4;
      buf.set(n.data, offset);
      offset += n.data.length;
    }

    return { data: buf, isKey, timestamp };
  }

  private static box(type: string, contents: Uint8Array[]): Uint8Array {
    const payloadLen = contents.reduce((acc, c) => acc + c.length, 0);
    const totalLen = 8 + payloadLen;
    const res = new Uint8Array(totalLen);
    const view = new DataView(res.buffer);

    view.setUint32(0, totalLen, false);
    for (let i = 0; i < 4; i++) {
      res[4 + i] = type.charCodeAt(i);
    }

    let offset = 8;
    for (const c of contents) {
      res.set(c, offset);
      offset += c.length;
    }
    return res;
  }

  private static str(s: string): Uint8Array {
    const buf = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) buf[i] = s.charCodeAt(i);
    return buf;
  }

  private static u16(val: number): Uint8Array {
    const buf = new Uint8Array(2);
    new DataView(buf.buffer).setUint16(0, val, false);
    return buf;
  }

  private static u32(val: number): Uint8Array {
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, val, false);
    return buf;
  }

  private static matrix(): Uint8Array {
    // Identity matrix 3x3 for MP4 video
    const buf = new Uint8Array(36);
    const v = new DataView(buf.buffer);
    v.setUint32(0, 0x00010000, false);  // a = 1.0
    v.setUint32(16, 0x00010000, false); // d = 1.0
    v.setUint32(32, 0x40000000, false); // w = 1.0
    return buf;
  }
}
