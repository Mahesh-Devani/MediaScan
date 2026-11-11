import type { Conversation, Leg, StreamSummary } from './LadderTypes.ts';
import type { SipDialog } from '../sip/DialogManager.ts';

export interface LadderSvgOptions {
  mediaServerIp: string;
  width?: number;
  height?: number;
  showSipEvents?: boolean;
  showAnomalies?: boolean;
  showDtmf?: boolean;
  showMos?: boolean;
  showSsrc?: boolean;
  dialogs?: SipDialog[];
}

export class LadderSvgRenderer {
  public static render(conversation: Conversation, options: LadderSvgOptions): string {
    const width = options.width || 920;
    const padding = 50;
    const topMargin = 85;
    const bottomMargin = 40;
    
    const legs = conversation.legs;
    const numCols = legs.length + 1; // 1 for MS, 1 for each participant leg
    const colWidth = (width - padding * 2) / numCols;

    const convDuration = Math.max(0.1, conversation.endTime - conversation.startTime);
    const rowStep = options.showSipEvents ? 115 : 90;
    const contentHeight = Math.max(300, legs.length * rowStep + 100);
    const height = options.height || (contentHeight + topMargin + bottomMargin);

    // Media Server is column 0 (or center)
    const msX = padding + colWidth * 0.5;

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" style="background-color: #1a1b26; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;">\n`;

    // Title / Header
    svg += `  <text x="${padding}" y="35" fill="#7aa2f7" font-size="18" font-weight="bold">${conversation.id} (${conversation.classification})</text>\n`;
    svg += `  <text x="${padding}" y="55" fill="#a9b1d6" font-size="12">Duration: ${convDuration.toFixed(2)}s | Rule: ${conversation.groupingRule} | ${legs.length} Leg(s)</text>\n`;

    // Lifeline headers & lines
    // 1. Media Server Lifeline
    svg += `  <g id="lifeline-ms">\n`;
    svg += `    <rect x="${msX - 60}" y="${topMargin - 15}" width="120" height="28" rx="4" fill="#24283b" stroke="#7aa2f7" stroke-width="1.5"/>\n`;
    svg += `    <text x="${msX}" y="${topMargin + 4}" fill="#7aa2f7" font-size="11" font-weight="bold" text-anchor="middle">Media Server</text>\n`;
    svg += `    <line x1="${msX}" y1="${topMargin + 15}" x2="${msX}" y2="${height - bottomMargin}" stroke="#414868" stroke-width="2" stroke-dasharray="4 4"/>\n`;
    svg += `  </g>\n`;

    // 2. Participant Lifelines & Stream Arrows
    legs.forEach((leg, idx) => {
      const partX = padding + colWidth * (idx + 1.5);
      const userLabel = leg.fromUser ? `${leg.id}: ${leg.fromUser}` : leg.id;
      const portLabel = `:${leg.remoteEndpoint.port}`;

      // Lifeline Box
      svg += `  <g id="lifeline-${leg.id.replace(/\s+/g, '')}">\n`;
      svg += `    <rect x="${partX - 65}" y="${topMargin - 15}" width="130" height="28" rx="4" fill="#24283b" stroke="#bb9af7" stroke-width="1.5"/>\n`;
      svg += `    <text x="${partX}" y="${topMargin + 4}" fill="#c0caf5" font-size="11" font-weight="bold" text-anchor="middle">${userLabel} ${portLabel}</text>\n`;
      svg += `    <line x1="${partX}" y1="${topMargin + 15}" x2="${partX}" y2="${height - bottomMargin}" stroke="#414868" stroke-width="2" stroke-dasharray="4 4"/>\n`;
      svg += `  </g>\n`;

      // Stream row Y positions
      const baseRowY = topMargin + 40 + idx * rowStep;
      let sipOffset = 0;

      // Render SIP Signaling Transactions if requested
      if (options.showSipEvents && options.dialogs && leg.callId) {
        const dialog = options.dialogs.find(d => d.callId === leg.callId);
        if (dialog && dialog.messages.length > 0) {
          const sipY1 = baseRowY;
          const sipY2 = baseRowY + 16;
          sipOffset = 30;

          // Find key messages
          const hasInvite = dialog.messages.some(m => m.message.isRequest && m.message.method === 'INVITE');
          const has200 = dialog.messages.some(m => !m.message.isRequest && m.message.statusCode === 200);
          const hasAck = dialog.messages.some(m => m.message.isRequest && m.message.method === 'ACK');
          const hasBye = dialog.messages.some(m => m.message.isRequest && m.message.method === 'BYE');

          if (hasInvite) {
            svg += LadderSvgRenderer.renderSipArrow(partX, msX, sipY1, 'INVITE (Offer)', '#7aa2f7');
          }
          if (has200) {
            svg += LadderSvgRenderer.renderSipArrow(msX, partX, sipY2, hasAck ? '200 OK / ACK' : '200 OK (Answer)', '#9ece6a');
          } else if (hasBye) {
            svg += LadderSvgRenderer.renderSipArrow(partX, msX, sipY2, 'BYE', '#f7768e');
          }
        }
      }

      const mediaRowY = baseRowY + sipOffset;

      // Inbound Stream: Participant -> Media Server
      if (leg.inboundStream) {
        svg += LadderSvgRenderer.renderStreamArrow(
          leg.inboundStream,
          partX,
          msX,
          mediaRowY,
          'inbound',
          leg.id,
          options.showSsrc ?? false,
          options.showDtmf ?? false,
          options.showMos ?? true
        );
      }

      // Outbound Stream: Media Server -> Participant
      if (leg.outboundStream) {
        svg += LadderSvgRenderer.renderStreamArrow(
          leg.outboundStream,
          msX,
          partX,
          mediaRowY + 34,
          'outbound',
          leg.id,
          options.showSsrc ?? false,
          options.showDtmf ?? false,
          options.showMos ?? true
        );
      }

      // Render Diagnostic Anomaly Badges if enabled
      if (options.showAnomalies !== false && leg.anomalies.length > 0) {
        const midX = (partX + msX) / 2;
        leg.anomalies.forEach((a, aidx) => {
          const isErr = a.severity === 'error';
          const badgeColor = isErr ? '#f7768e' : '#e0af68';
          const badgeBg = isErr ? 'rgba(247, 118, 142, 0.2)' : 'rgba(224, 175, 104, 0.2)';

          let shortText = '⚠ Anomaly';
          if (a.type === 'one_way_media') shortText = '⚠ One-Way Media';
          else if (a.type === 'no_media_after_200ok') shortText = '! No Media (200 OK)';
          else if (a.type === 'sdp_port_mismatch') shortText = '⚠ Port Mismatch';
          else if (a.type === 'sequence_jump_duplicate') shortText = '! High Loss';
          else if (a.type === 'large_packet_gap') shortText = '⚠ High Jitter';

          const pW = 125;
          const pX = midX - pW / 2;
          const pY = mediaRowY + 17 + aidx * 18;

          svg += `  <g class="ladder-anomaly-pill" style="cursor: help;">\n`;
          svg += `    <rect x="${pX}" y="${pY - 8}" width="${pW}" height="15" rx="3" fill="${badgeBg}" stroke="${badgeColor}" stroke-width="1.2"/>\n`;
          svg += `    <text x="${midX}" y="${pY + 3}" fill="${badgeColor}" font-size="8.5" font-weight="bold" text-anchor="middle">${shortText}</text>\n`;
          svg += `    <title>${a.description}</title>\n`;
          svg += `  </g>\n`;
        });
      }
    });

    svg += `</svg>`;
    return svg;
  }

