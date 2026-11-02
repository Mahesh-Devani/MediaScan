/**
 * MosEngine.ts
 * Pure-function implementation of ITU-T G.107 E-model for passive Estimated MOS computation.
 * Features:
 * - RFC 3550 sequence loss and Gilbert-model burst ratio estimation.
 * - Jitter buffer playout delay simulation (fixed 40/60/100ms and adaptive).
 * - RTCP RTT detection or configurable assumed delay.
 * - ITU-T G.107 Id delay impairment and Ie_eff packet loss impairment.
 * - MOS-LQ (listening) and MOS-CQ (conversational) scoring.
 * - Time-windowed 5s sliding MOS timeline (min, avg, worst).
 * - Conference leg aggregation & worst-leg detection.
 */

import type {
  CodecModelParams,
  JitterBufferConfig,
  DelayConfig,
  MosWindowSample,
  StreamMosResult,
  ConferenceLegMos,
  MosCalculationInput,
} from './MosTypes.ts';
import { CodecConfigTable } from './CodecConfigTable.ts';
import { StreamAudioDecoder } from '../decoders/StreamAudioDecoder.ts';
import type { RtpStream, StoredRtpPacket } from '../rtp/RtpDemuxer.ts';
import type { SipDialog } from '../sip/DialogManager.ts';
import type { Leg } from '../ladder/LadderTypes.ts';

export class MosEngine {
  /**
   * Pure E-model calculation: maps R transmission rating factor to MOS (1.0 .. 4.5).
   * Formula from ITU-T G.107 Section 4.3:
   * For R < 0: MOS = 1.0
   * For R > 100: MOS = 4.5
   * For 0 <= R <= 100:
   *   MOS = 1 + 0.035*R + 7e-6*R*(R - 60)*(100 - R)
   */
  public static rToMos(r: number): number {
    if (r <= 0) return 1.0;
    if (r >= 100) return 4.5;
    const mos = 1.0 + 0.035 * r + 7.0e-6 * r * (r - 60.0) * (100.0 - r);
    return Math.min(4.5, Math.max(1.0, Number(mos.toFixed(3))));
  }

  /**
   * Calculates ITU-T G.107 Delay Impairment factor Id from one-way absolute delay Ta (ms).
   * G.107 simplified piecewise delay formula:
   * For Ta <= 100 ms: Id = 0
   * For Ta > 100 ms:
   *   Id = 0.024 * Ta + 0.11 * (Ta - 177.3) * H(Ta - 177.3)
   * where H(x) = 1 if x > 0 else 0.
   */
  public static calculateId(oneWayDelayMs: number): number {
    const ta = Math.max(0, oneWayDelayMs);
    if (ta <= 100.0) return 0.0;
    let id = 0.024 * ta;
    if (ta > 177.3) {
      id += 0.11 * (ta - 177.3);
    }
    return Number(id.toFixed(2));
  }

  /**
   * Calculates Equipment Impairment factor Ie,eff under packet loss and burstiness.
   * Formula from ITU-T G.107 / G.113:
   * Ie_eff = Ie + (95 - Ie) * Ppl / ( (Ppl / BurstR) + Bpl )
   * where:
   * - Ppl is effective packet loss percentage (0..100)
   * - BurstR is Gilbert burst ratio (>= 1.0; 1.0 for random loss)
   * - Bpl is packet loss robustness factor
   */
  public static calculateIeEff(ie: number, bpl: number, ppl: number, burstR: number = 1.0): number {
    const p = Math.max(0, Math.min(100, ppl));
    if (p <= 0.0001) return ie;
    const br = Math.max(1.0, burstR);
    const b = Math.max(0.1, bpl);
    const denom = p / br + b;
    if (denom <= 0) return ie;
    const ieEff = ie + (95.0 - ie) * (p / denom);
    return Number(Math.min(95.0, Math.max(ie, ieEff)).toFixed(2));
  }

