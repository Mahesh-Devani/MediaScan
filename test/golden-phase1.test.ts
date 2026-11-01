import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapturePipeline } from '../src/CapturePipeline.ts';

describe('Phase 1 Golden Test on mrfp-o.pcap', () => {
  const pcapPath = path.resolve(process.cwd(), 'test/fixtures/mrfp-o/mrfp-o.pcap');
  const summaryPath = path.resolve(process.cwd(), 'test/fixtures/mrfp-o/summary.csv');

  it('correctly processes mrfp-o.pcap and matches reference stream summary', () => {
    assert.ok(fs.existsSync(pcapPath), `File not found: ${pcapPath}`);
    assert.ok(fs.existsSync(summaryPath), `File not found: ${summaryPath}`);

    const fileBuffer = fs.readFileSync(pcapPath);
    const pcapBytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

    const result = CapturePipeline.process(pcapBytes);

    // 1. Media Server Auto-Detection
    assert.ok(result.mediaServer);
    assert.equal(result.mediaServer.ip, 'fd5d:d50a:8c17:2110::547');

    // 2. Stream count verification
    // Expected 8 streams in summary.csv
    assert.equal(result.streams.length, 8, `Expected 8 RTP streams, got ${result.streams.length}`);

    // Read summary.csv expected SSRCs and Payload Types
    const expectedSsrcs = new Set([
      1208512104,
      1403921308,
      1744888485,
      620399455,
      1619045890,
      1613948933,
      1065873160,
      1962129675,
    ]);

    for (const stream of result.streams) {
      assert.ok(expectedSsrcs.has(stream.ssrc), `Unexpected SSRC: ${stream.ssrc}`);
    }

    // 3. Dialog & Leg correlation verification
    console.log('Detected legs:', result.legs.map(l => ({ id: l.id, callId: l.callId, remote: l.remoteEndpoint, ms: l.msEndpoint, inSsrc: l.inboundStream?.ssrc, outSsrc: l.outboundStream?.ssrc })));
    assert.equal(result.dialogs.length, 4, `Expected 4 SIP dialogs, got ${result.dialogs.length}`);
    assert.equal(result.legs.length, 4, `Expected 4 legs, got ${result.legs.length}`);

    for (const leg of result.legs) {
      assert.equal(leg.isCorrelatedWithSip, true, `Leg ${leg.id} should be correlated with SIP`);
      assert.equal(leg.msEndpoint.ip, 'fd5d:d50a:8c17:2110::547');
      assert.ok(leg.inboundStream, `Leg ${leg.id} should have inbound stream`);
      assert.ok(leg.outboundStream, `Leg ${leg.id} should have outbound stream`);
    }

    // 4. Conversation grouping
    assert.ok(result.conversations.length >= 1, 'Should have at least 1 conversation');
    const conv = result.conversations[0];
    assert.equal(conv.classification, 'Conference', '4-leg media server call should be classified as Conference');
    assert.equal(conv.legs.length, 4);

    console.log(`Phase 1 Golden Test Passed: ${result.stats.totalFrames} frames parsed, ${result.stats.rtpPackets} RTP packets, ${result.streams.length} streams, MS: ${result.mediaServer.ip}`);
  });
});
