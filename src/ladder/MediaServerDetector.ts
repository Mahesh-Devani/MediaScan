import type { MediaServer } from './LadderTypes.ts';

export class MediaServerDetector {
  private ipScores: Map<string, { sdpCount: number; rtpCount: number }> = new Map();
  private userPinnedIp?: string;

  public registerEndpoint(ip: string, port: number, isSdpAnswer: boolean = false): void {
    if (!ip) return;
    const current = this.ipScores.get(ip) || { sdpCount: 0, rtpCount: 0 };
    if (isSdpAnswer) {
      current.sdpCount += 2;
    } else {
      current.rtpCount += 1;
    }
    this.ipScores.set(ip, current);
  }

  public setUserPinnedIp(ip: string | undefined): void {
    this.userPinnedIp = ip;
  }

  public detectMediaServer(): MediaServer | null {
    if (this.userPinnedIp) {
      return {
        id: this.userPinnedIp,
        ip: this.userPinnedIp,
        confidence: 1.0,
        detectionReason: 'user_override',
        isUserPinned: true,
      };
    }

    let bestIp = '';
    let bestScore = -1;
    let totalScore = 0;

    for (const [ip, stats] of this.ipScores.entries()) {
      const score = stats.sdpCount * 2 + stats.rtpCount;
      totalScore += score;
      if (score > bestScore) {
        bestScore = score;
        bestIp = ip;
      }
    }

    if (!bestIp) return null;

    const confidence = totalScore > 0 ? Math.min(1.0, bestScore / (totalScore * 0.5)) : 0.5;

    return {
      id: bestIp,
      ip: bestIp,
      confidence,
      detectionReason: (this.ipScores.get(bestIp)?.sdpCount || 0) > 0 ? 'sdp_common_c_line' : 'rtp_endpoint_frequency',
      isUserPinned: false,
    };
  }

  public getAllCandidates(): Array<{ ip: string; score: number }> {
    const list: Array<{ ip: string; score: number }> = [];
    for (const [ip, stats] of this.ipScores.entries()) {
      list.push({ ip, score: stats.sdpCount * 2 + stats.rtpCount });
    }
    return list.sort((a, b) => b.score - a.score);
  }
}
