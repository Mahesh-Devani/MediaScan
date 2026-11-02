/**
 * DnsmosUiController.ts
 * Coordinates the Microsoft DNSMOS (P.835 & P.808) Speech Quality UI:
 * - Stream selection & waveform canvas synchronization
 * - Metric display cards (SIG, BAK, OVRL, optional P.808 MOS) with rating badges
 * - Interactive multi-trace timeline chart (SIG, BAK, OVRL) with tooltips
 * - Domain caveats (narrowband 8kHz upsampling, short audio, composite mix)
 * - Noise Reduction (NR) Inbound vs Outbound leg comparison with diagnostic verdict
 * - Batch queue scoring for all call streams with progress and abort support
 * - CSV and JSON export
 * - About & Attribution modal dialog
 */

import type { MultiTrack } from '../media/MultiTrackPlayer.ts';
import type { PipelineResult } from '../CapturePipeline.ts';
import type { Leg } from '../ladder/LadderTypes.ts';
import type { DnsmosResult, DnsmosComparisonResult, DnsmosWindowScore } from './DnsmosTypes.ts';
import { DnsmosEngine } from './DnsmosEngine.ts';

interface BatchRowData {
  track: MultiTrack;
  result?: DnsmosResult;
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

export class DnsmosUiController {
  private static tracks: MultiTrack[] = [];
  private static activeTrack: MultiTrack | null = null;
  private static pipelineResult: PipelineResult | null = null;
  private static legs: Leg[] = [];

  private static currentResult: DnsmosResult | null = null;
  private static currentComparison: DnsmosComparisonResult | null = null;
  private static isAnalyzing: boolean = false;

  private static batchRows: BatchRowData[] = [];
  private static selectedRange = { startSec: 0, endSec: 0 };

  /**
   * Initializes DOM event listeners and canvas resize bindings.
   */
  public static init(): void {
    // Stream selection
    const streamSelect = document.getElementById('dnsmos-stream-select') as HTMLSelectElement | null;
    if (streamSelect) {
      streamSelect.onchange = () => {
        const ssrc = Number(streamSelect.value);
        this.selectStreamBySsrc(ssrc);
      };
    }

    // Action buttons
    const btnRun = document.getElementById('btn-dnsmos-run');
    if (btnRun) {
      btnRun.onclick = () => this.runAnalysis();
    }

    const btnWholeStream = document.getElementById('btn-dnsmos-whole-stream');
    if (btnWholeStream) {
      btnWholeStream.onclick = () => {
        if (!this.activeTrack) return;
        this.setRange(0, this.activeTrack.duration);
        this.runAnalysis();
      };
    }

    const btnFromCanvasSel = document.getElementById('btn-dnsmos-from-canvas-sel');
    if (btnFromCanvasSel) {
      btnFromCanvasSel.onclick = () => {
        const inputStart = document.getElementById('dnsmos-input-start') as HTMLInputElement | null;
        const inputEnd = document.getElementById('dnsmos-input-end') as HTMLInputElement | null;
        if (inputStart && inputEnd) {
          const s = this.parseMmSsMs(inputStart.value);
          const e = this.parseMmSsMs(inputEnd.value);
          if (e > s) {
            this.setRange(s, e);
            this.runAnalysis();
          }
        }
      };
    }

    // Options toggles
    const chkPersonalized = document.getElementById('chk-dnsmos-personalized') as HTMLInputElement | null;
    if (chkPersonalized) {
      chkPersonalized.onchange = () => {
        if (this.currentResult) this.runAnalysis();
      };
    }

    const chkP808 = document.getElementById('chk-dnsmos-p808') as HTMLInputElement | null;
    if (chkP808) {
      chkP808.onchange = () => {
        if (this.currentResult) this.runAnalysis();
      };
    }

    // Range input blur handlers
    const inputStart = document.getElementById('dnsmos-input-start') as HTMLInputElement | null;
    const inputEnd = document.getElementById('dnsmos-input-end') as HTMLInputElement | null;
    if (inputStart) {
      inputStart.onblur = () => {
        const s = this.parseMmSsMs(inputStart.value);
        inputStart.value = this.formatMmSsMs(s);
        this.selectedRange.startSec = s;
      };
    }
    if (inputEnd) {
      inputEnd.onblur = () => {
        const e = this.parseMmSsMs(inputEnd.value);
        inputEnd.value = this.formatMmSsMs(e);
        this.selectedRange.endSec = e;
      };
    }

    // Export buttons
    const btnExportCsv = document.getElementById('btn-dnsmos-export-csv');
    if (btnExportCsv) {
      btnExportCsv.onclick = () => this.exportCsv();
    }

    const btnExportJson = document.getElementById('btn-dnsmos-export-json');
    if (btnExportJson) {
      btnExportJson.onclick = () => this.exportJson();
    }

    // About modal
    const btnAbout = document.getElementById('btn-dnsmos-about');
    const modalAbout = document.getElementById('dnsmos-about-modal');
    const btnCloseAbout = document.getElementById('btn-close-dnsmos-about');
    if (btnAbout && modalAbout) {
      btnAbout.onclick = () => { modalAbout.style.display = 'flex'; };
    }
    if (btnCloseAbout && modalAbout) {
      btnCloseAbout.onclick = () => { modalAbout.style.display = 'none'; };
    }

    // Leg comparison events
    const btnCompare = document.getElementById('btn-dnsmos-compare');
    if (btnCompare) {
      btnCompare.onclick = () => this.runLegComparison();
    }

    // Batch scoring events
    const btnBatchRun = document.getElementById('btn-dnsmos-batch-run');
    if (btnBatchRun) {
      btnBatchRun.onclick = () => this.runBatchScoring();
    }

    const btnBatchCancel = document.getElementById('btn-dnsmos-batch-cancel');
    if (btnBatchCancel) {
      btnBatchCancel.onclick = () => {
        DnsmosEngine.cancelBatch();
        const cancelBtn = document.getElementById('btn-dnsmos-batch-cancel');
        if (cancelBtn) cancelBtn.style.display = 'none';
      };
    }

    // Interactive timeline canvas hover/resize
    this.bindTimelineCanvasEvents();
  }

