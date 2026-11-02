/**
 * MosUiController.ts
 * Manages the "Estimated MOS (E-model)" UI panel, stream selection, interactive timeline,
 * jitter-buffer simulation toggles, delay assumptions, conference multi-leg table,
 * and Codec G.113 parameter modal editor.
 */

import type { RtpStream } from '../rtp/RtpDemuxer.ts';
import type { SipDialog } from '../sip/DialogManager.ts';
import type { Leg, Conversation } from '../ladder/LadderTypes.ts';
import type { JitterBufferConfig, DelayConfig, StreamMosResult } from './MosTypes.ts';
import { MosEngine } from './MosEngine.ts';
import { CodecConfigTable, DEFAULT_CODEC_PARAMS } from './CodecConfigTable.ts';

export class MosUiController {
  private static streams: RtpStream[] = [];
  private static dialogs: SipDialog[] = [];
  private static legs: Leg[] = [];
  private static conversations: Conversation[] = [];
  private static selectedSsrc: number = 0;

  private static jbConfig: JitterBufferConfig = { type: 'fixed-60' };
  private static delayConfig: DelayConfig = { source: 'assumed', assumedOneWayMs: 0 };
  private static hasPlc: boolean = true;

  private static currentResult: StreamMosResult | null = null;
  private static onUpdateCallback?: () => void;

  public static initialize(onUpdate?: () => void): void {
    this.onUpdateCallback = onUpdate;
    this.bindEvents();
  }

  public static setData(
    streams: RtpStream[],
    dialogs: SipDialog[],
    legs: Leg[],
    conversations: Conversation[]
  ): void {
    // Only audio streams get MOS
    this.streams = streams.filter(s => {
      // Exclude pure video and RFC 4733
      return s.packets.length > 0 && s.payloadType !== 13;
    });
    this.dialogs = dialogs;
    this.legs = legs;
    this.conversations = conversations;

    this.populateStreamSelector();
    this.render();
  }

  public static selectStreamBySsrc(ssrc: number): void {
    if (this.streams.some(s => s.ssrc === ssrc)) {
      this.selectedSsrc = ssrc;
      const sel = document.getElementById('mos-stream-select') as HTMLSelectElement | null;
      if (sel) sel.value = String(ssrc);
      this.render();
    }
  }

