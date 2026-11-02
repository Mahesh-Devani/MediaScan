/**
 * MosTypes.ts
 * Type definitions for ITU-T G.107 E-model Estimated MOS calculation.
 */

export interface CodecModelParams {
  id: string;
  name: string;
  sampleRate: number; // Hz
  ie: number; // Equipment Impairment Factor (default / no loss)
  bplWithPlc: number; // Packet Loss Robustness factor with PLC
  bplWithoutPlc: number; // Packet Loss Robustness factor without PLC
  isStandard: boolean; // true = standard ITU-T G.113 App I; false = documented approx
  notes?: string;
}

export type JitterBufferType = 'fixed-40' | 'fixed-60' | 'fixed-100' | 'adaptive' | 'custom';

export interface JitterBufferConfig {
  type: JitterBufferType;
  customDepthMs?: number; // used if type === 'custom'
}

export interface DelayConfig {
  source: 'rtcp' | 'assumed';
  assumedOneWayMs: number; // User-assumed one-way network delay (default 0 or 50 ms)
}

export interface MosWindowSample {
  startSec: number;
  endSec: number;
  packetCount: number;
  lossCount: number;
  lossPct: number;
  discardCount: number;
  discardPct: number;
  effectiveLossPct: number;
  jitterMs: number;
  burstRatio: number;
  rFactor: number;
  mos: number;
}

export interface RtcpXrVoipMetrics {
  ssrc: number;
  lossRate: number; // fraction 0..1
  discardRate: number; // fraction 0..1
  burstDensity: number;
  gapDensity: number;
  burstDurationMs: number;
  gapDurationMs: number;
  roundTripDelayMs: number;
  endSystemDelayMs: number;
  signalLevelDbm: number;
  noiseLevelDbm: number;
  rerlDb: number;
  rFactor: number;
  extRFactor: number;
  mosLq: number;
  mosCq: number;
}

export interface StreamMosResult {
  streamId: string;
  ssrc: number;
  codec: string;
  clockRate: number;
  direction: 'inbound' | 'outbound';
  capturePointNotice: string;

  // Loss & Impairment inputs
  packetCount: number;
  networkLossCount: number;
  networkLossPct: number;
  discardCount: number;
  discardPct: number;
  effectiveLossPct: number;
  burstRatio: number;
  avgBurstLength: number;

  // Jitter & Delay inputs
  avgJitterMs: number;
  maxJitterMs: number;
  delayUsedMs: number;
  delaySource: 'rtcp' | 'assumed';
  jitterBufferDepthMs: number;
  jitterBufferType: JitterBufferType;

  // E-model outputs
  r0_minus_is: number;
  ie: number;
  bpl: number;
  ie_eff: number;
  id: number;
  advantageFactor: number;
  rFactor: number; // Overall R
  mos: number; // Overall MOS (Conversational if delay used, else listening)
  mosLq: number; // MOS-LQ (Listening Quality, Id = 0)
  mosCq: number; // MOS-CQ (Conversational Quality, with Id)

  // Sliding timeline metrics (5s windows)
  slidingWindows: MosWindowSample[];
  minMos: number;
  avgMos: number;
  worstMos: number;

  // RTCP XR Comparison if available
  rtcpXrMetrics?: RtcpXrVoipMetrics;
  discrepancyFlag?: string;

  // Degradation summary
  hasLowMosAnomaly: boolean;
  hasSustainedDegradation: boolean;
}

export interface ConferenceLegMos {
  legId: string;
  participantLabel: string;
  inboundMos?: number;
  inboundR?: number;
  outboundMos?: number;
  outboundR?: number;
  worstMos: number;
  isWorstLeg: boolean;
}

export interface MosCalculationInput {
  codecName: string;
  clockRate: number;
  packetLossPct: number;
  discardPct?: number;
  burstRatio?: number;
  oneWayDelayMs?: number;
  jitterMs?: number;
  hasPlc?: boolean;
  r0_minus_is?: number;
  advantageFactor?: number;
}
