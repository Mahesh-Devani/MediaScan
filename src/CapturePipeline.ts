import { PcapParser } from './pcap/PcapParser.ts';
import { Deduplicator } from './pcap/Deduplicator.ts';
import { SipParser } from './sip/SipParser.ts';
import { DialogManager } from './sip/DialogManager.ts';
import { RtpDemuxer } from './rtp/RtpDemuxer.ts';
import { MediaServerDetector } from './ladder/MediaServerDetector.ts';
import { LegBuilder } from './ladder/LegBuilder.ts';
import { ConversationGrouper } from './ladder/ConversationGrouper.ts';
import { AnomalyDetector } from './ladder/AnomalyDetector.ts';
import { MosEngine } from './mos/MosEngine.ts';
import { StreamAudioDecoder } from './decoders/StreamAudioDecoder.ts';
import { SrtpKeyRegistry } from './srtp/SrtpKeyRegistry.ts';
import { DtlsParser, type DtlsHandshakeInfo } from './dtls/DtlsParser.ts';
import type { Conversation, Leg, MediaServer } from './ladder/LadderTypes.ts';
import type { RtpStream } from './rtp/RtpDemuxer.ts';
import type { SipDialog } from './sip/DialogManager.ts';

export interface PipelineResult {
  dialogs: SipDialog[];
  streams: RtpStream[];
  mediaServer: MediaServer | null;
  legs: Leg[];
  conversations: Conversation[];
  keyRegistry?: SrtpKeyRegistry;
  stats: {
    totalFrames: number;
    sipPackets: number;
    rtpPackets: number;
    rtcpPackets: number;
    duplicatesDropped: number;
  };
}