  private static renderStreamArrow(
    s: StreamSummary,
    startX: number,
    endX: number,
    y: number,
    dir: 'inbound' | 'outbound',
    legId: string,
    showSsrc: boolean,
    showDtmf: boolean = false,
    showMos: boolean = true
  ): string {
    const isLeft = endX < startX;
    const color = LadderSvgRenderer.getCodecColor(s.codec);
    const arrowHeadX = isLeft ? endX + 8 : endX - 8;
    const midX = (startX + endX) / 2;

    const ssrcPart = showSsrc ? ` | SSRC:${s.ssrc}` : '';
    const label = `${s.codec}${ssrcPart} | ${s.packetCount}pkts (${s.lossPercent}%)`;

    let res = `  <g class="stream-arrow" style="cursor: pointer;" data-ssrc="${s.ssrc}" data-leg="${legId}">\n`;
    // Arrow line
    res += `    <line x1="${startX}" y1="${y}" x2="${arrowHeadX}" y2="${y}" stroke="${color}" stroke-width="2.5"/>\n`;
    // Arrow head
    const headPath = isLeft
      ? `M ${endX} ${y} L ${endX + 8} ${y - 4} L ${endX + 8} ${y + 4} Z`
      : `M ${endX} ${y} L ${endX - 8} ${y - 4} L ${endX - 8} ${y + 4} Z`;
    res += `    <path d="${headPath}" fill="${color}"/>\n`;

    // Stream label container
    const badgeWidth = 140;
    const badgeX = midX - badgeWidth / 2;
    res += `    <rect x="${badgeX}" y="${y - 12}" width="${badgeWidth}" height="16" rx="3" fill="#1f2335" stroke="${color}" stroke-width="1" opacity="0.95"/>\n`;

    // Embedded Small Play Button in Ladder
    const playBtnX = badgeX + 10;
    const playBtnY = y - 4;
    res += `    <g class="ladder-play-btn" data-ssrc="${s.ssrc}" title="Play audio stream">\n`;
    res += `      <circle cx="${playBtnX}" cy="${playBtnY}" r="6.5" fill="${color}"/>\n`;
    res += `      <polygon points="${playBtnX - 2.5},${playBtnY - 3.5} ${playBtnX + 3.5},${playBtnY} ${playBtnX - 2.5},${playBtnY + 3.5}" fill="#1a1b26"/>\n`;
    res += `    </g>\n`;

    // Text Label next to Play Button
    res += `    <text x="${badgeX + 22}" y="${y}" fill="#c0caf5" font-size="9.5" text-anchor="start">${label}</text>\n`;

    let extraPillOffset = 8;

    // Render Estimated MOS (E-model) pill badge if available and enabled
    if (showMos && s.mos !== undefined && s.mos > 0) {
      const mosVal = s.mos.toFixed(1);
      const mosColor = s.mos >= 4.0 ? '#9ece6a' : s.mos >= 3.6 ? '#2ac3de' : s.mos >= 3.1 ? '#e0af68' : '#f7768e';
      const mosBg = s.mos >= 4.0 ? 'rgba(158, 206, 106, 0.2)' : s.mos >= 3.6 ? 'rgba(42, 195, 222, 0.2)' : s.mos >= 3.1 ? 'rgba(224, 175, 104, 0.2)' : 'rgba(247, 118, 142, 0.2)';
      const mosPillX = badgeX + badgeWidth + extraPillOffset;
      const mosPillW = 44;
      res += `    <g class="ladder-mos-badge" style="cursor: help;" title="Estimated MOS (E-model): ${s.mos.toFixed(2)} (R: ${s.rFactor?.toFixed(1) || '--'})\n${s.mos >= 4.0 ? 'Good / Excellent' : s.mos >= 3.6 ? 'Fair' : s.mos >= 3.1 ? 'Poor' : 'Bad'}">\n`;
      res += `      <rect x="${mosPillX}" y="${y - 8}" width="${mosPillW}" height="15" rx="3" fill="#1f2335" stroke="${mosColor}" stroke-width="1.2"/>\n`;
      res += `      <rect x="${mosPillX}" y="${y - 8}" width="${mosPillW}" height="15" rx="3" fill="${mosBg}"/>\n`;
      res += `      <text x="${mosPillX + mosPillW / 2}" y="${y + 3}" fill="${mosColor}" font-size="8.5" font-weight="bold" text-anchor="middle">MOS ${mosVal}</text>\n`;
      res += `    </g>\n`;
      extraPillOffset += mosPillW + 6;
    }

    // Render SRTP Encryption Lock Badge if stream is encrypted
    if (s.isEncrypted) {
      const lockPillX = badgeX + badgeWidth + extraPillOffset;
      const lockPillW = s.isDecrypted ? 46 : 56;
      const lockColor = s.isDecrypted ? '#9ece6a' : '#f7768e';
      const lockBg = s.isDecrypted ? 'rgba(158, 206, 106, 0.2)' : 'rgba(247, 118, 142, 0.2)';
      const lockText = s.isDecrypted ? '🔒 SRTP' : '🔒 Locked';
      const authInfo = s.authPassRate !== undefined ? `\nAuth Pass Rate: ${s.authPassRate.toFixed(1)}%` : '';
      const tooltip = s.isDecrypted
        ? `SRTP Decrypted: ${s.cryptoSuite || 'AES_CM_128_HMAC_SHA1_80'}${authInfo}`
        : `SRTP Encrypted (Key Missing or Invalid)`;

      res += `    <g class="ladder-srtp-badge" style="cursor: help;" title="${tooltip}">\n`;
      res += `      <rect x="${lockPillX}" y="${y - 8}" width="${lockPillW}" height="15" rx="3" fill="#1f2335" stroke="${lockColor}" stroke-width="1.2"/>\n`;
      res += `      <rect x="${lockPillX}" y="${y - 8}" width="${lockPillW}" height="15" rx="3" fill="${lockBg}"/>\n`;
      res += `      <text x="${lockPillX + lockPillW / 2}" y="${y + 3}" fill="${lockColor}" font-size="8.5" font-weight="bold" text-anchor="middle">${lockText}</text>\n`;
      res += `    </g>\n`;
      extraPillOffset += lockPillW + 6;
    }

    // Render RFC 4733 DTMF Keypad Pills along the stream arrow if enabled
    if (showDtmf && s.telephoneEvents && s.telephoneEvents.length > 0) {
      const uniqueEvents: Array<{ digit: string; time: number }> = [];
      for (const ev of s.telephoneEvents) {
        const digit = ev.event === 10 ? '*' : ev.event === 11 ? '#' : ev.event >= 12 ? String.fromCharCode(65 + ev.event - 12) : String(ev.event);
        const last = uniqueEvents[uniqueEvents.length - 1];
        if (!last || last.digit !== digit || Math.abs(ev.time - last.time) > 0.4) {
          uniqueEvents.push({ digit, time: ev.time });
        }
      }

      uniqueEvents.forEach((uev, eidx) => {
        const dtmfX = badgeX + badgeWidth + extraPillOffset + eidx * 26;
        res += `    <g class="ladder-dtmf-badge" data-digit="${uev.digit}" style="cursor: pointer;" title="DTMF digit '${uev.digit}' (Click to play tone)">\n`;
        res += `      <rect x="${dtmfX}" y="${y - 8}" width="22" height="15" rx="3" fill="#1f2335" stroke="#e0af68" stroke-width="1.2"/>\n`;
        res += `      <text x="${dtmfX + 11}" y="${y + 3}" fill="#e0af68" font-size="9.5" font-weight="bold" text-anchor="middle">⌗${uev.digit}</text>\n`;
        res += `    </g>\n`;
      });
    }

    res += `  </g>\n`;
    return res;
  }