  private static bindEvents(): void {
    // Stream selector change
    const streamSelect = document.getElementById('mos-stream-select') as HTMLSelectElement | null;
    if (streamSelect) {
      streamSelect.onchange = () => {
        this.selectedSsrc = Number(streamSelect.value);
        this.render();
      };
    }

    // Jitter buffer buttons
    const jbButtons = document.querySelectorAll('.btn-mos-jb');
    jbButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        jbButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const jbType = btn.getAttribute('data-jb') as any;
        this.jbConfig = { type: jbType };
        this.render();
        if (this.onUpdateCallback) this.onUpdateCallback();
      });
    });

    // One-way delay input
    const delayInput = document.getElementById('mos-delay-input') as HTMLInputElement | null;
    if (delayInput) {
      delayInput.oninput = () => {
        const val = Number(delayInput.value) || 0;
        this.delayConfig.assumedOneWayMs = val;
        const delayDisplay = document.getElementById('mos-delay-val-text');
        if (delayDisplay) delayDisplay.textContent = `${val} ms`;
        this.render();
        if (this.onUpdateCallback) this.onUpdateCallback();
      };
    }

    // PLC toggle checkbox
    const chkPlc = document.getElementById('chk-mos-plc') as HTMLInputElement | null;
    if (chkPlc) {
      chkPlc.onchange = () => {
        this.hasPlc = chkPlc.checked;
        this.render();
        if (this.onUpdateCallback) this.onUpdateCallback();
      };
    }

    // Edit Codec Table Modal Trigger
    const btnEditCodecs = document.getElementById('btn-mos-edit-codecs');
    const modalCodecs = document.getElementById('mos-codecs-modal');
    const btnCloseCodecs = document.getElementById('btn-close-mos-codecs');
    const btnResetCodecs = document.getElementById('btn-reset-mos-codecs');
    const btnSaveCodecs = document.getElementById('btn-save-mos-codecs');

    if (btnEditCodecs && modalCodecs) {
      btnEditCodecs.onclick = () => {
        this.renderCodecModalTable();
        modalCodecs.style.display = 'flex';
      };
    }

    if (btnCloseCodecs && modalCodecs) {
      btnCloseCodecs.onclick = () => {
        modalCodecs.style.display = 'none';
      };
    }

    if (btnResetCodecs) {
      btnResetCodecs.onclick = () => {
        CodecConfigTable.resetToDefaults();
        this.renderCodecModalTable();
        this.render();
        if (this.onUpdateCallback) this.onUpdateCallback();
      };
    }

    if (btnSaveCodecs && modalCodecs) {
      btnSaveCodecs.onclick = () => {
        this.saveCodecModalTable();
        modalCodecs.style.display = 'none';
        this.render();
        if (this.onUpdateCallback) this.onUpdateCallback();
      };
    }

    // Export CSV / JSON
    const btnExportCsv = document.getElementById('btn-mos-export-csv');
    if (btnExportCsv) {
      btnExportCsv.onclick = () => this.exportCsv();
    }

    const btnExportJson = document.getElementById('btn-mos-export-json');
    if (btnExportJson) {
      btnExportJson.onclick = () => this.exportJson();
    }
  }

  private static populateStreamSelector(): void {
    const sel = document.getElementById('mos-stream-select') as HTMLSelectElement | null;
    if (!sel) return;

    sel.innerHTML = '';
    if (this.streams.length === 0) {
      const opt = document.createElement('option');
      opt.textContent = 'No Audio Streams';
      sel.appendChild(opt);
      this.selectedSsrc = 0;
      return;
    }

    this.streams.forEach((s, idx) => {
      const leg = this.legs.find(l => l.inboundStream?.ssrc === s.ssrc || l.outboundStream?.ssrc === s.ssrc);
      const legLabel = leg ? leg.id : `Stream ${idx + 1}`;
      const dirLabel = (s as any).direction ? ((s as any).direction === 'inbound' ? 'IN' : 'OUT') : '';
      const opt = document.createElement('option');
      opt.value = String(s.ssrc);
      opt.textContent = `${legLabel} ${dirLabel ? `[${dirLabel}]` : ''} · SSRC ${s.ssrc} (PT ${s.payloadType})`;
      sel.appendChild(opt);
    });

    if (this.selectedSsrc === 0 && this.streams.length > 0) {
      this.selectedSsrc = this.streams[0].ssrc;
    }
    sel.value = String(this.selectedSsrc);
  }

  public static render(): void {
    const stream = this.streams.find(s => s.ssrc === this.selectedSsrc) || this.streams[0];
    if (!stream) {
      this.renderEmptyState();
      return;
    }

    // Calculate MOS result for selected stream
    const result = MosEngine.analyzeStream(stream, this.dialogs, {
      jbConfig: this.jbConfig,
      delayConfig: this.delayConfig,
      hasPlc: this.hasPlc,
    });
    this.currentResult = result;

    // 1. Primary Big Score Card
    const elScore = document.getElementById('mos-val-score');
    const elRatingBadge = document.getElementById('mos-val-rating-badge');
    const elRVal = document.getElementById('mos-val-r');
    const elMosLq = document.getElementById('mos-val-lq');
    const elMosCq = document.getElementById('mos-val-cq');

    if (elScore) elScore.textContent = result.mos.toFixed(2);
    if (elRVal) elRVal.textContent = result.rFactor.toFixed(1);
    if (elMosLq) elMosLq.textContent = result.mosLq.toFixed(2);
    if (elMosCq) elMosCq.textContent = result.mosCq.toFixed(2);

    if (elRatingBadge) {
      if (result.mos >= 4.0) {
        elRatingBadge.textContent = 'Excellent / Good (≥ 4.0)';
        elRatingBadge.style.background = 'rgba(158, 206, 106, 0.2)';
        elRatingBadge.style.color = '#9ece6a';
        elRatingBadge.style.borderColor = '#9ece6a';
      } else if (result.mos >= 3.6) {
        elRatingBadge.textContent = 'Fair (3.6 – 4.0)';
        elRatingBadge.style.background = 'rgba(42, 195, 222, 0.2)';
        elRatingBadge.style.color = '#2ac3de';
        elRatingBadge.style.borderColor = '#2ac3de';
      } else if (result.mos >= 3.1) {
        elRatingBadge.textContent = 'Poor (3.1 – 3.6)';
        elRatingBadge.style.background = 'rgba(224, 175, 104, 0.2)';
        elRatingBadge.style.color = '#e0af68';
        elRatingBadge.style.borderColor = '#e0af68';
      } else {
        elRatingBadge.textContent = 'Bad (< 3.1)';
        elRatingBadge.style.background = 'rgba(247, 118, 142, 0.2)';
        elRatingBadge.style.color = '#f7768e';
        elRatingBadge.style.borderColor = '#f7768e';
      }
    }

    // 2. Metrics Grid
    this.setText('mos-stat-codec', `${result.codec} (${result.clockRate} Hz)`);
    this.setText('mos-stat-loss', `${result.effectiveLossPct.toFixed(1)}% (Net: ${result.networkLossPct.toFixed(1)}%, Disc: ${result.discardPct.toFixed(1)}%)`);
    this.setText('mos-stat-burst', `${result.burstRatio.toFixed(2)} (${result.burstRatio > 1.2 ? 'Bursty' : 'Random'}, avg ${result.avgBurstLength} pkts)`);
    this.setText('mos-stat-delay', `${result.delayUsedMs} ms (${result.delaySource === 'rtcp' ? 'RTCP' : 'Assumed'})`);
    this.setText('mos-stat-jitter', `${result.avgJitterMs.toFixed(1)} ms (max ${result.maxJitterMs.toFixed(1)} ms)`);
    this.setText('mos-stat-jb', `${result.jitterBufferDepthMs} ms (${result.jitterBufferType})`);

    // 3. Capture Point Banner & RTCP Discrepancy Notice
    const elNotice = document.getElementById('mos-capture-notice');
    if (elNotice) elNotice.textContent = result.capturePointNotice;

    const elDiscrepancy = document.getElementById('mos-discrepancy-banner');
    const elDiscrepancyText = document.getElementById('mos-discrepancy-text');
    if (elDiscrepancy && elDiscrepancyText) {
      if (result.discrepancyFlag) {
        elDiscrepancy.style.display = 'flex';
        elDiscrepancyText.textContent = result.discrepancyFlag;
      } else {
        elDiscrepancy.style.display = 'none';
      }
    }

    // 4. Sliding Timeline Canvas
    this.renderTimelineCanvas(result);

    // 5. Conference / All-Legs MOS Table
    this.renderConferenceTable();
  }

  private static renderTimelineCanvas(result: StreamMosResult): void {
    const canvas = document.getElementById('mos-timeline-canvas') as HTMLCanvasElement | null;
    const statsEl = document.getElementById('mos-timeline-stats');
    if (!canvas) return;

    if (statsEl) {
      statsEl.textContent = `Min MOS: ${result.minMos.toFixed(2)} | Avg MOS: ${result.avgMos.toFixed(2)} | Worst Window: ${result.worstMos.toFixed(2)}`;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.parentElement?.clientWidth || 800;
    const height = 64;

    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;

    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);

    const samples = result.slidingWindows;
    if (samples.length === 0) {
      ctx.fillStyle = '#565f89';
      ctx.font = '12px sans-serif';
      ctx.fillText('No sliding window samples available for short stream', 20, 36);
      return;
    }

    // Threshold lines: 4.0 (Good), 3.6 (Fair), 3.1 (Poor)
    const yFromMos = (m: number) => {
      // Map MOS 1.0 .. 4.5 to height - 8 .. 8
      const clamped = Math.max(1.0, Math.min(4.5, m));
      const norm = (clamped - 1.0) / 3.5;
      return height - 8 - norm * (height - 16);
    };

    // Draw reference threshold dashed lines
    ctx.strokeStyle = 'rgba(158, 206, 106, 0.25)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yFromMos(4.0));
    ctx.lineTo(width, yFromMos(4.0));
    ctx.stroke();

    ctx.strokeStyle = 'rgba(224, 175, 104, 0.25)';
    ctx.beginPath();
    ctx.moveTo(0, yFromMos(3.1));
    ctx.lineTo(width, yFromMos(3.1));
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw MOS curve
    const xStep = width / Math.max(1, samples.length - 1);
    ctx.lineWidth = 2.5;
    ctx.beginPath();

    samples.forEach((s, i) => {
      const x = i * xStep;
      const y = yFromMos(s.mos);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });

    // Stroke gradient by quality
    const grad = ctx.createLinearGradient(0, height, 0, 0);
    grad.addColorStop(0, '#f7768e');
    grad.addColorStop(0.5, '#e0af68');
    grad.addColorStop(0.75, '#2ac3de');
    grad.addColorStop(1, '#9ece6a');
    ctx.strokeStyle = grad;
    ctx.stroke();

    // Fill under curve
    ctx.lineTo(width, height);
    ctx.lineTo(0, height);
    ctx.closePath();
    const fillGrad = ctx.createLinearGradient(0, height, 0, 0);
    fillGrad.addColorStop(0, 'rgba(247, 118, 142, 0.05)');
    fillGrad.addColorStop(1, 'rgba(158, 206, 106, 0.15)');
    ctx.fillStyle = fillGrad;
    ctx.fill();
  }

  private static renderConferenceTable(): void {
    const tbody = document.getElementById('mos-conference-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const confMos = MosEngine.calculateConferenceMos(this.legs, this.streams, this.dialogs, {
      jbConfig: this.jbConfig,
      delayConfig: this.delayConfig,
      hasPlc: this.hasPlc,
    });

    if (confMos.length === 0) {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td colspan="5" style="text-align: center; color: var(--text-dim); padding: 12px;">No correlated call legs detected</td>`;
      tbody.appendChild(tr);
      return;
    }

    confMos.forEach(leg => {
      const tr = document.createElement('tr');
      const inMosText = leg.inboundMos !== undefined ? `${leg.inboundMos.toFixed(2)} (R: ${leg.inboundR?.toFixed(1)})` : '--';
      const outMosText = leg.outboundMos !== undefined ? `${leg.outboundMos.toFixed(2)} (R: ${leg.outboundR?.toFixed(1)})` : '--';
      const worstMosVal = leg.worstMos > 0 ? leg.worstMos.toFixed(2) : '--';

      const worstBadge = leg.isWorstLeg
        ? `<span class="badge-tag" style="background: rgba(247, 118, 142, 0.2); border: 1px solid #f7768e; color: #f7768e;">Worst Call Leg</span>`
        : `<span style="color: var(--text-dim); font-size: 11px;">Nominal</span>`;

      tr.innerHTML = `
        <td style="font-weight: 600;">${leg.participantLabel}</td>
        <td style="font-family: monospace;">${inMosText}</td>
        <td style="font-family: monospace;">${outMosText}</td>
        <td style="font-family: monospace; font-weight: 700; color: ${leg.worstMos >= 3.6 ? '#9ece6a' : leg.worstMos >= 3.1 ? '#e0af68' : '#f7768e'};">${worstMosVal}</td>
        <td>${worstBadge}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  private static renderCodecModalTable(): void {
    const tbody = document.getElementById('mos-codecs-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';
    const params = CodecConfigTable.getAll();

    params.forEach(p => {
      const tr = document.createElement('tr');
      const typeBadge = p.isStandard
        ? `<span class="badge-tag" style="font-size: 10px; background: rgba(158, 206, 106, 0.2); color: #9ece6a;">Standard (G.113)</span>`
        : `<span class="badge-tag" style="font-size: 10px; background: rgba(224, 175, 104, 0.2); color: #e0af68;">Approximate</span>`;

      tr.innerHTML = `
        <td style="font-weight: 600;">${p.name}</td>
        <td>${typeBadge}</td>
        <td>
          <input type="number" class="codec-input-ie" data-id="${p.id}" value="${p.ie}" step="0.5" min="0" max="95" style="width: 55px; background: var(--bg-tertiary); color: #fff; border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px; font-size: 11px;">
        </td>
        <td>
          <input type="number" class="codec-input-bpl-plc" data-id="${p.id}" value="${p.bplWithPlc}" step="0.5" min="1" max="100" style="width: 55px; background: var(--bg-tertiary); color: #fff; border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px; font-size: 11px;">
        </td>
        <td>
          <input type="number" class="codec-input-bpl-noplc" data-id="${p.id}" value="${p.bplWithoutPlc}" step="0.5" min="1" max="100" style="width: 55px; background: var(--bg-tertiary); color: #fff; border: 1px solid var(--border); border-radius: 4px; padding: 2px 5px; font-size: 11px;">
        </td>
        <td style="font-size: 11px; color: var(--text-dim);">${p.notes || ''}</td>
      `;
      tbody.appendChild(tr);
    });
  }

  private static saveCodecModalTable(): void {
    const params = CodecConfigTable.getAll();
    params.forEach(p => {
      const elIe = document.querySelector(`.codec-input-ie[data-id="${p.id}"]`) as HTMLInputElement | null;
      const elBplPlc = document.querySelector(`.codec-input-bpl-plc[data-id="${p.id}"]`) as HTMLInputElement | null;
      const elBplNoPlc = document.querySelector(`.codec-input-bpl-noplc[data-id="${p.id}"]`) as HTMLInputElement | null;

      if (elIe && !isNaN(Number(elIe.value))) p.ie = Number(elIe.value);
      if (elBplPlc && !isNaN(Number(elBplPlc.value))) p.bplWithPlc = Number(elBplPlc.value);
      if (elBplNoPlc && !isNaN(Number(elBplNoPlc.value))) p.bplWithoutPlc = Number(elBplNoPlc.value);
    });
    CodecConfigTable.saveAll(params);
  }

  private static exportCsv(): void {
    if (!this.currentResult) return;
    const r = this.currentResult;
    let csv = 'TimeStart_s,TimeEnd_s,Packets,LossPct,DiscardPct,EffectiveLossPct,Jitter_ms,BurstRatio,RFactor,MOS\n';
    r.slidingWindows.forEach(w => {
      csv += `${w.startSec},${w.endSec},${w.packetCount},${w.lossPct},${w.discardPct},${w.effectiveLossPct},${w.jitterMs},${w.burstRatio},${w.rFactor},${w.mos}\n`;
    });
    this.downloadFile(csv, `mos_timeline_${r.ssrc}.csv`, 'text/csv');
  }

  private static exportJson(): void {
    if (!this.currentResult) return;
    const json = JSON.stringify(this.currentResult, null, 2);
    this.downloadFile(json, `mos_result_${this.currentResult.ssrc}.json`, 'application/json');
  }

  private static downloadFile(content: string, filename: string, mime: string): void {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  private static renderEmptyState(): void {
    this.setText('mos-val-score', '--');
    this.setText('mos-val-r', '--');
    this.setText('mos-val-lq', '--');
    this.setText('mos-val-cq', '--');
  }

  private static setText(id: string, text: string): void {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}