  /**
   * Sets decoded tracks and pipeline context.
   */
  public static setData(tracks: MultiTrack[], pipelineResult: PipelineResult): void {
    this.tracks = tracks.filter(t => t.pcm16 && t.pcm16.length > 0);
    this.pipelineResult = pipelineResult;
    this.legs = pipelineResult.legs || [];

    this.populateStreamSelector();
    this.populateComparisonSelectors();

    // Select first stream by default if none active
    if (!this.activeTrack && this.tracks.length > 0) {
      this.selectStreamBySsrc(this.tracks[0].ssrc);
    } else {
      this.render();
    }
  }

  public static selectStreamBySsrc(ssrc: number): void {
    const t = this.tracks.find(x => x.ssrc === ssrc);
    if (!t) return;

    this.activeTrack = t;
    const streamSelect = document.getElementById('dnsmos-stream-select') as HTMLSelectElement | null;
    if (streamSelect && streamSelect.value !== String(ssrc)) {
      streamSelect.value = String(ssrc);
    }

    // Reset range to full stream
    this.setRange(0, t.duration);
    this.render();
    this.runAnalysis();
  }

  /**
   * Synchronizes range selection from MultiTrack canvas drag to stream-local time.
   */
  public static syncFromCanvasSelection(sessionStartSec: number, sessionEndSec: number): void {
    if (!this.activeTrack) return;

    // Convert session timeline time to stream-relative time
    const relStart = this.activeTrack.relativeStartTime;
    const rawLocalStart = Math.max(0, sessionStartSec - relStart);
    const rawLocalEnd = Math.min(this.activeTrack.duration, sessionEndSec - relStart);

    if (rawLocalEnd <= rawLocalStart) return;

    this.setRange(rawLocalStart, rawLocalEnd);
    this.runAnalysis();
  }

  private static setRange(startSec: number, endSec: number): void {
    this.selectedRange.startSec = Math.max(0, startSec);
    this.selectedRange.endSec = Math.min(this.activeTrack ? this.activeTrack.duration : endSec, endSec);

    const inputStart = document.getElementById('dnsmos-input-start') as HTMLInputElement | null;
    const inputEnd = document.getElementById('dnsmos-input-end') as HTMLInputElement | null;
    if (inputStart) inputStart.value = this.formatMmSsMs(this.selectedRange.startSec);
    if (inputEnd) inputEnd.value = this.formatMmSsMs(this.selectedRange.endSec);

    const exactSpan = document.getElementById('dnsmos-exact-range-text');
    if (exactSpan) {
      const dur = this.selectedRange.endSec - this.selectedRange.startSec;
      exactSpan.textContent = `Exact: ${this.selectedRange.startSec.toFixed(3)}s – ${this.selectedRange.endSec.toFixed(3)}s (${dur.toFixed(2)}s)`;
    }
  }

