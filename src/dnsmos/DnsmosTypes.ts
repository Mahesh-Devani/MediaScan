/**
 * DnsmosTypes.ts
 * Type contracts for Microsoft DNSMOS P.835 / P.808 Speech Quality Assessment.
 */

export interface DnsmosWindowScore {
  windowIdx: number;
  startSec: number;
  endSec: number;
  sig_raw: number;
  bak_raw: number;
  ovrl_raw: number;
  sig: number;
  bak: number;
  ovrl: number;
  p808?: number;
}

export interface DnsmosConfidence {
  level: 'high' | 'medium' | 'low';
  reasons: string[];
}

export interface DnsmosFileInfo {
  fileName: string;
  fileHash?: string;
  channelIndex: number;
  channelName: string;
  totalChannels: number;
  formatName: string;
  rmsDbfs?: number;
  peakDbfs?: number;
  effectiveBandwidthHz?: number;
  isSilent?: boolean;
  silenceReason?: string;
  isMonoDownmix?: boolean;
}

export interface DnsmosResult {
  streamId: string;
  ssrc: number;
  legId?: string;
  direction?: 'inbound' | 'outbound';
  codec: string;
  originalSampleRate: number;
  modelSampleRate: number; // 16000
  fileInfo?: DnsmosFileInfo;

  range: {
    startSec: number;
    endSec: number;
    durationSec: number;
    isFullStream: boolean;
  };

  // Aggregated scores over windows
  sig: number; // Mean Speech Signal Quality (1.0 .. 5.0)
  bak: number; // Mean Background Noise Intrusion (1.0 .. 5.0)
  ovrl: number; // Mean Overall Quality (1.0 .. 5.0)
  p808?: number; // Mean P.808 Overall Listening Quality (1.0 .. 5.0)

  // Min / Max / Weighted
  sig_min: number;
  sig_max: number;
  sig_weighted: number;

  bak_min: number;
  bak_max: number;
  bak_weighted: number;

  ovrl_min: number;
  ovrl_max: number;
  ovrl_weighted: number;

  p808_min?: number;
  p808_max?: number;
  p808_weighted?: number;

  windowCount: number;
  windows: DnsmosWindowScore[];

  confidence: DnsmosConfidence;
  realtimeFactor: number; // Audio seconds processed per compute second
  computeTimeMs: number;

  isPersonalized: boolean;
  modelVersion: string;
}

export interface DnsmosComparisonResult {
  inputResult: DnsmosResult;
  outputResult: DnsmosResult;
  deltaSig: number; // output.sig - input.sig
  deltaBak: number; // output.bak - input.bak
  deltaOvrl: number; // output.ovrl - input.ovrl
  verdict: 'bak_up_sig_down' | 'bak_flat' | 'all_down' | 'effective_nr' | 'neutral';
  diagnosticExplanation: string;
}

export interface DnsmosOptions {
  isPersonalized?: boolean;
  includeP808?: boolean;
  speechOnlyVad?: boolean;
  modelBaseUrl?: string;
  wasmBaseUrl?: string;
}

export interface DnsmosWorkerTask {
  taskId: string;
  audioPcm: Float32Array; // 16kHz mono float32
  sampleRate: number;
  originalSampleRate: number;
  streamId: string;
  ssrc: number;
  legId?: string;
  direction?: 'inbound' | 'outbound';
  codec: string;
  startSec: number;
  endSec: number;
  isFullStream: boolean;
  options: DnsmosOptions;
  fileInfo?: DnsmosFileInfo;
}

export interface DnsmosWorkerResponse {
  taskId: string;
  success: boolean;
  result?: DnsmosResult;
  error?: string;
}
