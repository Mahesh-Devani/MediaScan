import type { Leg, StreamSummary, Anomaly } from './LadderTypes.ts';
import type { SipDialog } from '../sip/DialogManager.ts';
import type { RtpStream } from '../rtp/RtpDemuxer.ts';

export class LegBuilder {
  private msIp: string;

  constructor(msIp: string) {
    this.msIp = msIp;
  }

  public buildLegs(dialogs: SipDialog[], rtpStreams: RtpStream[]): Leg[] {
    const legs: Leg[] = [];
    const matchedStreamIds = new Set<string>();

    // 1. Primary pass: correlate with SIP Dialogs
    for (const d of dialogs) {
      let remoteEp = d.offerMediaEndpoint;
      let msEp = d.answerMediaEndpoint;

      // Check if offer came from MS (e.g. MS initiated or redirected)
      if (remoteEp?.ip === this.msIp && msEp && msEp.ip !== this.msIp) {
        const temp = remoteEp;
        remoteEp = msEp;
        msEp = temp;
      }

      if (!remoteEp || !msEp) {
        continue;
      }

      const legAnomalies: Anomaly[] = [];

      // Find Inbound stream (Remote -> MS)
      // Prioritize exact 4-tuple port match
      let inbound = rtpStreams.find(s => 
        s.srcIp === remoteEp!.ip && s.srcPort === remoteEp!.port &&
        s.dstIp === msEp!.ip && s.dstPort === msEp!.port
      );
      if (!inbound) {
        inbound = rtpStreams.find(s => 
          (s.dstIp === msEp!.ip && s.dstPort === msEp!.port) ||
          (s.srcIp === remoteEp!.ip && s.srcPort === remoteEp!.port && s.dstIp === msEp!.ip)
        );
      }

      // Check for port mismatch against SDP
      if (inbound && inbound.dstPort !== msEp.port) {
        legAnomalies.push({
          severity: 'warning',
          type: 'sdp_port_mismatch',
          description: `Inbound RTP port ${inbound.dstPort} differs from SDP advertised port ${msEp.port}`,
          timestamp: inbound.startTime,
        });
      }

      // Find Outbound stream (MS -> Remote)
      // Prioritize exact 4-tuple port match
      let outbound = rtpStreams.find(s =>
        s.srcIp === msEp!.ip && s.srcPort === msEp!.port &&
        s.dstIp === remoteEp!.ip && s.dstPort === remoteEp!.port
      );
      if (!outbound) {
        outbound = rtpStreams.find(s =>
          (s.dstIp === remoteEp!.ip && s.dstPort === remoteEp!.port && s.srcIp === msEp!.ip) ||
          (s.srcIp === msEp!.ip && s.srcPort === msEp!.port && s.dstIp === remoteEp!.ip)
        );
      }

      if (outbound && outbound.dstPort !== remoteEp.port) {
        legAnomalies.push({
          severity: 'warning',
          type: 'sdp_port_mismatch',
          description: `Outbound RTP port ${outbound.dstPort} differs from SDP advertised port ${remoteEp.port}`,
          timestamp: outbound.startTime,
        });
      }

      if (inbound) matchedStreamIds.add(inbound.id);
      if (outbound) matchedStreamIds.add(outbound.id);

      const leg: Leg = {
        id: `Leg ${String.fromCharCode(65 + legs.length)}`,
        callId: d.callId,
        fromUser: d.from,
        toUser: d.to,
        remoteEndpoint: remoteEp,
        msEndpoint: msEp,
        isCorrelatedWithSip: true,
        sdpDirection: d.direction,
        negotiatedCodecs: d.negotiatedCodecs.map(c => ({ pt: c.pt, name: c.name, clockRate: c.clockRate })),
        ptime: d.ptime,
        inboundStream: inbound ? this.toStreamSummary(inbound, d.negotiatedCodecs) : undefined,
        outboundStream: outbound ? this.toStreamSummary(outbound, d.negotiatedCodecs) : undefined,
        anomalies: legAnomalies,
      };

      legs.push(leg);
    }

    // Collect all negotiated codecs across all dialogs for fallback matching
    const allNegotiatedCodecs: Array<{ pt: number; name: string }> = [];
    for (const d of dialogs) {
      for (const c of d.negotiatedCodecs) {
        if (!allNegotiatedCodecs.some(nc => nc.pt === c.pt)) {
          allNegotiatedCodecs.push({ pt: c.pt, name: c.name });
        }
      }
    }

    // 2. Fallback pass: Uncorrelated RTP streams (e.g. missing SIP, NAT, or unknown dialogs)
    for (const s of rtpStreams) {
      if (matchedStreamIds.has(s.id)) continue;

      // Filter out non-media noise / DNS probes (e.g. port 53, or single packet not touching MS IP)
      if (s.packetCount <= 2 && s.srcIp !== this.msIp && s.dstIp !== this.msIp) {
        continue;
      }
      if (s.srcPort === 53 || s.dstPort === 53) {
        continue;
      }

      const isToMs = s.dstIp === this.msIp;
      const remoteEp = isToMs ? { ip: s.srcIp, port: s.srcPort } : { ip: s.dstIp, port: s.dstPort };
      const msEp = isToMs ? { ip: s.dstIp, port: s.dstPort } : { ip: s.srcIp, port: s.srcPort };

      matchedStreamIds.add(s.id);

      // Check if an existing uncorrelated leg matches this remote/ms endpoint 4-tuple
      // and has an open slot for this direction
      let existingLeg = legs.find(l => 
        l.remoteEndpoint.ip === remoteEp.ip &&
        l.remoteEndpoint.port === remoteEp.port &&
        l.msEndpoint.ip === msEp.ip &&
        l.msEndpoint.port === msEp.port &&
        !l.isCorrelatedWithSip &&
        ((isToMs && !l.inboundStream) || (!isToMs && !l.outboundStream))
      );

      if (!existingLeg) {
        const codecMatch = allNegotiatedCodecs.find(c => c.pt === s.payloadType);
        const codecName = codecMatch
          ? codecMatch.name
          : (s.payloadType === 0 ? 'PCMU' : s.payloadType === 8 ? 'PCMA' : s.payloadType === 9 ? 'G722' : `PT-${s.payloadType}`);

        existingLeg = {
          id: `Leg ${String.fromCharCode(65 + legs.length)}`,
          remoteEndpoint: remoteEp,
          msEndpoint: msEp,
          isCorrelatedWithSip: false,
          sdpDirection: 'sendrecv',
          negotiatedCodecs: [{ pt: s.payloadType, name: codecName, clockRate: s.clockRate }],
          anomalies: [],
        };
        legs.push(existingLeg);
      }

      if (isToMs && !existingLeg.inboundStream) {
        existingLeg.inboundStream = this.toStreamSummary(s, allNegotiatedCodecs);
      } else if (!isToMs && !existingLeg.outboundStream) {
        existingLeg.outboundStream = this.toStreamSummary(s, allNegotiatedCodecs);
      }
    }

    // Sort legs by first packet time
    legs.sort((a, b) => {
      const aStart = Math.min(a.inboundStream?.startTime ?? Infinity, a.outboundStream?.startTime ?? Infinity);
      const bStart = Math.min(b.inboundStream?.startTime ?? Infinity, b.outboundStream?.startTime ?? Infinity);
      return aStart - bStart;
    });

    // Re-index leg IDs as Leg A, Leg B, Leg C...
    legs.forEach((leg, idx) => {
      leg.id = `Leg ${String.fromCharCode(65 + idx)}`;
    });

    return legs;
  }

  private toStreamSummary(s: RtpStream, codecs: Array<{ pt: number; name: string }>): StreamSummary {
    const codecMatch = codecs.find(c => c.pt === s.payloadType);
    const codecName = codecMatch ? codecMatch.name : (s.payloadType === 0 ? 'PCMU' : s.payloadType === 8 ? 'PCMA' : s.payloadType === 9 ? 'G722' : `PT-${s.payloadType}`);

    return {
      ssrc: s.ssrc,
      pt: s.payloadType,
      codec: codecName,
      packetCount: s.packetCount,
      octetCount: s.octetCount,
      lossCount: s.lossCount,
      lossPercent: Number(s.lossPercent.toFixed(2)),
      jitterUs: Math.round(s.jitterUs),
      startTime: s.startTime,
      endTime: s.endTime,
      duration: Math.max(0, s.endTime - s.startTime),
      isEncrypted: false,
      hasSilenceStuffing: false,
      telephoneEvents: s.telephoneEvents,
    };
  }
}