  /**
   * Populates stream selector dropdown.
   */
  private static populateStreamSelector(): void {
    const select = document.getElementById('dnsmos-stream-select') as HTMLSelectElement | null;
    if (!select) return;

    select.innerHTML = '';
    for (const t of this.tracks) {
      const opt = document.createElement('option');
      opt.value = String(t.ssrc);
      const dir = t.direction ? t.direction.toUpperCase() : 'AUDIO';
      opt.textContent = `${t.legId || 'Stream'} • SSRC ${t.ssrc} (${t.codec}, ${dir})`;
      select.appendChild(opt);
    }

    if (this.activeTrack) {
      select.value = String(this.activeTrack.ssrc);
    }
  }

  /**
   * Populates comparison leg dropdowns and intelligently auto-pairs a Talker Inbound leg
   * with a different Listener Outbound leg (e.g. Leg A IN -> Leg B OUT, or Leg B IN -> Leg C OUT).
   */
  private static populateComparisonSelectors(): void {
    const inSel = document.getElementById('dnsmos-compare-in-select') as HTMLSelectElement | null;
    const outSel = document.getElementById('dnsmos-compare-out-select') as HTMLSelectElement | null;
    if (!inSel || !outSel) return;

    inSel.innerHTML = '';
    outSel.innerHTML = '';

    const inTracks = this.tracks.filter(t => t.direction === 'inbound');
    const outTracks = this.tracks.filter(t => t.direction === 'outbound');

    for (const t of inTracks) {
      const opt = document.createElement('option');
      opt.value = String(t.ssrc);
      opt.textContent = `${t.legId || 'Leg'} • SSRC ${t.ssrc} (${t.codec})`;
      inSel.appendChild(opt);
    }

    for (const t of outTracks) {
      const opt = document.createElement('option');
      opt.value = String(t.ssrc);
      opt.textContent = `${t.legId || 'Leg'} • SSRC ${t.ssrc} (${t.codec})`;
      outSel.appendChild(opt);
    }

    // Intelligent auto-pairing: Pair Talker Inbound with a DIFFERENT Listener Outbound leg
    if (inTracks.length > 0 && outTracks.length > 0) {
      const firstIn = inTracks[0];
      inSel.value = String(firstIn.ssrc);

      // Find an outbound track on a different leg (so it's the receiver of this talker's speech)
      const diffLegOut = outTracks.find(outT => outT.legId && outT.legId !== firstIn.legId);
      if (diffLegOut) {
        outSel.value = String(diffLegOut.ssrc);
      } else {
        outSel.value = String(outTracks[0].ssrc);
      }
    }

    // Dynamic flow explanation on selection change
    inSel.onchange = () => {
      const inSsrc = Number(inSel.value);
      const inTrack = this.tracks.find(t => t.ssrc === inSsrc);
      if (inTrack) {
        const currentOutSsrc = Number(outSel.value);
        const currentOutTrack = this.tracks.find(t => t.ssrc === currentOutSsrc);
        // If current output is on the same leg, prefer switching to a different leg
        if (currentOutTrack && currentOutTrack.legId === inTrack.legId) {
          const alternateOut = outTracks.find(t => t.legId !== inTrack.legId);
          if (alternateOut) {
            outSel.value = String(alternateOut.ssrc);
          }
        }
      }
      this.updateComparisonCallout();
    };

    outSel.onchange = () => {
      this.updateComparisonCallout();
    };

    this.updateComparisonCallout();
  }

  /**
   * Updates comparison flow label and table headers with the selected legs.
   */
  private static updateComparisonCallout(): void {
    const inSel = document.getElementById('dnsmos-compare-in-select') as HTMLSelectElement | null;
    const outSel = document.getElementById('dnsmos-compare-out-select') as HTMLSelectElement | null;
    const flowLabel = document.getElementById('dnsmos-compare-flow-label');
    const thIn = document.getElementById('dnsmos-th-inbound');
    const thOut = document.getElementById('dnsmos-th-outbound');

    if (!inSel || !outSel) return;
    const inTrack = this.tracks.find(t => t.ssrc === Number(inSel.value));
    const outTrack = this.tracks.find(t => t.ssrc === Number(outSel.value));
    if (!inTrack || !outTrack) return;

    if (thIn) thIn.textContent = `Input: ${inTrack.legId || 'Leg'} (Pre-MS)`;
    if (thOut) thOut.textContent = `Output: ${outTrack.legId || 'Leg'} (Post-MS)`;

    if (flowLabel) {
      const isSameLeg = inTrack.legId === outTrack.legId;
      if (isSameLeg) {
        flowLabel.innerHTML = `
          <span>🔄</span>
          <span><strong>Loopback / Echo test:</strong> Comparing ${inTrack.legId} Inbound to ${outTrack.legId} Outbound. Note: In a conference call, outbound on the same leg contains other participants (mix-minus), not this talker.</span>
        `;
      } else {
        flowLabel.innerHTML = `
          <span>🗣️</span>
          <span><strong>Audio Flow:</strong> Talker <strong>${inTrack.legId} (IN)</strong> ➔ Media Server (NR / Transcode) ➔ Listener <strong>${outTrack.legId} (OUT)</strong>. Evaluates how the MS processed ${inTrack.legId}'s voice before delivering it to ${outTrack.legId}.</span>
        `;
      }
    }
  }

