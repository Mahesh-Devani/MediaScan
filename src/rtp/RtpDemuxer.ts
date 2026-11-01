export interface RtpPacket {
  version: number;
  padding: boolean;
  extension: boolean;
  csrcCount: number;
  marker: boolean;
  payloadType: number;
  sequenceNumber: number;
  timestamp: number;
  ssrc: number;
  payload: Uint8Array;
}

export interface RtcpPacket {
  version: number;
  payloadType: number;
  count: number;
  lengthWords: number;
  senderSsrc: number;
  data: Uint8Array;
}

export interface StoredRtpPacket {
  seq: number;
  extendedSeq: number;
  timestamp: number;
  pktTime: number;
  marker: boolean;
  payload: Uint8Array;
}

export interface RtpStream {
  id: string;
  ssrc: number;
  payloadType: number;
  srcIp: string;
  srcPort: number;
  dstIp: string;
  dstPort: number;
  startTime: number;
  endTime: number;
  firstSeq: number;
  lastSeq: number;
  minExtendedSeq: number;
  maxExtendedSeq: number;
  wrapCycles: number;
  firstTimestamp: number;
  lastTimestamp: number;
  packetCount: number;
  octetCount: number;
  lossCount: number;
  lossPercent: number;
  jitterUs: number;
  clockRate: number;
  packets: StoredRtpPacket[];
  telephoneEvents: Array<{ event: number; time: number; duration: number }>;
}

export class RtpDemuxer {
  private streams: Map<string, RtpStream> = new Map();
  // Map of dynamic payload types to clock rate
  private ptClockRates: Map<number, number> = new Map();
  private telephoneEventPts: Set<number> = new Set();

  constructor() {
    // Default standard clock rates
    this.ptClockRates.set(0, 8000);   // PCMU
    this.ptClockRates.set(8, 8000);   // PCMA
    this.ptClockRates.set(9, 16000);  // G722 (sampling 16k, RFC 3551 uses 8k timestamp)
    this.ptClockRates.set(18, 8000);  // G729
    this.ptClockRates.set(100, 8000); // AMR default
    this.ptClockRates.set(101, 16000);// AMR-WB default
  }

  public setClockRate(pt: number, rate: number): void {
    this.ptClockRates.set(pt, rate);
  }

  public registerTelephoneEventPt(pt: number): void {
    this.telephoneEventPts.add(pt);
  }

  /**
   * Fast header validation and parse for RFC 3550 RTP.
   */
  public static parseRtp(data: Uint8Array): RtpPacket | null {
    if (data.length < 12) return null;

    const b0 = data[0];
    const version = (b0 >> 6) & 0x03;
    if (version !== 2) return null; // Only RTP v2

    const padding = Boolean(b0 & 0x20);
    const extension = Boolean(b0 & 0x10);
    const csrcCount = b0 & 0x0f;

    const b1 = data[1];
    const marker = Boolean(b1 & 0x80);
    const payloadType = b1 & 0x7f;

    const sequenceNumber = (data[2] << 8) | data[3];
    const timestamp = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
    const ssrc = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;

    let offset = 12 + csrcCount * 4;
    if (offset > data.length) return null;

    // Handle Extension Header
    if (extension) {
      if (offset + 4 > data.length) return null;
      const extLenWords = (data[offset + 2] << 8) | data[offset + 3];
      offset += 4 + extLenWords * 4;
      if (offset > data.length) return null;
    }

    let payloadEnd = data.length;
    if (padding && payloadEnd > offset) {
      const padLen = data[payloadEnd - 1];
      if (padLen > 0 && padLen <= payloadEnd - offset) {
        payloadEnd -= padLen;
      }
    }

    const payload = data.subarray(offset, payloadEnd);

    return {
      version,
      padding,
      extension,
      csrcCount,
      marker,
      payloadType,
      sequenceNumber,
      timestamp,
      ssrc,
      payload,
    };
  }

  /**
   * Fast header validation and parse for RFC 3550 RTCP.
   */
  public static parseRtcp(data: Uint8Array): RtcpPacket | null {
    if (data.length < 8) return null;

    const b0 = data[0];
    const version = (b0 >> 6) & 0x03;
    if (version !== 2) return null;

    const count = b0 & 0x1f;
    const payloadType = data[1];
    // RTCP PTs are usually 200..207
    if (payloadType < 200 || payloadType > 207) return null;

    const lengthWords = ((data[2] << 8) | data[3]) + 1;
    const senderSsrc = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;

    return {
      version,
      payloadType,
      count,
      lengthWords,
      senderSsrc,
      data,
    };
  }