  /**
   * Pure R-factor transmission rating calculation:
   * R = (R0 - Is) - Id - Ie_eff + A
   */
  public static calculateR(
    r0_minus_is: number = 93.2,
    id: number = 0,
    ie_eff: number = 0,
    advantageFactor: number = 0
  ): number {
    const r = r0_minus_is - id - ie_eff + advantageFactor;
    return Number(Math.max(0, Math.min(100, r)).toFixed(2));
  }

  /**
   * Fast pure-function calculation: takes high-level network stats and returns Estimated MOS and R.
   */
  public static calculateMos(input: MosCalculationInput): {
    rFactor: number;
    rLq: number;
    mos: number;
    mosLq: number;
    mosCq: number;
    ie_eff: number;
    id: number;
  } {
    const codec = CodecConfigTable.resolveCodecParams(input.codecName, input.clockRate);
    const bpl = input.hasPlc === false ? codec.bplWithoutPlc : codec.bplWithPlc;
    const effectiveLoss = Math.min(100, (input.packetLossPct || 0) + (input.discardPct || 0));
    const burstR = input.burstRatio || 1.0;
    const delay = input.oneWayDelayMs || 0;
    const r0_minus_is = input.r0_minus_is ?? 93.2;
    const a = input.advantageFactor ?? 0;

    const ie_eff = this.calculateIeEff(codec.ie, bpl, effectiveLoss, burstR);
    const id = this.calculateId(delay);

    const rFactor = this.calculateR(r0_minus_is, id, ie_eff, a);
    const rLq = this.calculateR(r0_minus_is, 0, ie_eff, a); // Listening quality (no delay)

    const mos = this.rToMos(rFactor);
    const mosLq = this.rToMos(rLq);
    const mosCq = mos;

    return {
      rFactor,
      rLq,
      mos,
      mosLq,
      mosCq,
      ie_eff,
      id,
    };
  }

  /**
   * Derives Gilbert-model loss burst ratio from packet sequence numbers.
   * Scans sorted extended sequence numbers, detects gaps, and computes:
   * - Total lost packets (N_loss)
   * - Number of loss bursts (N_bursts)
   * - Mean burst length E[B] = N_loss / N_bursts
   * - Expected random loss burst length E[B]_random = 1 / (1 - p)
   * - Burst Ratio = E[B] / E[B]_random = N_loss * (1 - p) / N_bursts
   */
  public static calculateBurstRatio(packets: StoredRtpPacket[]): {
    burstRatio: number;
    avgBurstLength: number;
    lossCount: number;
  } {
    if (!packets || packets.length <= 1) {
      return { burstRatio: 1.0, avgBurstLength: 1.0, lossCount: 0 };
    }

    // Filter out Comfort Noise (PT 13) and filter unique extended sequence numbers
    const validPackets = packets.filter(p => !p.payload || p.payload.length > 0);
    if (validPackets.length <= 1) {
      return { burstRatio: 1.0, avgBurstLength: 1.0, lossCount: 0 };
    }

    const seqs = Array.from(new Set(validPackets.map(p => (p.extendedSeq !== undefined ? p.extendedSeq : (p as any).seqNum)))).sort((a, b) => a - b);
    let lossCount = 0;
    let burstCount = 0;

    for (let i = 0; i < seqs.length - 1; i++) {
      const gap = seqs[i + 1] - seqs[i] - 1;
      if (gap > 0) {
        lossCount += gap;
        burstCount++;
      }
    }

    if (lossCount === 0 || burstCount === 0) {
      return { burstRatio: 1.0, avgBurstLength: 1.0, lossCount: 0 };
    }

    const totalPackets = seqs.length + lossCount;
    const p = lossCount / totalPackets;
    const avgBurstLength = lossCount / burstCount;

    // Burst ratio under Gilbert model:
    // When loss is perfectly random (Bernoulli), BurstR = 1.0.
    // When loss is clustered/bursty, BurstR > 1.0.
    let burstRatio = 1.0;
    if (p < 0.999) {
      burstRatio = avgBurstLength * (1.0 - p);
    }
    burstRatio = Math.max(1.0, Math.min(20.0, Number(burstRatio.toFixed(2))));

    return {
      burstRatio,
      avgBurstLength: Number(avgBurstLength.toFixed(2)),
      lossCount,
    };
  }