  /**
   * Runs DNSMOS speech quality analysis on active stream and range.
   */
  public static async runAnalysis(): Promise<void> {
    if (!this.activeTrack || !this.activeTrack.pcm16 || this.activeTrack.pcm16.length === 0) {
      return;
    }

    const t = this.activeTrack;
    const pcm = t.pcm16;
    const sampleRate = t.sampleRate;
    const duration = t.duration;

    const startSec = Math.max(0, this.selectedRange.startSec);
    const endSec = Math.min(duration, this.selectedRange.endSec > startSec ? this.selectedRange.endSec : duration);
    const isFullStream = startSec <= 0.05 && endSec >= duration - 0.05;

    // Slice PCM if a sub-range is selected
    let pcmToAnalyze: Int16Array = pcm;
    if (!isFullStream) {
      const startSample = Math.floor(startSec * sampleRate);
      const endSample = Math.min(pcm.length, Math.floor(endSec * sampleRate));
      if (endSample > startSample) {
        pcmToAnalyze = pcm.subarray(startSample, endSample);
      }
    }

    const chkPersonalized = document.getElementById('chk-dnsmos-personalized') as HTMLInputElement | null;
    const chkP808 = document.getElementById('chk-dnsmos-p808') as HTMLInputElement | null;
    const isPersonalized = !!chkPersonalized?.checked;
    const includeP808 = !!chkP808?.checked;

    this.setAnalyzingState(true);

    try {
      const result = await DnsmosEngine.evaluatePcm(
        pcmToAnalyze,
        sampleRate,
        {
          streamId: `${t.ssrc}`,
          ssrc: t.ssrc,
          legId: t.legId,
          direction: t.direction,
          codec: t.codec,
          startSec,
          endSec,
          isFullStream,
        },
        {
          isPersonalized,
          includeP808,
        }
      );

      this.currentResult = result;
      this.render();
      const metaInfo = document.getElementById('dnsmos-meta-info');
      if (metaInfo) {
        metaInfo.style.color = 'var(--text-dim)';
      }
    } catch (err: any) {
      console.error('[DnsmosUiController] Analysis error:', err);
      const metaInfo = document.getElementById('dnsmos-meta-info');
      if (metaInfo) {
        metaInfo.textContent = `❌ Evaluation error: ${err?.message || err}`;
        metaInfo.style.color = '#f7768e';
      }
    } finally {
      this.setAnalyzingState(false);
    }
  }

  /**
   * Runs Inbound vs Outbound Leg comparison for Noise Reduction (NR) diagnostics.
   */
  public static async runLegComparison(): Promise<void> {
    const inSel = document.getElementById('dnsmos-compare-in-select') as HTMLSelectElement | null;
    const outSel = document.getElementById('dnsmos-compare-out-select') as HTMLSelectElement | null;
    if (!inSel || !outSel) return;

    const inSsrc = Number(inSel.value);
    const outSsrc = Number(outSel.value);

    const inTrack = this.tracks.find(t => t.ssrc === inSsrc);
    const outTrack = this.tracks.find(t => t.ssrc === outSsrc);
    if (!inTrack || !outTrack) return;

    const btnCompare = document.getElementById('btn-dnsmos-compare');
    if (btnCompare) {
      btnCompare.textContent = 'Comparing Legs...';
      btnCompare.setAttribute('disabled', 'true');
    }

    try {
      const [inRes, outRes] = await Promise.all([
        DnsmosEngine.evaluatePcm(inTrack.pcm16, inTrack.sampleRate, {
          streamId: `${inTrack.ssrc}`,
          ssrc: inTrack.ssrc,
          legId: inTrack.legId,
          direction: 'inbound',
          codec: inTrack.codec,
          isFullStream: true,
        }),
        DnsmosEngine.evaluatePcm(outTrack.pcm16, outTrack.sampleRate, {
          streamId: `${outTrack.ssrc}`,
          ssrc: outTrack.ssrc,
          legId: outTrack.legId,
          direction: 'outbound',
          codec: outTrack.codec,
          isFullStream: true,
        }),
      ]);

      const comp = DnsmosEngine.compareLegs(inRes, outRes);
      this.currentComparison = comp;
      this.renderComparisonView();
    } catch (err) {
      console.error('[DnsmosUiController] Leg comparison error:', err);
    } finally {
      if (btnCompare) {
        btnCompare.textContent = 'Compare Legs';
        btnCompare.removeAttribute('disabled');
      }
    }
  }