export class CapturePipeline {
  public static process(data: Uint8Array, userPinnedMsIp?: string): PipelineResult {
    const parser = new PcapParser(data);
    const linkType = parser.getHeader().linkType;
    const dedup = new Deduplicator(1500);

    const dialogManager = new DialogManager();
    const rtpDemuxer = new RtpDemuxer();
    const msDetector = new MediaServerDetector();
    const keyRegistry = new SrtpKeyRegistry();
    const secureEndpoints = new Set<string>();
    const dtlsSessions = new Map<string, DtlsHandshakeInfo>();

    if (userPinnedMsIp) {
      msDetector.setUserPinnedIp(userPinnedMsIp);
    }

    let totalFrames = 0;
    let sipPackets = 0;
    let rtpPackets = 0;
    let rtcpPackets = 0;
    let duplicatesDropped = 0;

    let pkt = parser.nextPacket();
    while (pkt) {
      totalFrames++;

      if (dedup.isDuplicate(pkt.data)) {
        duplicatesDropped++;
        pkt = parser.nextPacket();
        continue;
      }

      const dissected = PcapParser.dissectPacket(pkt, parser.getHeader().linkType);

      if (dissected.network && dissected.transport) {
        const payload = dissected.payload;
        const srcIp = dissected.network.srcIp;
        const dstIp = dissected.network.dstIp;
        const srcPort = dissected.transport.srcPort;
        const dstPort = dissected.transport.dstPort;

        // 1. SIP Check
        if (
          srcPort === 5060 || dstPort === 5060 ||
          srcPort === 5065 || dstPort === 5065 ||
          SipParser.isSip(payload)
        ) {
          const sipMsg = SipParser.parse(payload);
          if (sipMsg) {
            sipPackets++;
            dialogManager.addMessage(sipMsg, pkt.timestampSec);

            if (sipMsg.sdp) {
              for (const m of sipMsg.sdp.media) {
                const epIp = m.connection?.address || sipMsg.sdp.connection?.address;
                if (epIp && m.port > 0) {
                  const isAnswer = !sipMsg.isRequest && (sipMsg.statusCode || 0) >= 200 && (sipMsg.statusCode || 0) < 300;
                  msDetector.registerEndpoint(epIp, m.port, isAnswer);
                  if (m.isSecure || (m.crypto && m.crypto.length > 0)) {
                    secureEndpoints.add(`${epIp}:${m.port}`);
                  }
                }

                // Register dynamic payload types with clock rates and detect telephone-event
                for (const [pt, codec] of m.rtpmap.entries()) {
                  rtpDemuxer.setClockRate(pt, codec.clockRate);
                  if (codec.name.toLowerCase().includes('telephone-event')) {
                    rtpDemuxer.registerTelephoneEventPt(pt);
                  }
                }
              }

              // Update key registry with dialog offer/answers
              const activeDialogs = dialogManager.getMediaDialogs();
              for (const d of activeDialogs) {
                keyRegistry.registerSipDialog(d);
              }
            }
          }
        }

        // 2. DTLS Check (RFC 7983: ContentType 20..63)
        if (DtlsParser.isDtls(payload)) {
          const tuple = `${srcIp}:${srcPort}-${dstIp}:${dstPort}`;
          const revTuple = `${dstIp}:${dstPort}-${srcIp}:${srcPort}`;
          let dtlsState = dtlsSessions.get(tuple) || dtlsSessions.get(revTuple);
          if (!dtlsState) {
            dtlsState = {};
            dtlsSessions.set(tuple, dtlsState);
          }
          DtlsParser.parseHandshake(payload, `${srcIp}:${srcPort}`, `${dstIp}:${dstPort}`, dtlsState);
          keyRegistry.registerDtlsHandshake(dtlsState);
          secureEndpoints.add(`${srcIp}:${srcPort}`);
          secureEndpoints.add(`${dstIp}:${dstPort}`);
        }

        // 3. RTP Check (RFC 3550)
        const rtp = RtpDemuxer.parseRtp(payload);
        if (rtp) {
          rtpPackets++;
          msDetector.registerEndpoint(dstIp, dstPort, false);

          const isSecure = secureEndpoints.has(`${dstIp}:${dstPort}`) || secureEndpoints.has(`${srcIp}:${srcPort}`);
          const srtpCtx = keyRegistry.getContextForPacket(rtp.ssrc, srcIp, srcPort, dstIp, dstPort, pkt.timestampSec);

          if (srtpCtx) {
            try {
              const unprotectRes = srtpCtx.unprotectRtp(payload);
              const parsedDecrypted = RtpDemuxer.parseRtp(unprotectRes.decryptedPacket);
              if (parsedDecrypted) {
                rtp.payload = parsedDecrypted.payload;
              }
              const stream = rtpDemuxer.addPacket(rtp, pkt.timestampSec, srcIp, srcPort, dstIp, dstPort);
              stream.isEncrypted = true;
              stream.isDecrypted = true;
              stream.cryptoSuite = (srtpCtx as any).crypto?.cryptoSuite;
              stream.authPassRate = srtpCtx.getAuthPassRate(rtp.ssrc);
              if (!stream.encryptedPacketIndex) stream.encryptedPacketIndex = [];
              stream.encryptedPacketIndex.push({
                offset: pkt.fileOffset || 0,
                length: pkt.data.length,
                timestampSec: pkt.timestampSec,
              });
            } catch (err) {
              const stream = rtpDemuxer.addPacket(rtp, pkt.timestampSec, srcIp, srcPort, dstIp, dstPort);
              stream.isEncrypted = true;
              stream.isDecrypted = false;
              if (!stream.encryptedPacketIndex) stream.encryptedPacketIndex = [];
              stream.encryptedPacketIndex.push({
                offset: pkt.fileOffset || 0,
                length: pkt.data.length,
                timestampSec: pkt.timestampSec,
              });
            }
          } else if (isSecure) {
            const stream = rtpDemuxer.addPacket(rtp, pkt.timestampSec, srcIp, srcPort, dstIp, dstPort);
            stream.isEncrypted = true;
            stream.isDecrypted = false;
            if (!stream.encryptedPacketIndex) stream.encryptedPacketIndex = [];
            stream.encryptedPacketIndex.push({
              offset: pkt.fileOffset || 0,
              length: pkt.data.length,
              timestampSec: pkt.timestampSec,
            });
          } else {
            // Unencrypted plain stream - zero overhead, identical to baseline
            rtpDemuxer.addPacket(rtp, pkt.timestampSec, srcIp, srcPort, dstIp, dstPort);
          }
        } else {
          // Check RTCP
          const srtpCtx = keyRegistry.getContextForPacket(0, srcIp, srcPort, dstIp, dstPort, pkt.timestampSec);
          if (srtpCtx) {
            try {
              const unprotectRtcpRes = srtpCtx.unprotectRtcp(payload);
              const decryptedRtcp = RtpDemuxer.parseRtcp(unprotectRtcpRes.decryptedPacket);
              if (decryptedRtcp) {
                rtcpPackets++;
                rtpDemuxer.addRtcpPacket(decryptedRtcp, pkt.timestampSec);
              }
            } catch {
              // Gracefully handle unparseable/encrypted RTCP
            }
          } else {
            const rtcp = RtpDemuxer.parseRtcp(payload);
            if (rtcp) {
              rtcpPackets++;
              rtpDemuxer.addRtcpPacket(rtcp, pkt.timestampSec);
            }
          }
        }
      }

      pkt = parser.nextPacket();
    }

    const mediaServer = msDetector.detectMediaServer();
    const msIp = mediaServer?.ip || '';

    const dialogs = dialogManager.getMediaDialogs();
    const streams = rtpDemuxer.getStreams();

    const legBuilder = new LegBuilder(msIp);
    const legs = legBuilder.buildLegs(dialogs, streams);

    // Attach Estimated MOS (E-model) metrics to legs and streams
    for (const leg of legs) {
      if (leg.inboundStream) {
        const stream = streams.find(s => s.ssrc === leg.inboundStream?.ssrc);
        if (stream && stream.packets.length > 0) {
          (stream as any).direction = 'inbound';
          const mosRes = MosEngine.analyzeStream(stream, dialogs);
          leg.inboundStream.mos = mosRes.mos;
          leg.inboundStream.mosLq = mosRes.mosLq;
          leg.inboundStream.mosCq = mosRes.mosCq;
          leg.inboundStream.rFactor = mosRes.rFactor;
          (stream as any).mos = mosRes.mos;
          (stream as any).rFactor = mosRes.rFactor;
        }
      }
      if (leg.outboundStream) {
        const stream = streams.find(s => s.ssrc === leg.outboundStream?.ssrc);
        if (stream && stream.packets.length > 0) {
          (stream as any).direction = 'outbound';
          const mosRes = MosEngine.analyzeStream(stream, dialogs);
          leg.outboundStream.mos = mosRes.mos;
          leg.outboundStream.mosLq = mosRes.mosLq;
          leg.outboundStream.mosCq = mosRes.mosCq;
          leg.outboundStream.rFactor = mosRes.rFactor;
          (stream as any).mos = mosRes.mos;
          (stream as any).rFactor = mosRes.rFactor;
        }
      }
    }

    // Ensure all audio streams have MOS analyzed even if not matched to a SIP leg
    for (const stream of streams) {
      if ((stream as any).mos === undefined && stream.packets.length > 0 && stream.payloadType !== 13) {
        const info = StreamAudioDecoder.resolveCodec(stream, dialogs);
        const isVideo = info.normalizedCodec === 'H264' || info.normalizedCodec === 'VP8' || stream.payloadType === 99 || stream.payloadType === 96;
        if (!isVideo) {
          const mosRes = MosEngine.analyzeStream(stream, dialogs);
          (stream as any).mos = mosRes.mos;
          (stream as any).rFactor = mosRes.rFactor;
        }
      }
    }

    const anomalyDetector = new AnomalyDetector();
    for (const leg of legs) {
      leg.anomalies = anomalyDetector.checkLeg(leg);
    }

    const conversations = ConversationGrouper.groupLegs(legs);

    return {
      dialogs,
      streams,
      mediaServer,
      legs,
      conversations,
      keyRegistry,
      stats: {
        totalFrames,
        sipPackets,
        rtpPackets,
        rtcpPackets,
        duplicatesDropped,
      },
    };
  }
}
