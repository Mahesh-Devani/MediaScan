export interface MediaServer {
  id: string;
  ip: string;
  portRange?: { min: number; max: number };
  confidence: number;
  detectionReason: 'sdp_common_c_line' | 'rtp_endpoint_frequency' | 'user_override';
  isUserPinned: boolean;
}

export interface StreamSummary {
  ssrc: number;
  pt: number;
  codec: string;
  packetCount: number;
  octetCount: number;
  lossCount: number;
  lossPercent: number;
  jitterUs: number;
  startTime: number;
  endTime: number;
  duration: number;
  isEncrypted: boolean;
  hasSilenceStuffing: boolean;
  telephoneEvents: Array<{ event: number; time: number; duration: number }>;
}

export interface Anomaly {
  severity: 'warning' | 'error';
  type:
    | 'one_way_media'
    | 'no_media_after_200ok'
    | 'no_rtcp'
    | 'midcall_ssrc_change'
    | 'sdp_pt_mismatch'
    | 'sequence_jump_duplicate'
    | 'large_packet_gap'
    | 'media_after_bye'
    | 'sdp_port_mismatch';
  description: string;
  packetNumber?: number;
  timestamp?: number;
}

export interface Leg {
  id: string; // e.g. "Leg A", "Leg B"
  callId?: string;
  fromUser?: string;
  toUser?: string;
  remoteEndpoint: { ip: string; port: number };
  msEndpoint: { ip: string; port: number };
  isCorrelatedWithSip: boolean;
  sdpDirection: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  negotiatedCodecs: Array<{ pt: number; name: string; clockRate: number }>;
  ptime?: number;
  inboundStream?: StreamSummary;  // Remote -> MS
  outboundStream?: StreamSummary; // MS -> Remote
  anomalies: Anomaly[];
}

export interface Conversation {
  id: string; // "Conversation 1", "Conversation 2", ...
  classification: 'Bridged' | 'Conference';
  legs: Leg[];
  groupingRule: 'ConferenceIdentifier' | 'B2BUACorrelation' | 'TimingHeuristic' | 'Manual';
  startTime: number;
  endTime: number;
  conferenceUri?: string;
}

export interface StreamEvent {
  time: number;
  legId: string;
  type:
    | 'stream_start'
    | 'stream_stop'
    | 'ssrc_change'
    | 'pt_change'
    | 'dtmf'
    | 'rtcp_sr'
    | 'rtcp_rr'
    | 'silence_gap'
    | 'early_media';
  description: string;
}