  /**
   * Runs batch scoring across all audio streams in the call.
   */
  public static async runBatchScoring(): Promise<void> {
    if (this.tracks.length === 0) return;

    const modal = document.getElementById('dnsmos-batch-modal');
    const progressBar = document.getElementById('dnsmos-batch-progress') as HTMLElement | null;
    const progressText = document.getElementById('dnsmos-batch-progress-text');
    const cancelBtn = document.getElementById('btn-dnsmos-batch-cancel');

    if (modal) modal.style.display = 'flex';
    if (cancelBtn) cancelBtn.style.display = 'inline-block';

    const items = this.tracks.map(t => ({
      pcm: t.pcm16,
      sampleRate: t.sampleRate,
      meta: {
        streamId: `${t.ssrc}`,
        ssrc: t.ssrc,
        legId: t.legId,
        direction: t.direction,
        codec: t.codec,
        isFullStream: true,
      },
    }));

    const chkPersonalized = document.getElementById('chk-dnsmos-personalized') as HTMLInputElement | null;
    const isPersonalized = !!chkPersonalized?.checked;

    await DnsmosEngine.runBatch(
      items,
      { isPersonalized },
      (completed, total, latest) => {
        const pct = Math.round((completed / total) * 100);
        if (progressBar) progressBar.style.width = `${pct}%`;
        if (progressText) progressText.textContent = `${completed} / ${total} streams processed (${pct}%)`;

        if (latest) {
          this.appendBatchTableRow(latest);
        }
      }
    );

    if (cancelBtn) cancelBtn.style.display = 'none';
    if (progressText) progressText.textContent = `Completed batch scoring for ${items.length} streams.`;
  }

  /**
   * Main render method: updates metric cards, caveats, and interactive timeline chart.
   */
  public static render(): void {
    this.renderCaveats();
    this.renderCards();
    this.renderTimelineChart();
  }

  /**
   * Updates metric cards (SIG, BAK, OVRL, P.808).
   */
  private static renderCards(): void {
    const res = this.currentResult;
    const cardSig = document.getElementById('dnsmos-val-sig');
    const cardBak = document.getElementById('dnsmos-val-bak');
    const cardOvrl = document.getElementById('dnsmos-val-ovrl');
    const cardP808 = document.getElementById('dnsmos-val-p808');
    const p808CardCol = document.getElementById('dnsmos-col-p808');

    const badgeSig = document.getElementById('dnsmos-badge-sig');
    const badgeBak = document.getElementById('dnsmos-badge-bak');
    const badgeOvrl = document.getElementById('dnsmos-badge-ovrl');
    const badgeP808 = document.getElementById('dnsmos-badge-p808');

    if (!res) {
      if (cardSig) cardSig.textContent = '--';
      if (cardBak) cardBak.textContent = '--';
      if (cardOvrl) cardOvrl.textContent = '--';
      if (cardP808) cardP808.textContent = '--';
      return;
    }

    if (cardSig) cardSig.textContent = res.sig.toFixed(2);
    if (cardBak) cardBak.textContent = res.bak.toFixed(2);
    if (cardOvrl) cardOvrl.textContent = res.ovrl.toFixed(2);

    this.applyRatingBadge(badgeSig, res.sig);
    this.applyRatingBadge(badgeBak, res.bak);
    this.applyRatingBadge(badgeOvrl, res.ovrl);

    if (res.p808 !== undefined) {
      if (p808CardCol) p808CardCol.style.display = 'flex';
      if (cardP808) cardP808.textContent = res.p808.toFixed(2);
      this.applyRatingBadge(badgeP808, res.p808);
    } else {
      if (p808CardCol) p808CardCol.style.display = 'none';
    }

    // Update metadata info
    const infoText = document.getElementById('dnsmos-meta-info');
    if (infoText) {
      const rtf = res.realtimeFactor ? `${res.realtimeFactor}x real-time` : '';
      infoText.textContent = `${res.windowCount} windows evaluated (${res.computeTimeMs}ms, ${rtf})`;
    }
  }