  private static renderSipArrow(
    startX: number,
    endX: number,
    y: number,
    label: string,
    color: string
  ): string {
    const isLeft = endX < startX;
    const arrowHeadX = isLeft ? endX + 6 : endX - 6;
    const midX = (startX + endX) / 2;

    let res = `  <g class="ladder-sip-arrow" opacity="0.9">\n`;
    res += `    <line x1="${startX}" y1="${y}" x2="${arrowHeadX}" y2="${y}" stroke="${color}" stroke-width="1.2" stroke-dasharray="3 3"/>\n`;
    const headPath = isLeft
      ? `M ${endX} ${y} L ${endX + 6} ${y - 3} L ${endX + 6} ${y + 3} Z`
      : `M ${endX} ${y} L ${endX - 6} ${y - 3} L ${endX - 6} ${y + 3} Z`;
    res += `    <path d="${headPath}" fill="${color}"/>\n`;
    res += `    <text x="${midX}" y="${y - 3}" fill="${color}" font-size="8.5" font-weight="600" text-anchor="middle">${label}</text>\n`;
    res += `  </g>\n`;
    return res;
  }

  private static getCodecColor(codec: string): string {
    const c = codec.toUpperCase();
    if (c.includes('PCMU') || c.includes('PCMA') || c.includes('G711')) return '#9ece6a'; // Green
    if (c.includes('OPUS')) return '#7aa2f7'; // Blue
    if (c.includes('AMR')) return '#bb9af7'; // Purple
    if (c.includes('G722')) return '#e0af68'; // Yellow/Gold
    if (c.includes('264') || c.includes('H264')) return '#ff9e64'; // Orange
    if (c.includes('VP8') || c.includes('VP9')) return '#2ac3de'; // Cyan
    return '#7dcfff';
  }
}