  /**
   * Simulates a receiver Jitter Buffer to determine late packet discard counts.
   * Supports fixed playout depths (40ms, 60ms, 100ms, or custom) and adaptive buffer.
   */
  public static simulateJitterBuffer(
    packets: StoredRtpPacket[],
    clockRate: number = 8000,
    config: JitterBufferConfig = { type: 'fixed-60' }
  ): {
    discardCount: number;
    discardPct: number;
    effectiveJbDepthMs: number;
    avgJitterMs: number;
    maxJitterMs: number;
  } {
    if (!packets || packets.length <= 1) {
      return { discardCount: 0, discardPct: 0, effectiveJbDepthMs: 60, avgJitterMs: 0, maxJitterMs: 0 };
    }

    // Determine target buffer depth (in seconds)
    let fixedDepthSec = 0.06; // default 60ms
    if (config.type === 'fixed-40') fixedDepthSec = 0.04;
    else if (config.type === 'fixed-60') fixedDepthSec = 0.06;
    else if (config.type === 'fixed-100') fixedDepthSec = 0.1;
    else if (config.type === 'custom' && config.customDepthMs) fixedDepthSec = config.customDepthMs / 1000;

    let discardCount = 0;
    let jitterSumSec = 0;
    let maxJitterSec = 0;
    let currentJitterSec = 0;

    // Baseline transit tracking
    const firstPkt = packets[0];
    const t0Arr = firstPkt.pktTime !== undefined ? firstPkt.pktTime : ((firstPkt as any).arrivalTime ?? 0);
    const t0Ts = firstPkt.timestamp;

    let minTransitSec = Infinity;
    const transitDeltas: number[] = new Array(packets.length);

    for (let i = 0; i < packets.length; i++) {
      const p = packets[i];
      const pTime = p.pktTime !== undefined ? p.pktTime : ((p as any).arrivalTime ?? 0);
      // Timestamp delta from first packet
      let deltaTs = p.timestamp - t0Ts;
      if (deltaTs < -0x80000000) deltaTs += 0x100000000;
      const tsTimeSec = deltaTs / clockRate;

      // Transit relative delay: (arrival - send_time)
      const relTransit = (pTime - t0Arr) - tsTimeSec;
      transitDeltas[i] = relTransit;
      if (relTransit < minTransitSec) {
        minTransitSec = relTransit;
      }

      // RFC 3550 Interarrival Jitter tracking
      if (i > 0) {
        const prev = packets[i - 1];
        const prevTime = prev.pktTime !== undefined ? prev.pktTime : ((prev as any).arrivalTime ?? 0);
        let dTs = p.timestamp - prev.timestamp;
        if (dTs < -0x80000000) dTs += 0x100000000;
        const dTransit = Math.abs((pTime - prevTime) - (dTs / clockRate));
        currentJitterSec += (dTransit - currentJitterSec) / 16.0;
        jitterSumSec += currentJitterSec;
        if (currentJitterSec > maxJitterSec) maxJitterSec = currentJitterSec;
      }
    }

    // Check packet playout against jitter buffer window
    let adaptiveDepthSum = 0;
    for (let i = 0; i < packets.length; i++) {
      const delayBeyondMinSec = transitDeltas[i] - minTransitSec;

      let allowedWindowSec = fixedDepthSec;
      if (config.type === 'adaptive') {
        // Adaptive jitter buffer: 2.5 * current Jitter + 10ms safety floor (bounded 20..200ms)
        allowedWindowSec = Math.max(0.02, Math.min(0.2, 2.5 * currentJitterSec + 0.01));
        adaptiveDepthSum += allowedWindowSec;
      }

      if (delayBeyondMinSec > allowedWindowSec) {
        discardCount++;
      }
    }

    const effectiveJbDepthMs = config.type === 'adaptive'
      ? Math.round((adaptiveDepthSum / Math.max(1, packets.length)) * 1000)
      : Math.round(fixedDepthSec * 1000);

    const discardPct = Number(((discardCount / packets.length) * 100).toFixed(2));
    const avgJitterMs = Number(((jitterSumSec / Math.max(1, packets.length - 1)) * 1000).toFixed(2));
    const maxJitterMs = Number((maxJitterSec * 1000).toFixed(2));

    return {
      discardCount,
      discardPct,
      effectiveJbDepthMs,
      avgJitterMs,
      maxJitterMs,
    };
  }