  private static applyRatingBadge(badgeEl: HTMLElement | null, score: number): void {
    if (!badgeEl) return;
    let label = 'Poor';
    let bg = 'rgba(247, 118, 142, 0.2)';
    let color = '#f7768e';

    if (score >= 4.0) {
      label = 'Excellent';
      bg = 'rgba(158, 206, 106, 0.2)';
      color = '#9ece6a';
    } else if (score >= 3.5) {
      label = 'Good';
      bg = 'rgba(42, 195, 222, 0.2)';
      color = '#2ac3de';
    } else if (score >= 3.0) {
      label = 'Fair';
      bg = 'rgba(224, 175, 104, 0.2)';
      color = '#e0af68';
    }

    badgeEl.textContent = label;
    badgeEl.style.backgroundColor = bg;
    badgeEl.style.color = color;
  }

  /**
   * Renders domain caveat badges.
   */
  private static renderCaveats(): void {
    const badgeNarrowband = document.getElementById('dnsmos-badge-narrowband');
    const badgeConfidence = document.getElementById('dnsmos-badge-confidence');
    const badgeConfMix = document.getElementById('dnsmos-badge-conf-mix');

    if (!this.activeTrack) return;

    // 1. Narrowband check (8 kHz sample rate)
    const isNarrowband = this.activeTrack.sampleRate <= 8000 || /PCMU|PCMA|AMR-NB|G729/i.test(this.activeTrack.codec);
    if (badgeNarrowband) {
      badgeNarrowband.style.display = isNarrowband ? 'inline-flex' : 'none';
    }

    // 2. Confidence check
    if (badgeConfidence && this.currentResult) {
      const conf = this.currentResult.confidence;
      if (conf.level === 'low') {
        badgeConfidence.style.display = 'inline-flex';
        badgeConfidence.textContent = `⚠️ Low Confidence: ${conf.reasons[0] || 'Short audio / low energy'}`;
      } else {
        badgeConfidence.style.display = 'none';
      }
    }

    // 3. Conference mix check
    const isConference = this.pipelineResult?.conversations.some(c => c.classification === 'Conference');
    if (badgeConfMix) {
      badgeConfMix.style.display = isConference ? 'inline-flex' : 'none';
    }
  }

  /**
   * Renders interactive multi-trace timeline chart (SIG, BAK, OVRL).
   */
  private static renderTimelineChart(): void {
    const canvas = document.getElementById('dnsmos-timeline-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.clientWidth || 800;
    const height = canvas.clientHeight || 160;
    canvas.width = width * window.devicePixelRatio;
    canvas.height = height * window.devicePixelRatio;
    ctx.scale(window.devicePixelRatio, window.devicePixelRatio);

    // Clear
    ctx.clearRect(0, 0, width, height);

    const res = this.currentResult;
    if (!res || !res.windows || res.windows.length === 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.font = '12px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No speech quality timeline available (run analysis to evaluate)', width / 2, height / 2);
      return;
    }

    const padding = { top: 16, bottom: 24, left: 34, right: 16 };
    const chartW = width - padding.left - padding.right;
    const chartH = height - padding.top - padding.bottom;

    // Y axis: 1.0 to 5.0
    const minY = 1.0;
    const maxY = 5.0;
    const yToPx = (val: number) => padding.top + chartH - ((val - minY) / (maxY - minY)) * chartH;

    // Grid lines for 2.0, 3.0, 4.0, 5.0
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'right';

    for (let yVal = 1.0; yVal <= 5.0; yVal += 1.0) {
      const yPx = yToPx(yVal);
      ctx.beginPath();
      ctx.moveTo(padding.left, yPx);
      ctx.lineTo(width - padding.right, yPx);
      ctx.stroke();
      ctx.fillText(yVal.toFixed(1), padding.left - 6, yPx + 3);
    }

    const windows = res.windows;
    const N = windows.length;
    const xToPx = (idx: number) => padding.left + (idx / Math.max(1, N - 1)) * chartW;

    // Helper to draw smooth series
    const drawSeries = (vals: number[], strokeColor: string, fillColor?: string) => {
      if (vals.length === 0) return;

      ctx.beginPath();
      ctx.moveTo(xToPx(0), yToPx(vals[0]));
      for (let i = 1; i < vals.length; i++) {
        ctx.lineTo(xToPx(i), yToPx(vals[i]));
      }

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = 2;
      ctx.stroke();

      if (fillColor) {
        ctx.lineTo(xToPx(vals.length - 1), yToPx(1.0));
        ctx.lineTo(xToPx(0), yToPx(1.0));
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();
      }

      // Draw points
      for (let i = 0; i < vals.length; i++) {
        ctx.beginPath();
        ctx.arc(xToPx(i), yToPx(vals[i]), 3, 0, Math.PI * 2);
        ctx.fillStyle = strokeColor;
        ctx.fill();
      }
    };

    // Draw OVRL (Green), BAK (Purple), SIG (Cyan)
    const ovrlVals = windows.map(w => w.ovrl);
    const bakVals = windows.map(w => w.bak);
    const sigVals = windows.map(w => w.sig);

    drawSeries(ovrlVals, '#9ece6a', 'rgba(158, 206, 106, 0.08)');
    drawSeries(bakVals, '#bb9af7');
    drawSeries(sigVals, '#2ac3de');

    // X-axis time labels
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.textAlign = 'center';
    const numTicks = Math.min(6, N);
    for (let i = 0; i < numTicks; i++) {
      const wIdx = Math.floor((i / (numTicks - 1)) * (N - 1));
      const w = windows[wIdx];
      const xPx = xToPx(wIdx);
      ctx.fillText(`${w.startSec.toFixed(1)}s`, xPx, height - 6);
    }
  }

