import type { Conversation, Leg } from './LadderTypes.ts';

export class ConversationGrouper {
  /**
   * Group legs into conversations applying the 4-tier rules in order.
   */
  public static groupLegs(legs: Leg[]): Conversation[] {
    if (legs.length === 0) return [];

    const conversations: Conversation[] = [];
    const assignedLegIds = new Set<string>();

    // Rule 1: Conference Identifiers (shared Request-URI / Conference-ID)
    const confGroups = new Map<string, Leg[]>();
    for (const leg of legs) {
      if (leg.callId) {
        // Check if there is an explicit conference identifier in the call
        // For example: sip:msml@[...], conference room URI, etc.
        const key = leg.toUser || leg.fromUser || '';
        if (key && (key.includes('msml') || key.includes('conf') || key.includes('room'))) {
          const list = confGroups.get(key) || [];
          list.push(leg);
          confGroups.set(key, list);
        }
      }
    }

    for (const [key, groupLegs] of confGroups.entries()) {
      if (groupLegs.length >= 2) {
        for (const l of groupLegs) assignedLegIds.add(l.id);
        const { start, end } = ConversationGrouper.getTimeRange(groupLegs);
        conversations.push({
          id: '',
          classification: groupLegs.length >= 3 ? 'Conference' : 'Bridged',
          legs: groupLegs,
          groupingRule: 'ConferenceIdentifier',
          startTime: start,
          endTime: end,
          conferenceUri: key,
        });
      }
    }

    // Rule 2 & 3: Remaining legs by timing heuristic on the same Media Server
    const unassigned = legs.filter(l => !assignedLegIds.has(l.id));
    if (unassigned.length > 0) {
      // Group together legs that overlap or start within 3.0s
      let currentCluster: Leg[] = [];
      let clusterStart = Infinity;
      let clusterEnd = -Infinity;

      for (const leg of unassigned) {
        const legStart = Math.min(leg.inboundStream?.startTime ?? Infinity, leg.outboundStream?.startTime ?? Infinity);
        const legEnd = Math.max(leg.inboundStream?.endTime ?? -Infinity, leg.outboundStream?.endTime ?? -Infinity);

        if (currentCluster.length === 0) {
          currentCluster.push(leg);
          clusterStart = legStart;
          clusterEnd = legEnd;
        } else if (legStart - clusterStart <= 3.0 || legStart <= clusterEnd + 1.0) {
          currentCluster.push(leg);
          clusterStart = Math.min(clusterStart, legStart);
          clusterEnd = Math.max(clusterEnd, legEnd);
        } else {
          // Finish previous cluster
          conversations.push({
            id: '',
            classification: currentCluster.length >= 3 ? 'Conference' : 'Bridged',
            legs: currentCluster,
            groupingRule: 'TimingHeuristic',
            startTime: clusterStart,
            endTime: clusterEnd,
          });
          currentCluster = [leg];
          clusterStart = legStart;
          clusterEnd = legEnd;
        }
      }

      if (currentCluster.length > 0) {
        conversations.push({
          id: '',
          classification: currentCluster.length >= 3 ? 'Conference' : 'Bridged',
          legs: currentCluster,
          groupingRule: 'TimingHeuristic',
          startTime: clusterStart,
          endTime: clusterEnd,
        });
      }
    }

    // Sort conversations chronologically by start time
    conversations.sort((a, b) => a.startTime - b.startTime);

    // Assign IDs: "Conversation 1", "Conversation 2", ...
    conversations.forEach((c, idx) => {
      c.id = `Conversation ${idx + 1}`;
    });

    return conversations;
  }

  private static getTimeRange(legs: Leg[]): { start: number; end: number } {
    let start = Infinity;
    let end = -Infinity;
    for (const l of legs) {
      const s = Math.min(l.inboundStream?.startTime ?? Infinity, l.outboundStream?.startTime ?? Infinity);
      const e = Math.max(l.inboundStream?.endTime ?? -Infinity, l.outboundStream?.endTime ?? -Infinity);
      if (s < start) start = s;
      if (e > end) end = e;
    }
    return {
      start: isFinite(start) ? start : 0,
      end: isFinite(end) ? end : 0,
    };
  }
}