  /**
   * Computes sliding MOS timeline samples across 5-second sliding windows (default 1s hop).
   */
  private static getPktTime(p: any): number {
    return p.pktTime !== undefined ? p.pktTime : (p.arrivalTime !== undefined ? p.arrivalTime : 0);
  }

  public static calculateSlidingMos(
    packets: StoredRtpPacket[],
    clockRate: number,
    codecParams: CodecModelParams,
    jbConfig: JitterBufferConfig,
    oneWayDelayMs: number,
    hasPlc: boolean = true,
    windowSec: number = 5.0,
    hopSec: number = 1.0
  ): MosWindowSample[] {
    if (!packets || packets.length === 0) return [];

    const startTime = this.getPktTime(packets[0]);
    const endTime = this.getPktTime(packets[packets.length - 1]);
    const duration = endTime - startTime;

    if (duration <= 0) return [];

    const samples: MosWindowSample[] = [];
    const bpl = hasPlc ? codecParams.bplWithPlc : codecParams.bplWithoutPlc;
    const id = this.calculateId(oneWayDelayMs);

    for (let t = 0; t < duration; t += hopSec) {
      const wStart = startTime + t;
      const wEnd = Math.min(endTime, wStart + windowSec);

      // Binary search / filter packets in this window
      const winPackets = packets.filter(p => {
        const pt = this.getPktTime(p);
        return pt >= wStart && pt < wEnd;
      });
      if (winPackets.length === 0) continue;

      // Burstiness & network loss in this window
      const { burstRatio, lossCount: winLoss } = this.calculateBurstRatio(winPackets);
      const totalExpected = winPackets.length + winLoss;
      const lossPct = totalExpected > 0 ? (winLoss / totalExpected) * 100 : 0;

      // Discard simulation in window
      const { discardCount: winDisc, discardPct, avgJitterMs } = this.simulateJitterBuffer(winPackets, clockRate, jbConfig);
      const effectiveLossPct = Math.min(100, lossPct + discardPct);

      // Compute G.107 E-model for window
      const ie_eff = this.calculateIeEff(codecParams.ie, bpl, effectiveLossPct, burstRatio);
      const r = this.calculateR(93.2, id, ie_eff, 0);
      const mos = this.rToMos(r);

      samples.push({
        startSec: Number(t.toFixed(1)),
        endSec: Number((t + windowSec).toFixed(1)),
        packetCount: winPackets.length,
        lossCount: winLoss,
        lossPct: Number(lossPct.toFixed(1)),
        discardCount: winDisc,
        discardPct,
        effectiveLossPct: Number(effectiveLossPct.toFixed(1)),
        jitterMs: avgJitterMs,
        burstRatio,
        rFactor: r,
        mos,
      });
    }

    return samples;
  }