  /**
   * Binds tooltip and hover interactions to timeline canvas.
   */
  private static bindTimelineCanvasEvents(): void {
    const canvas = document.getElementById('dnsmos-timeline-canvas') as HTMLCanvasElement | null;
    const tooltip = document.getElementById('dnsmos-canvas-tooltip');
    if (!canvas || !tooltip) return;

    canvas.onmousemove = (e: MouseEvent) => {
      const res = this.currentResult;
      if (!res || !res.windows || res.windows.length === 0) {
        tooltip.style.display = 'none';
        return;
      }

      const rect = canvas.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const paddingLeft = 34;
      const paddingRight = 16;
      const chartW = rect.width - paddingLeft - paddingRight;

      if (mouseX < paddingLeft || mouseX > rect.width - paddingRight) {
        tooltip.style.display = 'none';
        return;
      }

      const normX = (mouseX - paddingLeft) / chartW;
      const wIdx = Math.min(res.windows.length - 1, Math.max(0, Math.round(normX * (res.windows.length - 1))));
      const w = res.windows[wIdx];

      tooltip.style.display = 'block';
      tooltip.style.left = `${e.clientX + 12}px`;
      tooltip.style.top = `${e.clientY - 30}px`;
      tooltip.innerHTML = `
        <div style="font-weight: 700; margin-bottom: 2px;">Time: ${w.startSec.toFixed(1)}s – ${w.endSec.toFixed(1)}s</div>
        <div style="color: #2ac3de;">SIG: ${w.sig.toFixed(2)}</div>
        <div style="color: #bb9af7;">BAK: ${w.bak.toFixed(2)}</div>
        <div style="color: #9ece6a; font-weight: 700;">OVRL: ${w.ovrl.toFixed(2)}</div>
        ${w.p808 !== undefined ? `<div style="color: #ff9e64;">P.808: ${w.p808.toFixed(2)}</div>` : ''}
      `;
    };

    canvas.onmouseleave = () => {
      tooltip.style.display = 'none';
    };
  }

  /**
   * Renders Noise Reduction comparison view table and verdict alert.
   */
  private static renderComparisonView(): void {
    const comp = this.currentComparison;
    const container = document.getElementById('dnsmos-comparison-result-box');
    const tbody = document.getElementById('dnsmos-compare-tbody');
    const verdictBox = document.getElementById('dnsmos-verdict-alert');

    if (!comp || !container || !tbody || !verdictBox) return;

    container.style.display = 'block';
    tbody.innerHTML = '';

    const createRow = (name: string, inVal: number, outVal: number, delta: number) => {
      const tr = document.createElement('tr');
      const isPositive = delta > 0.05;
      const isNegative = delta < -0.05;
      const deltaColor = isPositive ? '#9ece6a' : (isNegative ? '#f7768e' : 'var(--text-dim)');
      const deltaSign = delta > 0 ? '+' : '';

      tr.innerHTML = `
        <td style="font-weight: 600;">${name}</td>
        <td>${inVal.toFixed(2)}</td>
        <td>${outVal.toFixed(2)}</td>
        <td style="color: ${deltaColor}; font-weight: 700;">${deltaSign}${delta.toFixed(2)}</td>
      `;
      return tr;
    };

    tbody.appendChild(createRow('Speech Signal (SIG)', comp.inputResult.sig, comp.outputResult.sig, comp.deltaSig));
    tbody.appendChild(createRow('Background Noise (BAK)', comp.inputResult.bak, comp.outputResult.bak, comp.deltaBak));
    tbody.appendChild(createRow('Overall Quality (OVRL)', comp.inputResult.ovrl, comp.outputResult.ovrl, comp.deltaOvrl));

    // Verdict alert
    let badgeColor = '#7aa2f7';
    let title = 'Leg Quality Comparison';
    if (comp.verdict === 'effective_nr') {
      badgeColor = '#9ece6a';
      title = '🟢 Effective Noise Reduction';
    } else if (comp.verdict === 'bak_up_sig_down') {
      badgeColor = '#e0af68';
      title = '⚠️ Over-Suppression Artifact (Speech Distorted)';
    } else if (comp.verdict === 'all_down') {
      badgeColor = '#f7768e';
      title = '🔴 Quality Degradation Across Leg';
    } else if (comp.verdict === 'bak_flat') {
      badgeColor = 'var(--text-dim)';
      title = '⚪ Ineffective Noise Reduction';
    }

    verdictBox.style.borderLeft = `4px solid ${badgeColor}`;
    verdictBox.innerHTML = `
      <div style="font-weight: 700; color: ${badgeColor}; font-size: 13px; margin-bottom: 4px;">${title}</div>
      <div style="font-size: 12px; color: var(--text-normal);">${comp.diagnosticExplanation}</div>
    `;
  }

