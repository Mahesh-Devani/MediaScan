import { PcapParser } from './pcap/PcapParser.ts';
import { Deduplicator } from './pcap/Deduplicator.ts';
import { SipParser } from './sip/SipParser.ts';
import { DialogManager } from './sip/DialogManager.ts';
import { RtpDemuxer } from './rtp/RtpDemuxer.ts';
import { MediaServerDetector } from './ladder/MediaServerDetector.ts';
import { LegBuilder } from './ladder/LegBuilder.ts';
import { ConversationGrouper } from './ladder/ConversationGrouper.ts';
import { AnomalyDetector } from './ladder/AnomalyDetector.ts';
import type { Conversation, Leg, MediaServer } from './ladder/LadderTypes.ts';
import type { RtpStream } from './rtp/RtpDemuxer.ts';
import type { SipDialog } from './sip/DialogManager.ts';

export interface PipelineResult {
  dialogs: SipDialog[];
  streams: RtpStream[];
  mediaServer: MediaServer | null;
  legs: Leg[];
  conversations: Conversation[];
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
                }

                // Register dynamic payload types with clock rates and detect telephone-event
                for (const [pt, codec] of m.rtpmap.entries()) {
                  rtpDemuxer.setClockRate(pt, codec.clockRate);
                  if (codec.name.toLowerCase().includes('telephone-event')) {
                    rtpDemuxer.registerTelephoneEventPt(pt);
                  }
                }
              }
            }
          }
        }

        // 2. RTP Check (RFC 3550)
        const rtp = RtpDemuxer.parseRtp(payload);
        if (rtp) {
          rtpPackets++;
          msDetector.registerEndpoint(dstIp, dstPort, false);
          rtpDemuxer.addPacket(rtp, pkt.timestampSec, srcIp, srcPort, dstIp, dstPort);
        } else {
          // Check RTCP
          const rtcp = RtpDemuxer.parseRtcp(payload);
          if (rtcp) {
            rtcpPackets++;
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
