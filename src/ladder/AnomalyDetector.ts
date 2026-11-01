import type { Leg, Anomaly } from './LadderTypes.ts';

export class AnomalyDetector {
  /**
   * Run automated diagnostic anomaly detection rules over a call leg.
   */
  public checkLeg(leg: Leg): Anomaly[] {
    const anomalies: Anomaly[] = [...leg.anomalies];

    const inPkts = leg.inboundStream?.packetCount || 0;
    const outPkts = leg.outboundStream?.packetCount || 0;

    // 1. No Media After 200 OK (Call answered, but zero media packets arrived)
    if (leg.isCorrelatedWithSip && inPkts === 0 && outPkts === 0) {
      anomalies.push({
        severity: 'error',
        type: 'no_media_after_200ok',
        description: `No media packets received or transmitted after SIP 200 OK answer on ${leg.id}.`,
        timestamp: 0,
      });
    }

    // 2. One-way Media
    if (leg.sdpDirection === 'sendrecv') {
      if (inPkts > 0 && outPkts === 0) {
        anomalies.push({
          severity: 'warning',
          type: 'one_way_media',
          description: `One-way media: Inbound audio active (${inPkts} pkts), but no Outbound media from Media Server.`,
          timestamp: leg.inboundStream?.startTime || 0,
        });
      } else if (inPkts === 0 && outPkts > 0) {
        anomalies.push({
          severity: 'warning',
          type: 'one_way_media',
          description: `One-way media: Outbound audio active (${outPkts} pkts), but no Inbound media received by Media Server.`,
          timestamp: leg.outboundStream?.startTime || 0,
        });
      }
    }

    // 3. High Packet Loss (> 5%)
    if (leg.inboundStream && leg.inboundStream.lossPercent > 5) {
      anomalies.push({
        severity: 'error',
        type: 'sequence_jump_duplicate',
        description: `High packet loss on Inbound stream: ${leg.inboundStream.lossPercent}% (${leg.inboundStream.lossCount} missing packets).`,
        timestamp: leg.inboundStream.startTime,
      });
    }

    if (leg.outboundStream && leg.outboundStream.lossPercent > 5) {
      anomalies.push({
        severity: 'error',
        type: 'sequence_jump_duplicate',
        description: `High packet loss on Outbound stream: ${leg.outboundStream.lossPercent}% (${leg.outboundStream.lossCount} missing packets).`,
        timestamp: leg.outboundStream.startTime,
      });
    }

    // 4. High Jitter (> 30 ms)
    if (leg.inboundStream && leg.inboundStream.jitterUs > 30000) {
      anomalies.push({
        severity: 'warning',
        type: 'large_packet_gap',
        description: `High inter-arrival jitter on Inbound stream: ${(leg.inboundStream.jitterUs / 1000).toFixed(1)} ms.`,
        timestamp: leg.inboundStream.startTime,
      });
    }

    if (leg.outboundStream && leg.outboundStream.jitterUs > 30000) {
      anomalies.push({
        severity: 'warning',
        type: 'large_packet_gap',
        description: `High inter-arrival jitter on Outbound stream: ${(leg.outboundStream.jitterUs / 1000).toFixed(1)} ms.`,
        timestamp: leg.outboundStream.startTime,
      });
    }

    // De-duplicate anomalies of the same type
    const seen = new Set<string>();
    return anomalies.filter(a => {
      const key = `${a.type}:${a.severity}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
}