  private static appendBatchTableRow(res: DnsmosResult): void {
    const tbody = document.getElementById('dnsmos-batch-tbody');
    if (!tbody) return;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${res.legId || 'Leg'}</td>
      <td>${res.ssrc}</td>
      <td>${res.codec}</td>
      <td style="color: #2ac3de; font-weight: 700;">${res.sig.toFixed(2)}</td>
      <td style="color: #bb9af7; font-weight: 700;">${res.bak.toFixed(2)}</td>
      <td style="color: #9ece6a; font-weight: 700;">${res.ovrl.toFixed(2)}</td>
      <td>${res.p808 !== undefined ? res.p808.toFixed(2) : '--'}</td>
      <td><span class="badge-tag" style="font-size: 10px;">${res.confidence.level.toUpperCase()}</span></td>
    `;
    tbody.appendChild(tr);
  }

  /**
   * Sets UI loading/analyzing state.
   */
  private static setAnalyzingState(busy: boolean): void {
    this.isAnalyzing = busy;
    const btn = document.getElementById('btn-dnsmos-run');
    const metaInfo = document.getElementById('dnsmos-meta-info');
    if (btn) {
      if (busy) {
        btn.textContent = '⏳ Evaluating...';
        btn.setAttribute('disabled', 'true');
        if (metaInfo) {
          metaInfo.textContent = 'Running DNSMOS neural evaluation in Web Worker...';
          metaInfo.style.color = '#2ac3de';
        }
      } else {
        btn.textContent = '🧠 Analyze Speech Quality';
        btn.removeAttribute('disabled');
      }
    }
  }

  /**
   * Exports DNSMOS results as CSV.
   */
  public static exportCsv(): void {
    if (!this.currentResult) return;

    const res = this.currentResult;
    const lines = [
      'Window Index,Start Sec,End Sec,SIG,BAK,OVRL,P808',
      ...res.windows.map(w =>
        `${w.windowIdx},${w.startSec.toFixed(3)},${w.endSec.toFixed(3)},${w.sig.toFixed(4)},${w.bak.toFixed(4)},${w.ovrl.toFixed(4)},${w.p808 !== undefined ? w.p808.toFixed(4) : ''}`
      ),
      '',
      `Aggregated SIG,${res.sig}`,
      `Aggregated BAK,${res.bak}`,
      `Aggregated OVRL,${res.ovrl}`,
      res.p808 !== undefined ? `Aggregated P808,${res.p808}` : '',
      `SSRC,${res.ssrc}`,
      `Codec,${res.codec}`,
      `Confidence,${res.confidence.level}`,
    ].filter(Boolean);

    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dnsmos_ssrc_${res.ssrc}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  /**
   * Exports DNSMOS results as JSON.
   */
  public static exportJson(): void {
    if (!this.currentResult) return;

    const blob = new Blob([JSON.stringify(this.currentResult, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dnsmos_ssrc_${this.currentResult.ssrc}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private static formatMmSsMs(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const ms = Math.floor((sec % 1) * 1000);
    return `${m}:${s.toString().padStart(2, '0')}.${ms.toString().padStart(3, '0')}`;
  }

  private static parseMmSsMs(str: string): number {
    if (!str) return 0;
    const parts = str.split(':');
    if (parts.length === 2) {
      const m = parseFloat(parts[0]) || 0;
      const s = parseFloat(parts[1]) || 0;
      return m * 60 + s;
    }
    return parseFloat(str) || 0;
  }
}