  /**
   * Dispatches an RTP packet into the corresponding stream with jitter & loss calculation.
   */
  public addPacket(
    pkt: RtpPacket,
    pktTime: number,
    srcIp: string,
    srcPort: number,
    dstIp: string,
    dstPort: number,
  ): RtpStream {
    // Key streams by SSRC + dstIp:dstPort
    const streamKey = `${pkt.ssrc}_${dstIp}_${dstPort}`;
    let s = this.streams.get(streamKey);

    if (!s) {
      const clockRate = this.ptClockRates.get(pkt.payloadType) || 8000;
      s = {
        id: streamKey,
        ssrc: pkt.ssrc,
        payloadType: pkt.payloadType,
        srcIp,
        srcPort,
        dstIp,
        dstPort,
        startTime: pktTime,
        endTime: pktTime,
        firstSeq: pkt.sequenceNumber,
        lastSeq: pkt.sequenceNumber,
        minExtendedSeq: pkt.sequenceNumber,
        maxExtendedSeq: pkt.sequenceNumber,
        wrapCycles: 0,
        firstTimestamp: pkt.timestamp,
        lastTimestamp: pkt.timestamp,
        packetCount: 0,
        octetCount: 0,
        lossCount: 0,
        lossPercent: 0,
        jitterUs: 0,
        clockRate,
        packets: [],
        telephoneEvents: [],
      };
      this.streams.set(streamKey, s);
    }

    s.endTime = Math.max(s.endTime, pktTime);
    s.packetCount++;
    s.octetCount += pkt.payload.length;

    // Sequence wrap-around calculation
    const deltaSeq = pkt.sequenceNumber - s.lastSeq;
    if (deltaSeq < -32768) {
      // Forward wrap-around (e.g. 65535 -> 0)
      s.wrapCycles++;
    } else if (deltaSeq > 32768) {
      // Possible backwards packet from prior cycle
    }

    const extendedSeq = (s.wrapCycles << 16) | pkt.sequenceNumber;
    s.maxExtendedSeq = Math.max(s.maxExtendedSeq, extendedSeq);
    s.minExtendedSeq = Math.min(s.minExtendedSeq, extendedSeq);

    // RFC 3550 Interarrival Jitter calculation
    if (s.packetCount > 1) {
      const transitTime = pktTime;
      const prevPacket = s.packets[s.packets.length - 1];
      if (prevPacket) {
        const deltaTransit = transitTime - prevPacket.pktTime;
        // Timestamp delta in seconds
        let deltaTs = (pkt.timestamp - prevPacket.timestamp);
        if (deltaTs < -0x80000000) deltaTs += 0x100000000;
        const deltaTsSec = deltaTs / (s.clockRate || 8000);

        const d = Math.abs(deltaTransit - deltaTsSec);
        // J = J + (|D| - J) / 16
        const jitterSec = (s.jitterUs / 1e6) + (d - (s.jitterUs / 1e6)) / 16;
        s.jitterUs = Math.max(0, jitterSec * 1e6);
      }
    }

    s.lastSeq = pkt.sequenceNumber;
    s.lastTimestamp = pkt.timestamp;

    // Packet Loss calculation
    const expected = s.maxExtendedSeq - s.minExtendedSeq + 1;
    s.lossCount = Math.max(0, expected - s.packetCount);
    s.lossPercent = expected > 0 ? (s.lossCount / expected) * 100 : 0;

    // Detect RFC 4733 Telephone-event (DTMF)
    // RFC 4733 payload is ALWAYS strictly 4 bytes:
    // [0]: Event ID (0-15: 0-9, *, #, A-D)
    // [1]: E (end bit), R (reserved), Volume (6 bits)
    // [2-3]: Duration (16-bit big-endian)
    const isTelephoneEventPt = this.telephoneEventPts.size > 0
      ? this.telephoneEventPts.has(pkt.payloadType)
      : (pkt.payloadType === 101 || pkt.payloadType === 96);

    if (isTelephoneEventPt && pkt.payload.length === 4) {
      const eventId = pkt.payload[0];
      const endBit = Boolean(pkt.payload[1] & 0x80);
      const volume = pkt.payload[1] & 0x3f;
      const duration = (pkt.payload[2] << 8) | pkt.payload[3];
      if (endBit && eventId <= 15 && duration > 0) {
        s.telephoneEvents.push({ event: eventId, time: pktTime, duration });
      }
    }

    s.packets.push({
      seq: pkt.sequenceNumber,
      extendedSeq,
      timestamp: pkt.timestamp,
      pktTime,
      marker: pkt.marker,
      payload: pkt.payload,
    });

    return s;
  }

  public getStreams(): RtpStream[] {
    return Array.from(this.streams.values());
  }

  public findStreamBySsrc(ssrc: number): RtpStream | undefined {
    for (const s of this.streams.values()) {
      if (s.ssrc === ssrc) return s;
    }
    return undefined;
  }
}
