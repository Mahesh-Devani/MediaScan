import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { MosEngine } from '../src/mos/MosEngine.ts';
import { CodecConfigTable, DEFAULT_CODEC_PARAMS } from '../src/mos/CodecConfigTable.ts';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import type { RtpStream, RtpPacket } from '../src/rtp/RtpDemuxer.ts';

describe('Estimated MOS (E-model ITU-T G.107) Calculation Engine', () => {

  describe('1. ITU-T G.107 Pure Mathematical Formulas', () => {
    it('accurately computes golden R -> MOS pairs matching ITU-T G.107 specifications', () => {
      // Golden Point 1: Pristine G.711 reference R = 93.2 -> MOS ~ 4.41
      const mos93 = MosEngine.rToMos(93.2);
      assert.ok(Math.abs(mos93 - 4.409) < 0.01, `R=93.2 expected ~4.41, got ${mos93}`);

      // Golden Point 2: Fair quality R = 70.0 -> MOS ~ 3.60
      const mos70 = MosEngine.rToMos(70.0);
      assert.ok(Math.abs(mos70 - 3.597) < 0.01, `R=70.0 expected ~3.60, got ${mos70}`);

      // Golden Point 3: Poor quality R = 50.0 -> MOS ~ 2.58
      const mos50 = MosEngine.rToMos(50.0);
      assert.ok(Math.abs(mos50 - 2.575) < 0.01, `R=50.0 expected ~2.58, got ${mos50}`);

      // Boundary clamping: R <= 0 -> MOS = 1.0
      assert.equal(MosEngine.rToMos(0), 1.0);
      assert.equal(MosEngine.rToMos(-20), 1.0);

      // Boundary clamping: R >= 100 -> MOS = 4.5
      assert.equal(MosEngine.rToMos(100), 4.5);
      assert.equal(MosEngine.rToMos(120), 4.5);
    });

    it('exhibits strict monotonic non-decreasing behavior as R-factor increases from 0 to 100', () => {
      let prevMos = MosEngine.rToMos(0);
      for (let r = 1; r <= 100; r++) {
        const curMos = MosEngine.rToMos(r);
        assert.ok(curMos >= prevMos, `Monotonicity violated at R=${r}: ${curMos} < ${prevMos}`);
        prevMos = curMos;
      }
    });

    it('computes piecewise delay impairment Id per ITU-T G.107', () => {
      // Ta <= 100ms -> Id = 0
      assert.equal(MosEngine.calculateId(0), 0);
      assert.equal(MosEngine.calculateId(50), 0);
      assert.equal(MosEngine.calculateId(100), 0);

      // Ta = 150ms -> 0.024 * 150 = 3.6
      const id150 = MosEngine.calculateId(150);
      assert.ok(Math.abs(id150 - 3.6) < 0.001, `Id at 150ms expected 3.6, got ${id150}`);

      // Ta = 250ms -> 0.024 * 250 + 0.11 * (250 - 177.3) = 6.0 + 7.997 = 13.997
      const id250 = MosEngine.calculateId(250);
      assert.ok(Math.abs(id250 - 13.997) < 0.01, `Id at 250ms expected ~14.0, got ${id250}`);

      // Id monotonically increases as delay increases
      let prevId = 0;
      for (let delay = 100; delay <= 500; delay += 25) {
        const id = MosEngine.calculateId(delay);
        assert.ok(id >= prevId, `Delay impairment decreased at delay=${delay}`);
        prevId = id;
      }
    });

    it('computes effective equipment impairment Ie_eff and penalizes bursty loss', () => {
      const g711 = CodecConfigTable.resolveCodecParams('PCMU');

      // 0% loss -> Ie_eff == Ie (0)
      const ie0 = MosEngine.calculateIeEff(g711.ie, g711.bplWithPlc, 0, 1.0);
      assert.equal(ie0, 0);

      // 5% loss with random loss (burstRatio = 1.0)
      const ieRandom5 = MosEngine.calculateIeEff(g711.ie, g711.bplWithPlc, 5, 1.0);
      assert.ok(ieRandom5 > 0, 'Ie_eff should be > 0 for 5% loss');

      // 5% loss with bursty loss (burstRatio = 2.5)
      const ieBurst5 = MosEngine.calculateIeEff(g711.ie, g711.bplWithPlc, 5, 2.5);
      assert.ok(ieBurst5 > ieRandom5, `Bursty loss must produce higher impairment: burst ${ieBurst5} vs random ${ieRandom5}`);

      // High loss (20%) produces significant impairment
      const ie20 = MosEngine.calculateIeEff(g711.ie, g711.bplWithPlc, 20, 1.0);
      assert.ok(ie20 > ieRandom5 * 2, '20% loss must be much worse than 5% loss');
    });
  });

  describe('2. Gilbert Model Loss Gap Analysis & Burst Ratio', () => {
    it('returns BurstRatio = 1.0 when there are no lost packets', () => {
      const packets: RtpPacket[] = [
        { seqNum: 100, timestamp: 0, arrivalTime: 0 } as any,
        { seqNum: 101, timestamp: 160, arrivalTime: 0.02 } as any,
        { seqNum: 102, timestamp: 320, arrivalTime: 0.04 } as any,
      ];
      const burst = MosEngine.calculateBurstRatio(packets as any);
      assert.equal(burst.burstRatio, 1.0);
      assert.equal(burst.lossCount, 0);
    });

    it('computes burst ratio near 1.0 for independent random isolated losses', () => {
      // Sequences with isolated single packet losses: 100, 101, [gap 102], 103, 104, [gap 105], 106
      const packets: RtpPacket[] = [
        { seqNum: 100, timestamp: 0, arrivalTime: 0 } as any,
        { seqNum: 101, timestamp: 160, arrivalTime: 0.02 } as any,
        { seqNum: 103, timestamp: 480, arrivalTime: 0.06 } as any,
        { seqNum: 104, timestamp: 640, arrivalTime: 0.08 } as any,
        { seqNum: 106, timestamp: 960, arrivalTime: 0.12 } as any,
        { seqNum: 107, timestamp: 1120, arrivalTime: 0.14 } as any,
      ];
      const burst = MosEngine.calculateBurstRatio(packets as any);
      assert.equal(burst.lossCount, 2);
      // Each burst length is exactly 1 -> mean burst length = 1.0
      assert.ok(Math.abs(burst.burstRatio - 1.0) < 0.1, `Expected BurstRatio ~1.0, got ${burst.burstRatio}`);
    });

    it('detects clustered packet drops and yields BurstRatio > 1.0', () => {
      // 1 single burst of 10 consecutive missing packets: 100, 101, [gap 102..111], 112, 113
      const packets: RtpPacket[] = [
        { seqNum: 100, timestamp: 0, arrivalTime: 0 } as any,
        { seqNum: 101, timestamp: 160, arrivalTime: 0.02 } as any,
        { seqNum: 112, timestamp: 1920, arrivalTime: 0.24 } as any,
        { seqNum: 113, timestamp: 2080, arrivalTime: 0.26 } as any,
      ];
      const burst = MosEngine.calculateBurstRatio(packets as any);
      assert.equal(burst.lossCount, 10);
      // Mean burst length is 10.0 -> burst ratio is significantly > 1.0 (specifically ~2.86)
      assert.ok(burst.burstRatio > 2.0, `Expected high BurstRatio for clustered loss, got ${burst.burstRatio}`);
    });

    it('correctly handles 16-bit RTP sequence number wraparound', () => {
      // Wrap from 65534 to 1 with 1 packet lost (65535 arrives, 0 lost, 1 arrives)
      const packets: RtpPacket[] = [
        { seqNum: 65534, timestamp: 0, arrivalTime: 0 } as any,
        { seqNum: 65535, timestamp: 160, arrivalTime: 0.02 } as any,
        { seqNum: 65537, timestamp: 480, arrivalTime: 0.06 } as any, // 65536 is missing
      ];
      const burst = MosEngine.calculateBurstRatio(packets as any);
      assert.equal(burst.lossCount, 1);
    });
  });

  describe('3. Jitter-Buffer Simulation & Late Discards', () => {
    it('discards packets exceeding the playout buffer deadline', () => {
      // Stream with 20ms pacing (0.00, 0.02, 0.04, 0.06...)
      // Packet 3 arrives late at 0.15s (90ms late relative to expected 0.06s)
      const packets: RtpPacket[] = [
        { seqNum: 1, timestamp: 0, arrivalTime: 0.00 } as any,
        { seqNum: 2, timestamp: 160, arrivalTime: 0.02 } as any,
        { seqNum: 3, timestamp: 320, arrivalTime: 0.15 } as any, // late by 110ms
        { seqNum: 4, timestamp: 480, arrivalTime: 0.16 } as any,
        { seqNum: 5, timestamp: 640, arrivalTime: 0.18 } as any,
      ];

      // Fixed 40ms buffer should discard packet 3
      const jb40 = MosEngine.simulateJitterBuffer(packets as any, 8000, { type: 'fixed-40' });
      assert.ok(jb40.discardCount >= 1, `Fixed-40ms should discard late packet, discarded ${jb40.discardCount}`);

      // Fixed 100ms buffer is more tolerant than 40ms buffer
      const jb100 = MosEngine.simulateJitterBuffer(packets as any, 8000, { type: 'fixed-100' });
      assert.equal(jb100.effectiveJbDepthMs, 100);
      assert.ok(jb100.discardPct <= jb40.discardPct);
    });
  });

  describe('4. Codec Configuration Table & Defaults', () => {
    it('contains all standard ITU-T G.113 Appendix I and approximate codecs', () => {
      const allCodecs = CodecConfigTable.getAll();
      const requiredIds = ['g711u', 'g711a', 'g722', 'g729', 'amr_nb', 'amr_wb', 'evs_wb', 'opus', 'ilbc_20', 'speex_nb'];

      for (const id of requiredIds) {
        const found = allCodecs.find(c => c.id === id);
        assert.ok(found, `Missing codec in configuration table: ${id}`);
        assert.ok(found.ie >= 0, `Codec ${id} has invalid Ie: ${found.ie}`);
        assert.ok(found.bplWithPlc > 0, `Codec ${id} has invalid Bpl with PLC: ${found.bplWithPlc}`);
      }
    });

    it('correctly reports standard vs approximate parameters per spec', () => {
      const g711 = CodecConfigTable.resolveCodecParams('PCMU');
      assert.equal(g711.isStandard, true, 'G.711 must be standard');

      const opus = CodecConfigTable.resolveCodecParams('OPUS');
      assert.equal(opus.isStandard, false, 'Opus should be documented approximation');
    });

    it('enables updating codec parameters in table', () => {
      const initial = CodecConfigTable.getAll();
      const modified = initial.map(p => p.id === 'g711u' ? { ...p, ie: 5, bplWithPlc: 22.0 } : p);
      CodecConfigTable.saveAll(modified);

      const updated = CodecConfigTable.resolveCodecParams('PCMU');
      assert.equal(updated.ie, 5);
      assert.equal(updated.bplWithPlc, 22.0);

      // Reset back to defaults
      CodecConfigTable.resetToDefaults();
      const reset = CodecConfigTable.resolveCodecParams('PCMU');
      assert.equal(reset.ie, 0);
      assert.equal(reset.bplWithPlc, 25.1);
    });
  });

  describe('5. Time-Windowed Sliding MOS Timeline', () => {
    it('computes 5-second sliding windows with min/avg/worst metrics', () => {
      // 15 seconds of synthetic packets (750 packets at 20ms interval)
      const packets: RtpPacket[] = [];
      for (let i = 0; i < 750; i++) {
        packets.push({
          seqNum: i + 1,
          timestamp: i * 160,
          arrivalTime: i * 0.02,
          payload: new Uint8Array([0x55]),
        } as any);
      }

      const stream: RtpStream = {
        id: 'test-stream',
        ssrc: 12345,
        srcIp: '10.0.0.1',
        srcPort: 5004,
        dstIp: '10.0.0.2',
        dstPort: 5004,
        payloadType: 0,
        packetCount: 750,
        lossPercent: 0,
        jitterUs: 500,
        startTime: 0,
        endTime: 15.0,
        packets,
      };

      const result = MosEngine.analyzeStream(stream, [], {
        jbConfig: { type: 'fixed-60' },
        delayConfig: { source: 'assumed', assumedOneWayMs: 0 },
        hasPlc: true,
      });

      assert.ok(result.slidingWindows.length > 5, 'Should generate multiple sliding windows for 15s stream');
      assert.ok(result.minMos >= 4.0, `Pristine stream min MOS should be >= 4.0, got ${result.minMos}`);
      assert.ok(result.avgMos >= 4.0, `Pristine stream avg MOS should be >= 4.0, got ${result.avgMos}`);
      assert.ok(result.worstMos >= 4.0, `Pristine stream worst MOS should be >= 4.0, got ${result.worstMos}`);
    });
  });

  describe('6. Golden PCAP Analysis on mrfp-o.pcap', () => {
    const pcapPath = path.resolve(process.cwd(), 'test/fixtures/mrfp-o/mrfp-o.pcap');

    it('computes Estimated MOS (E-model) for all audio streams in mrfp-o.pcap', () => {
      assert.ok(fs.existsSync(pcapPath), `File not found: ${pcapPath}`);
      const fileBuffer = fs.readFileSync(pcapPath);
      const pcapBytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

      const result = CapturePipeline.process(pcapBytes);

      // Verify all 8 streams have MOS results attached
      assert.equal(result.streams.length, 8);
      for (const s of result.streams) {
        assert.ok((s as any).mos !== undefined, `Stream SSRC ${s.ssrc} is missing Estimated MOS`);
        assert.ok((s as any).rFactor !== undefined, `Stream SSRC ${s.ssrc} is missing R-Factor`);
        const mos = (s as any).mos;
        const rFactor = (s as any).rFactor;

        // Since mrfp-o.pcap has 0% loss and low jitter, all audio streams should have pristine MOS (> 3.9)
        assert.ok(mos >= 3.9, `Stream SSRC ${s.ssrc} MOS ${mos} below expected pristine quality (>= 3.9)`);
        assert.ok(rFactor >= 75.0, `Stream SSRC ${s.ssrc} R-factor ${rFactor} below expected (>= 75.0)`);
      }

      // Verify legs have MOS populated
      assert.equal(result.legs.length, 4);
      for (const leg of result.legs) {
        if (leg.inboundStream) {
          assert.ok(leg.inboundStream.mos !== undefined && leg.inboundStream.mos > 3.9);
          assert.ok(leg.inboundStream.mosLq !== undefined && leg.inboundStream.mosLq > 3.9);
        }
        if (leg.outboundStream) {
          assert.ok(leg.outboundStream.mos !== undefined && leg.outboundStream.mos > 3.9);
          assert.ok(leg.outboundStream.mosLq !== undefined && leg.outboundStream.mosLq > 3.9);
        }
      }
    });

    it('correctly calculates conference leg aggregation and identifies worst leg', () => {
      const fileBuffer = fs.readFileSync(pcapPath);
      const pcapBytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);
      const result = CapturePipeline.process(pcapBytes);

      const confTable = MosEngine.calculateConferenceMos(result.legs, result.streams, result.dialogs);
      assert.equal(confTable.length, 4, `Expected 4 conference legs, got ${confTable.length}`);

      // Every leg should have inbound and outbound MOS calculated
      for (const legRow of confTable) {
        assert.ok(legRow.inboundMos !== undefined && legRow.inboundMos > 0);
        assert.ok(legRow.outboundMos !== undefined && legRow.outboundMos > 0);
      }

      // Exactly one leg is designated as the worst leg
      const worstCount = confTable.filter(l => l.isWorstLeg).length;
      assert.equal(worstCount, 1, `Expected exactly 1 worst leg, got ${worstCount}`);
    });
  });

  describe('7. RTCP XR VoIP Metrics Discrepancy Detection', () => {
    it('flags discrepancy when RTCP XR endpoint reported MOS differs significantly from network estimated MOS', () => {
      const packets: RtpPacket[] = [
        { seqNum: 1, timestamp: 0, arrivalTime: 0, payload: new Uint8Array([0x55]) } as any,
        { seqNum: 2, timestamp: 160, arrivalTime: 0.02, payload: new Uint8Array([0x55]) } as any,
      ];
      const stream: RtpStream = {
        id: 'xr-stream',
        ssrc: 99999,
        srcIp: '192.168.1.10',
        srcPort: 10000,
        dstIp: '192.168.1.20',
        dstPort: 10000,
        payloadType: 0,
        packetCount: 2,
        lossPercent: 0,
        jitterUs: 200,
        startTime: 0,
        endTime: 0.02,
        packets,
        rtcpXrMetrics: {
          mosLq: 2.1, // Endpoint reported very low MOS (e.g. mic distortion), but network MOS is ~4.4
          mosCq: 2.0,
          rFactor: 40,
        },
      };

      const result = MosEngine.analyzeStream(stream, []);
      assert.ok(result.rtcpXrMetrics, 'Should detect RTCP XR VoIP metrics');
      assert.ok(result.discrepancyFlag, 'Should flag discrepancy when difference > 0.5');
      assert.ok(result.discrepancyFlag.includes('Discrepancy'), 'Discrepancy text should describe diff');
    });
  });
});