  /**
   * High-level stream analyzer: takes an RtpStream and produces a complete StreamMosResult.
   */
  public static analyzeStream(
    stream: RtpStream,
    dialogs: SipDialog[] = [],
    options: {
      jbConfig?: JitterBufferConfig;
      delayConfig?: DelayConfig;
      hasPlc?: boolean;
      customParams?: CodecModelParams;
    } = {}
  ): StreamMosResult {
    const jbConfig = options.jbConfig || { type: 'fixed-60' };
    const delayConfig = options.delayConfig || { source: 'assumed', assumedOneWayMs: 0 };
    const hasPlc = options.hasPlc !== false;

    // Resolve codec parameters from table or override
    const info = StreamAudioDecoder.resolveCodec(stream, dialogs);
    const codecName = info.name || 'PCMU';
    const clockRate = stream.clockRate || (info.clockRate ?? 8000);

    const codecParams = options.customParams || CodecConfigTable.resolveCodecParams(codecName, clockRate);
    const bpl = hasPlc ? codecParams.bplWithPlc : codecParams.bplWithoutPlc;

    // Filter audio packets (excluding telephone-event / comfort noise)
    const audioPackets = (stream.packets || []).filter(
      p => !p.payload || (p.payload.length > 0 && p.payload.length !== 4 && (p.payload[0] & 0x7f) !== 13)
    );

    // 1. Loss & Burst Ratio
    const { burstRatio, avgBurstLength, lossCount: networkLossCount } = this.calculateBurstRatio(audioPackets);
    const totalExpected = audioPackets.length + networkLossCount;
    const networkLossPct = totalExpected > 0 ? (networkLossCount / totalExpected) * 100 : 0;

    // 2. Jitter Buffer Simulation & Discards
    const { discardCount, discardPct, effectiveJbDepthMs, avgJitterMs, maxJitterMs } = this.simulateJitterBuffer(
      audioPackets,
      clockRate,
      jbConfig
    );

    const effectiveLossPct = Math.min(100, networkLossPct + discardPct);

    // 3. Delay Determination
    let delayUsedMs = 0;
    let delaySource: 'rtcp' | 'assumed' = 'assumed';

    if (delayConfig.source === 'rtcp' && (stream as any).rtcpRttMs) {
      delayUsedMs = Math.round(((stream as any).rtcpRttMs / 2) + effectiveJbDepthMs);
      delaySource = 'rtcp';
    } else {
      delayUsedMs = Math.round(delayConfig.assumedOneWayMs + effectiveJbDepthMs);
      delaySource = 'assumed';
    }

    // 4. ITU-T G.107 E-model calculations
    const r0_minus_is = 93.2;
    const advantageFactor = 0;
    const ie_eff = this.calculateIeEff(codecParams.ie, bpl, effectiveLossPct, burstRatio);
    const id = this.calculateId(delayUsedMs);

    const rFactor = this.calculateR(r0_minus_is, id, ie_eff, advantageFactor);
    const rLq = this.calculateR(r0_minus_is, 0, ie_eff, advantageFactor);

    const mos = this.rToMos(rFactor);
    const mosLq = this.rToMos(rLq);
    const mosCq = mos;

    // 5. Sliding 5-second windows
    const slidingWindows = this.calculateSlidingMos(
      audioPackets,
      clockRate,
      codecParams,
      jbConfig,
      delayUsedMs,
      hasPlc,
      5.0,
      1.0
    );

    let minMos = mos;
    let worstMos = mos;
    let sumMos = 0;
    let countMos = 0;

    let sustainedDegradationCount = 0;
    let hasSustainedDegradation = false;

    if (slidingWindows.length > 0) {
      minMos = slidingWindows[0].mos;
      worstMos = slidingWindows[0].mos;

      for (const w of slidingWindows) {
        sumMos += w.mos;
        countMos++;
        if (w.mos < minMos) minMos = w.mos;
        if (w.mos < worstMos) worstMos = w.mos;

        if (w.mos < 3.1) {
          sustainedDegradationCount++;
          if (sustainedDegradationCount >= 5) {
            hasSustainedDegradation = true;
          }
        } else {
          sustainedDegradationCount = 0;
        }
      }
    }

    const avgMos = countMos > 0 ? Number((sumMos / countMos).toFixed(2)) : mos;
    const hasLowMosAnomaly = mos < 3.6;

    // 6. Direction & Capture point notice
    // Default: classify inbound vs outbound based on media server IP
    const direction: 'inbound' | 'outbound' = (stream as any).direction || 'inbound';
    const capturePointNotice = direction === 'inbound'
      ? 'Inbound stream: MOS accurately measures client network impairment up to this capture point.'
      : 'Outbound stream: Originates from Media Server egress. Network packet loss has not occurred yet; degradation reflects Media Server jitter/discards.';

    // 7. Check for RTCP XR VoIP Metrics discrepancy
    const rtcpXrMetrics: any = (stream as any).rtcpXrMetrics;
    let discrepancyFlag: string | undefined;
    if (rtcpXrMetrics && rtcpXrMetrics.mosCq > 0) {
      const diff = Math.abs(mos - rtcpXrMetrics.mosCq);
      if (diff > 0.5) {
        discrepancyFlag = `Discrepancy: Network E-model estimated ${mos}, but endpoint reported RTCP XR MOS ${rtcpXrMetrics.mosCq} (Δ = ${diff.toFixed(2)}).`;
      }
    }

    return {
      streamId: stream.id,
      ssrc: stream.ssrc,
      codec: codecParams.name,
      clockRate,
      direction,
      capturePointNotice,

      packetCount: audioPackets.length,
      networkLossCount,
      networkLossPct: Number(networkLossPct.toFixed(2)),
      discardCount,
      discardPct,
      effectiveLossPct: Number(effectiveLossPct.toFixed(2)),
      burstRatio,
      avgBurstLength,

      avgJitterMs,
      maxJitterMs,
      delayUsedMs,
      delaySource,
      jitterBufferDepthMs: effectiveJbDepthMs,
      jitterBufferType: jbConfig.type,

      r0_minus_is,
      ie: codecParams.ie,
      bpl,
      ie_eff,
      id,
      advantageFactor,
      rFactor,
      mos,
      mosLq,
      mosCq,

      slidingWindows,
      minMos: Number(minMos.toFixed(2)),
      avgMos,
      worstMos: Number(worstMos.toFixed(2)),

      rtcpXrMetrics,
      discrepancyFlag,

      hasLowMosAnomaly,
      hasSustainedDegradation,
    };
  }

