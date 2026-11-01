import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { H264Depacketizer } from '../src/video/H264Depacketizer.ts';
import { Vp8Depacketizer } from '../src/video/Vp8Depacketizer.ts';
import { Mp4Muxer } from '../src/video/Mp4Muxer.ts';
import type { RtpStream } from '../src/rtp/RtpDemuxer.ts';

describe('Phase 4: Video Support — H.264 & VP8 Depacketizers and MP4 Muxer', () => {
  it('correctly depacketizes Single NAL H.264 packets and generates Annex B bitstream', () => {
    // Synthetic SPS (type 7) for 640x480 Baseline
    const spsData = new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x6d, 0x0a, 0x13, 0x50]);
    // Synthetic PPS (type 8)
    const ppsData = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    // Synthetic IDR slice (type 5)
    const idrData = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x10, 0xff]);

    const stream: RtpStream = {
      id: 'video-1',
      ssrc: 99999,
      payloadType: 99,
      srcIp: '192.168.1.1',
      srcPort: 5004,
      dstIp: '192.168.1.2',
      dstPort: 5004,
      startTime: 0.0,
      endTime: 1.0,
      firstSeq: 1,
      lastSeq: 3,
      minExtendedSeq: 1,
      maxExtendedSeq: 3,
      wrapCycles: 0,
      firstTimestamp: 90000,
      lastTimestamp: 93000,
      packetCount: 3,
      octetCount: spsData.length + ppsData.length + idrData.length,
      lossCount: 0,
      lossPercent: 0,
      jitterUs: 50,
      clockRate: 90000,
      packets: [
        { seq: 1, extendedSeq: 1, timestamp: 90000, pktTime: 0.0, marker: false, payload: spsData },
        { seq: 2, extendedSeq: 2, timestamp: 90000, pktTime: 0.0, marker: false, payload: ppsData },
        { seq: 3, extendedSeq: 3, timestamp: 90000, pktTime: 0.033, marker: true, payload: idrData },
      ],
      telephoneEvents: [],
    };

    const meta = H264Depacketizer.depacketize(stream);
    assert.equal(meta.codec, 'H264');
    assert.equal(meta.totalNalCount, 3);
    assert.equal(meta.keyframesCount, 2); // SPS and IDR are marked as keyframes
    assert.ok(meta.bitstream.length > 0);

    // Verify Annex B 00 00 00 01 start code
    assert.equal(meta.bitstream[0], 0x00);
    assert.equal(meta.bitstream[1], 0x00);
    assert.equal(meta.bitstream[2], 0x00);
    assert.equal(meta.bitstream[3], 0x01);
    assert.equal(meta.bitstream[4], 0x67); // SPS NAL header

    // Check SPS dimensions
    assert.ok(meta.width > 0);
    assert.ok(meta.height > 0);
  });

  it('correctly unpacks RFC 6184 STAP-A aggregation packets', () => {
    // STAP-A packet: NAL header type 24
    // 2-byte len + SPS + 2-byte len + PPS
    const sps = new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0x80]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);

    const stapA = new Uint8Array(1 + 2 + sps.length + 2 + pps.length);
    stapA[0] = 24; // STAP-A type
    let off = 1;
    // SPS size
    stapA[off++] = (sps.length >> 8) & 0xff;
    stapA[off++] = sps.length & 0xff;
    stapA.set(sps, off);
    off += sps.length;
    // PPS size
    stapA[off++] = (pps.length >> 8) & 0xff;
    stapA[off++] = pps.length & 0xff;
    stapA.set(pps, off);

    const stream: RtpStream = {
      id: 'video-2',
      ssrc: 88888,
      payloadType: 99,
      srcIp: '192.168.1.1',
      srcPort: 5004,
      dstIp: '192.168.1.2',
      dstPort: 5004,
      startTime: 0.0,
      endTime: 0.1,
      firstSeq: 1,
      lastSeq: 1,
      minExtendedSeq: 1,
      maxExtendedSeq: 1,
      wrapCycles: 0,
      firstTimestamp: 90000,
      lastTimestamp: 90000,
      packetCount: 1,
      octetCount: stapA.length,
      lossCount: 0,
      lossPercent: 0,
      jitterUs: 50,
      clockRate: 90000,
      packets: [
        { seq: 1, extendedSeq: 1, timestamp: 90000, pktTime: 0.0, marker: false, payload: stapA },
      ],
      telephoneEvents: [],
    };

    const meta = H264Depacketizer.depacketize(stream);
    assert.equal(meta.totalNalCount, 2);
    assert.equal(meta.nalUnits[0].nalType, 7); // SPS
    assert.equal(meta.nalUnits[1].nalType, 8); // PPS
  });

  it('correctly reassembles RFC 6184 FU-A fragmented NAL units', () => {
    // FU-A: indicator = 28, header with Start bit (0x80), Middle (0x00), End bit (0x40)
    // Original NAL: IDR (type 5, NRI=3 -> 0x65)
    const fuIndicator = 0x7c; // NRI=3, Type=28
    const fuStart = 0x85;     // S=1, E=0, Type=5
    const fuMid = 0x05;       // S=0, E=0, Type=5
    const fuEnd = 0x45;       // S=0, E=1, Type=5

    const chunk1 = new Uint8Array([fuIndicator, fuStart, 0x11, 0x22, 0x33]);
    const chunk2 = new Uint8Array([fuIndicator, fuMid, 0x44, 0x55]);
    const chunk3 = new Uint8Array([fuIndicator, fuEnd, 0x66, 0x77, 0x88]);

    const stream: RtpStream = {
      id: 'video-3',
      ssrc: 77777,
      payloadType: 99,
      srcIp: '192.168.1.1',
      srcPort: 5004,
      dstIp: '192.168.1.2',
      dstPort: 5004,
      startTime: 0.0,
      endTime: 0.033,
      firstSeq: 1,
      lastSeq: 3,
      minExtendedSeq: 1,
      maxExtendedSeq: 3,
      wrapCycles: 0,
      firstTimestamp: 90000,
      lastTimestamp: 90000,
      packetCount: 3,
      octetCount: chunk1.length + chunk2.length + chunk3.length,
      lossCount: 0,
      lossPercent: 0,
      jitterUs: 50,
      clockRate: 90000,
      packets: [
        { seq: 1, extendedSeq: 1, timestamp: 90000, pktTime: 0.0, marker: false, payload: chunk1 },
        { seq: 2, extendedSeq: 2, timestamp: 90000, pktTime: 0.01, marker: false, payload: chunk2 },
        { seq: 3, extendedSeq: 3, timestamp: 90000, pktTime: 0.02, marker: true, payload: chunk3 },
      ],
      telephoneEvents: [],
    };

    const meta = H264Depacketizer.depacketize(stream);
    assert.equal(meta.totalNalCount, 1);
    const reassembled = meta.nalUnits[0];
    assert.equal(reassembled.nalType, 5); // IDR
    assert.equal(reassembled.isKeyframe, true);
    // Header should be reconstructed: (0x7c & 0xe0) | 5 = 0x60 | 5 = 0x65
    assert.equal(reassembled.data[0], 0x65);
    // Payload should be concatenated: [0x65, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88]
    assert.equal(reassembled.data.length, 1 + 3 + 2 + 3);
  });

  it('depacketizes RFC 7741 VP8 stream and builds valid IVF container', () => {
    // VP8 keyframe packet:
    // Payload descriptor: b0 = 0x10 (S=1, PartID=0, no extended)
    // Uncompressed header: frame_type=0 (keyframe)
    // Sync code: 0x9d 0x01 0x2a
    // Width: 320 (0x0140 -> 0x40, 0x01)
    // Height: 240 (0x00f0 -> 0xf0, 0x00)
    const vp8KeyframePayload = new Uint8Array([
      0x10, // Descriptor (S=1, PartID=0)
      0x00, 0x00, 0x00, // frame_type=0, version=0, show=0, part_size
      0x9d, 0x01, 0x2a, // Sync code
      0x40, 0x01,       // 320 width
      0xf0, 0x00,       // 240 height
      0xaa, 0xbb, 0xcc, // macroblock data
    ]);

    const stream: RtpStream = {
      id: 'video-vp8',
      ssrc: 55555,
      payloadType: 96,
      srcIp: '192.168.1.1',
      srcPort: 5004,
      dstIp: '192.168.1.2',
      dstPort: 5004,
      startTime: 0.0,
      endTime: 1.0,
      firstSeq: 1,
      lastSeq: 1,
      minExtendedSeq: 1,
      maxExtendedSeq: 1,
      wrapCycles: 0,
      firstTimestamp: 90000,
      lastTimestamp: 90000,
      packetCount: 1,
      octetCount: vp8KeyframePayload.length,
      lossCount: 0,
      lossPercent: 0,
      jitterUs: 50,
      clockRate: 90000,
      packets: [
        { seq: 1, extendedSeq: 1, timestamp: 90000, pktTime: 0.0, marker: true, payload: vp8KeyframePayload },
      ],
      telephoneEvents: [],
    };

    const meta = Vp8Depacketizer.depacketize(stream);
    assert.equal(meta.codec, 'VP8');
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 240);
    assert.equal(meta.totalFrameCount, 1);
    assert.equal(meta.keyframesCount, 1);

    // Verify IVF container
    const ivf = meta.ivfBytes;
    assert.ok(ivf.length >= 32);
    // Check 'DKIF' header
    assert.equal(String.fromCharCode(ivf[0], ivf[1], ivf[2], ivf[3]), 'DKIF');
    // Check 'VP80' fourcc
    assert.equal(String.fromCharCode(ivf[8], ivf[9], ivf[10], ivf[11]), 'VP80');
    // Check width and height in IVF header
    const view = new DataView(ivf.buffer, ivf.byteOffset);
    assert.equal(view.getUint16(12, true), 320);
    assert.equal(view.getUint16(14, true), 240);
  });

  it('muxes H.264 metadata into a valid ISO BMFF MP4 file', () => {
    const sps = new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x6d, 0x0a, 0x13, 0x50]);
    const pps = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
    const idr = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x10, 0xff]);

    const h264Meta = {
      codec: 'H264' as const,
      profileLevelId: '42e01e',
      width: 640,
      height: 480,
      fps: 30,
      sps,
      pps,
      bitstream: new Uint8Array([...sps, ...pps, ...idr]),
      nalUnits: [
        { nalType: 7, nalTypeName: 'SPS', isKeyframe: true, data: sps, timestamp: 90000, timeSec: 0.0 },
        { nalType: 8, nalTypeName: 'PPS', isKeyframe: false, data: pps, timestamp: 90000, timeSec: 0.0 },
        { nalType: 5, nalTypeName: 'IDR', isKeyframe: true, data: idr, timestamp: 90000, timeSec: 0.0 },
      ],
      keyframesCount: 1,
      totalNalCount: 3,
    };

    const mp4 = Mp4Muxer.mux(h264Meta);
    assert.ok(mp4.length > 100);

    // Verify 'ftyp' box
    const ftypType = String.fromCharCode(mp4[4], mp4[5], mp4[6], mp4[7]);
    assert.equal(ftypType, 'ftyp');

    // Verify 'moov' and 'mdat' exist in MP4 byte stream
    const str = Buffer.from(mp4).toString('binary');
    assert.ok(str.includes('moov'));
    assert.ok(str.includes('trak'));
    assert.ok(str.includes('mdia'));
    assert.ok(str.includes('avc1'));
    assert.ok(str.includes('avcC'));
    assert.ok(str.includes('mdat'));
  });
});
