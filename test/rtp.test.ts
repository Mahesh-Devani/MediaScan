import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RtpDemuxer } from '../src/rtp/RtpDemuxer.ts';
import type { RtpPacket } from '../src/rtp/RtpDemuxer.ts';

describe('RtpDemuxer & Jitter Tracking', () => {
  it('parses valid RTP packet header with sequence, timestamp, and SSRC', () => {
    // Construct 12 bytes RTP header + 160 bytes payload
    const raw = new Uint8Array(12 + 160);
    const view = new DataView(raw.buffer);

    raw[0] = 0x80; // V=2, P=0, X=0, CC=0
    raw[1] = 0x00; // M=0, PT=0 (PCMU)
    view.setUint16(2, 14675, false); // Sequence 14675
    view.setUint32(4, 1882607904, false); // Timestamp
    view.setUint32(8, 1208512104, false); // SSRC 1208512104
    // Fill payload
    raw.fill(0xff, 12);

    const rtp = RtpDemuxer.parseRtp(raw);
    assert.ok(rtp);
    assert.equal(rtp.version, 2);
    assert.equal(rtp.payloadType, 0);
    assert.equal(rtp.sequenceNumber, 14675);
    assert.equal(rtp.timestamp, 1882607904);
    assert.equal(rtp.ssrc, 1208512104);
    assert.equal(rtp.payload.length, 160);
  });

  it('unrolls 16-bit sequence wrap-around correctly', () => {
    const demuxer = new RtpDemuxer();

    // Packet near 65535 boundary
    const pkt1 = createRtpPacket(65534, 1000, 100);
    const pkt2 = createRtpPacket(65535, 1160, 100);
    const pkt3 = createRtpPacket(0, 1320, 100); // wrapped
    const pkt4 = createRtpPacket(1, 1480, 100);

    demuxer.addPacket(pkt1, 0.0, 'src', 1000, 'dst', 2000);
    demuxer.addPacket(pkt2, 0.02, 'src', 1000, 'dst', 2000);
    demuxer.addPacket(pkt3, 0.04, 'src', 1000, 'dst', 2000);
    demuxer.addPacket(pkt4, 0.06, 'src', 1000, 'dst', 2000);

    const streams = demuxer.getStreams();
    assert.equal(streams.length, 1);
    const s = streams[0];
    assert.equal(s.packetCount, 4);
    assert.equal(s.lossCount, 0);
  });

  it('detects missing packets and calculates packet loss', () => {
    const demuxer = new RtpDemuxer();

    const pkt1 = createRtpPacket(100, 1000, 200);
    const pkt2 = createRtpPacket(101, 1160, 200);
    // Missing 102, 103
    const pkt3 = createRtpPacket(104, 1640, 200);

    demuxer.addPacket(pkt1, 0.0, 'src', 1000, 'dst', 2000);
    demuxer.addPacket(pkt2, 0.02, 'src', 1000, 'dst', 2000);
    demuxer.addPacket(pkt3, 0.08, 'src', 1000, 'dst', 2000);

    const s = demuxer.getStreams()[0];
    assert.equal(s.packetCount, 3);
    assert.equal(s.lossCount, 2);
    assert.equal(s.lossPercent, 40); // 2 lost out of 5 expected = 40%
  });
});

function createRtpPacket(seq: number, ts: number, ssrc: number): RtpPacket {
  const raw = new Uint8Array(12 + 160);
  const view = new DataView(raw.buffer);
  raw[0] = 0x80;
  raw[1] = 0x00;
  view.setUint16(2, seq, false);
  view.setUint32(4, ts, false);
  view.setUint32(8, ssrc, false);
  return RtpDemuxer.parseRtp(raw)!;
}