  /**
   * Aggregates MOS across all participants in a conference or bridged conversation.
   * Compares Inbound (Participant -> MS) and Outbound (MS -> Participant) and flags the worst leg.
   */
  public static calculateConferenceMos(
    legs: Leg[],
    streams: RtpStream[],
    dialogs: SipDialog[] = [],
    options?: any
  ): ConferenceLegMos[] {
    const results: ConferenceLegMos[] = [];
    let lowestMos = Infinity;
    let worstIndex = -1;

    legs.forEach((leg, idx) => {
      let inMos: number | undefined;
      let inR: number | undefined;
      let outMos: number | undefined;
      let outR: number | undefined;

      if (leg.inboundStream) {
        const stream = streams.find(s => s.ssrc === leg.inboundStream?.ssrc) || (leg.inboundStream as any);
        if (stream && stream.packets) {
          const res = this.analyzeStream(stream, dialogs, options);
          inMos = res.mos;
          inR = res.rFactor;
        }
      }

      if (leg.outboundStream) {
        const stream = streams.find(s => s.ssrc === leg.outboundStream?.ssrc) || (leg.outboundStream as any);
        if (stream && stream.packets) {
          const res = this.analyzeStream(stream, dialogs, options);
          outMos = res.mos;
          outR = res.rFactor;
        }
      }

      const legWorst = Math.min(
        inMos !== undefined ? inMos : 5.0,
        outMos !== undefined ? outMos : 5.0
      );

      const participantLabel = leg.fromUser ? `${leg.id}: ${leg.fromUser}` : `${leg.id} (${leg.remoteEndpoint.ip}:${leg.remoteEndpoint.port})`;

      results.push({
        legId: leg.id,
        participantLabel,
        inboundMos: inMos,
        inboundR: inR,
        outboundMos: outMos,
        outboundR: outR,
        worstMos: legWorst < 5.0 ? legWorst : 0,
        isWorstLeg: false,
      });

      if (legWorst < lowestMos && legWorst > 0) {
        lowestMos = legWorst;
        worstIndex = idx;
      }
    });

    if (worstIndex >= 0) {
      results[worstIndex].isWorstLeg = true;
    }

    return results;
  }
}
