import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MediaServerDetector } from '../src/ladder/MediaServerDetector.ts';
import { LegBuilder } from '../src/ladder/LegBuilder.ts';
import { ConversationGrouper } from '../src/ladder/ConversationGrouper.ts';
import { AnomalyDetector } from '../src/ladder/AnomalyDetector.ts';
import { LadderSvgRenderer } from '../src/ladder/LadderSvgRenderer.ts';
import type { SipDialog } from '../src/sip/DialogManager.ts';
import type { RtpStream } from '../src/rtp/RtpDemuxer.ts';

describe('Media Flow Ladder Logic & SVG Renderer', () => {
  const msIp = 'fd5d:d50a:8c17:2110::547';
  const remoteIp = 'fd5d:d50a:8c17:2110::87e';

  it('detects media server IP based on endpoint frequency', () => {
    const detector = new MediaServerDetector();
    // Simulate endpoints from 4 dialogs all terminating at msIp
    detector.registerEndpoint(msIp, 8194, true);
    detector.registerEndpoint(msIp, 9218, true);
    detector.registerEndpoint(msIp, 10242, true);
    detector.registerEndpoint(msIp, 11266, true);
    detector.registerEndpoint(remoteIp, 10048, false);
    detector.registerEndpoint(remoteIp, 10054, false);

    const ms = detector.detectMediaServer();
    assert.ok(ms);
    assert.equal(ms.ip, msIp);
    assert.equal(ms.detectionReason, 'sdp_common_c_line');
  });

  it('builds legs correlating SIP dialogs with RTP streams', () => {
    const dialogs: SipDialog[] = [
      {
        callId: 'call-1',
        state: 'Confirmed',
        startTime: 10.0,
        endTime: 25.0,
        from: 'user1',
        to: 'msml',
        offerMediaEndpoint: { ip: remoteIp, port: 10048 },
        answerMediaEndpoint: { ip: msIp, port: 8194 },
        negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
        direction: 'sendrecv',
        messages: [],
      },
    ];

    const streams: RtpStream[] = [
      {
        id: 's1',
        ssrc: 1208512104,
        payloadType: 0,
        srcIp: remoteIp,
        srcPort: 10048,
        dstIp: msIp,
        dstPort: 8194,
        startTime: 10.2,
        endTime: 24.8,
        firstSeq: 1,
        lastSeq: 500,
        minExtendedSeq: 1,
        maxExtendedSeq: 500,
        wrapCycles: 0,
        firstTimestamp: 1000,
        lastTimestamp: 80840,
        packetCount: 500,
        octetCount: 80000,
        lossCount: 0,
        lossPercent: 0,
        jitterUs: 200,
        clockRate: 8000,
        packets: [],
        telephoneEvents: [],
      },
      {
        id: 's2',
        ssrc: 1619045890,
        payloadType: 0,
        srcIp: msIp,
        srcPort: 8194,
        dstIp: remoteIp,
        dstPort: 10048,
        startTime: 10.3,
        endTime: 24.9,
        firstSeq: 1,
        lastSeq: 500,
        minExtendedSeq: 1,
        maxExtendedSeq: 500,
        wrapCycles: 0,
        firstTimestamp: 2000,
        lastTimestamp: 81840,
        packetCount: 500,
        octetCount: 80000,
        lossCount: 0,
        lossPercent: 0,
        jitterUs: 150,
        clockRate: 8000,
        packets: [],
        telephoneEvents: [],
      },
    ];

    const builder = new LegBuilder(msIp);
    const legs = builder.buildLegs(dialogs, streams);

    assert.equal(legs.length, 1);
    const leg = legs[0];
    assert.equal(leg.id, 'Leg A');
    assert.equal(leg.isCorrelatedWithSip, true);
    assert.ok(leg.inboundStream);
    assert.ok(leg.outboundStream);
    assert.equal(leg.inboundStream?.ssrc, 1208512104);
    assert.equal(leg.outboundStream?.ssrc, 1619045890);
  });

  it('detects one-way media anomaly when outbound stream is missing', () => {
    const detector = new AnomalyDetector();
    const leg = {
      id: 'Leg A',
      remoteEndpoint: { ip: remoteIp, port: 10048 },
      msEndpoint: { ip: msIp, port: 8194 },
      isCorrelatedWithSip: true,
      sdpDirection: 'sendrecv' as const,
      negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
      inboundStream: {
        ssrc: 1208512104,
        pt: 0,
        codec: 'PCMU',
        packetCount: 100,
        octetCount: 16000,
        lossCount: 0,
        lossPercent: 0,
        jitterUs: 100,
        startTime: 1.0,
        endTime: 3.0,
        duration: 2.0,
        isEncrypted: false,
        hasSilenceStuffing: false,
        telephoneEvents: [],
      },
      // outboundStream is missing!
      anomalies: [],
    };

    const anomalies = detector.checkLeg(leg);
    assert.ok(anomalies.some(a => a.type === 'one_way_media'));
  });

  it('renders pure SVG ladder diagram with lifelines and stream bars', () => {
    const conversation = {
      id: 'Conversation 1',
      classification: 'Bridged' as const,
      groupingRule: 'TimingHeuristic' as const,
      startTime: 0.0,
      endTime: 10.0,
      legs: [
        {
          id: 'Leg A',
          fromUser: 'Alice',
          toUser: 'MediaServer',
          remoteEndpoint: { ip: remoteIp, port: 10048 },
          msEndpoint: { ip: msIp, port: 8194 },
          isCorrelatedWithSip: true,
          sdpDirection: 'sendrecv' as const,
          negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
          inboundStream: {
            ssrc: 1208512104,
            pt: 0,
            codec: 'PCMU',
            packetCount: 500,
            octetCount: 80000,
            lossCount: 0,
            lossPercent: 0,
            jitterUs: 100,
            startTime: 0.5,
            endTime: 9.5,
            duration: 9.0,
            isEncrypted: false,
            hasSilenceStuffing: false,
            telephoneEvents: [],
          },
          outboundStream: {
            ssrc: 1619045890,
            pt: 0,
            codec: 'PCMU',
            packetCount: 500,
            octetCount: 80000,
            lossCount: 0,
            lossPercent: 0,
            jitterUs: 100,
            startTime: 0.6,
            endTime: 9.6,
            duration: 9.0,
            isEncrypted: false,
            hasSilenceStuffing: false,
            telephoneEvents: [],
          },
          anomalies: [],
        },
      ],
    };

    const svg = LadderSvgRenderer.render(conversation, { mediaServerIp: msIp });
    assert.ok(svg.includes('<svg'));
    assert.ok(svg.includes('</svg>'));
    assert.ok(svg.includes('Media Server'));
    assert.ok(svg.includes('PCMU'));
  });

  it('detects high packet loss and jitter anomalies', () => {
    const detector = new AnomalyDetector();
    const leg = {
      id: 'Leg A',
      remoteEndpoint: { ip: remoteIp, port: 10048 },
      msEndpoint: { ip: msIp, port: 8194 },
      isCorrelatedWithSip: true,
      sdpDirection: 'sendrecv' as const,
      negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
      inboundStream: {
        ssrc: 1208512104,
        pt: 0,
        codec: 'PCMU',
        packetCount: 100,
        octetCount: 16000,
        lossCount: 15,
        lossPercent: 15.0, // > 5%
        jitterUs: 45000,  // > 30ms (30,000 us)
        startTime: 1.0,
        endTime: 3.0,
        duration: 2.0,
        isEncrypted: false,
        hasSilenceStuffing: false,
        telephoneEvents: [],
      },
      outboundStream: {
        ssrc: 1619045890,
        pt: 0,
        codec: 'PCMU',
        packetCount: 100,
        octetCount: 16000,
        lossCount: 0,
        lossPercent: 0,
        jitterUs: 5000,
        startTime: 1.0,
        endTime: 3.0,
        duration: 2.0,
        isEncrypted: false,
        hasSilenceStuffing: false,
        telephoneEvents: [],
      },
      anomalies: [],
    };

    const anomalies = detector.checkLeg(leg);
    assert.ok(anomalies.some(a => a.type === 'sequence_jump_duplicate' && a.severity === 'error'));
    assert.ok(anomalies.some(a => a.type === 'large_packet_gap' && a.severity === 'warning'));
  });

  it('renders anomaly badges and respects showAnomalies toggle', () => {
    const conversation = {
      id: 'Conversation 1',
      classification: 'Bridged' as const,
      groupingRule: 'TimingHeuristic' as const,
      startTime: 0.0,
      endTime: 10.0,
      legs: [
        {
          id: 'Leg A',
          remoteEndpoint: { ip: remoteIp, port: 10048 },
          msEndpoint: { ip: msIp, port: 8194 },
          isCorrelatedWithSip: true,
          sdpDirection: 'sendrecv' as const,
          negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
          anomalies: [
            { severity: 'error' as const, type: 'one_way_media' as const, description: 'One-way media detected', timestamp: 1.0 },
          ],
        },
      ],
    };

    const svgWithAnomalies = LadderSvgRenderer.render(conversation, {
      mediaServerIp: msIp,
      showAnomalies: true,
    });
    assert.ok(svgWithAnomalies.includes('ladder-anomaly-pill'));
    assert.ok(svgWithAnomalies.includes('One-Way Media'));

    const svgWithoutAnomalies = LadderSvgRenderer.render(conversation, {
      mediaServerIp: msIp,
      showAnomalies: false,
    });
    assert.ok(!svgWithoutAnomalies.includes('ladder-anomaly-pill'));
  });

  it('renders DTMF keypad badges on stream arrows and SIP signaling arrows', () => {
    const dialogs: SipDialog[] = [
      {
        callId: 'call-1',
        state: 'Confirmed',
        startTime: 0.0,
        endTime: 10.0,
        from: 'Alice',
        to: 'MS',
        offerMediaEndpoint: { ip: remoteIp, port: 10048 },
        answerMediaEndpoint: { ip: msIp, port: 8194 },
        negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
        direction: 'sendrecv',
        messages: [
          {
            timestamp: 0.1,
            isOutbound: false,
            message: {
              raw: '',
              startLine: 'INVITE sip:ms SIP/2.0',
              isRequest: true,
              method: 'INVITE',
              uri: 'sip:ms',
              callId: 'call-1',
              cseq: 1,
              cseqMethod: 'INVITE',
              from: 'Alice',
              to: 'MS',
              headers: new Map(),
            },
          },
          {
            timestamp: 0.2,
            isOutbound: true,
            message: {
              raw: '',
              startLine: 'SIP/2.0 200 OK',
              isRequest: false,
              statusCode: 200,
              reasonPhrase: 'OK',
              callId: 'call-1',
              cseq: 1,
              cseqMethod: 'INVITE',
              from: 'Alice',
              to: 'MS',
              headers: new Map(),
            },
          },
        ],
      },
    ];

    const conversation = {
      id: 'Conversation 1',
      classification: 'Direct' as const,
      groupingRule: 'TimingHeuristic' as const,
      startTime: 0.0,
      endTime: 10.0,
      legs: [
        {
          id: 'Leg A',
          callId: 'call-1',
          remoteEndpoint: { ip: remoteIp, port: 10048 },
          msEndpoint: { ip: msIp, port: 8194 },
          isCorrelatedWithSip: true,
          sdpDirection: 'sendrecv' as const,
          negotiatedCodecs: [{ pt: 0, name: 'PCMU', clockRate: 8000 }],
          inboundStream: {
            ssrc: 1208512104,
            pt: 0,
            codec: 'PCMU',
            packetCount: 100,
            octetCount: 16000,
            lossCount: 0,
            lossPercent: 0,
            jitterUs: 100,
            startTime: 0.5,
            endTime: 9.5,
            duration: 9.0,
            isEncrypted: false,
            hasSilenceStuffing: false,
            telephoneEvents: [
              { event: 5, time: 2.0, duration: 160 },
              { event: 5, time: 2.02, duration: 320 }, // repeat packet
              { event: 9, time: 4.5, duration: 160 },
            ],
          },
          anomalies: [],
        },
      ],
    };

    const svg = LadderSvgRenderer.render(conversation, {
      mediaServerIp: msIp,
      showSipEvents: true,
      showDtmf: true,
      dialogs,
    });

    // Check SIP transaction arrows
    assert.ok(svg.includes('ladder-sip-arrow'));
    assert.ok(svg.includes('INVITE (Offer)'));
    assert.ok(svg.includes('200 OK'));

    // Check DTMF keypad badges
    assert.ok(svg.includes('ladder-dtmf-badge'));
    assert.ok(svg.includes('⌗5'));
    assert.ok(svg.includes('⌗9'));
  });
});
