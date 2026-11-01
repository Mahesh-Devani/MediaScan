/**
 * SnrUiController.ts
 * Coordinates the Signal-to-Noise Ratio (SNR) Analysis UI:
 * - Stream selection & waveform canvas sync
 * - 20ms frame-snapping on drag and typed inputs
 * - Mode toggling (Auto VAD vs Manual 2-Range)
 * - Off-main-thread Web Worker invocation
 * - Sliding-window timeline rendering
 * - Domain caveats & diagnostics
 * - Saved ranges comparison & CSV/JSON export
 */

import { SnrWorkerClient } from './SnrWorkerClient.ts';
import { SnrEngine, type SnrResult, type SnrOptions, type SnrTimelinePoint } from './SnrEngine.ts';
import type { MultiTrack } from '../media/MultiTrackPlayer.ts';
import type { PipelineResult } from '../CapturePipeline.ts';

interface SavedRangeEntry {
  id: string;
  name: string;
  ssrc: number;
  legId: string;
  codec: string;
  mode: 'auto' | 'manual';
  timeWindow: string;
  snrDb: number | null;
  speechLevelDbfs: number | null;
  noiseFloorDbfs: number | null;
  speechPct: number;
  noisePct: number;
  confidence: 'high' | 'low';
  lowConfidenceReasons: string[];
  exactStartSec: number;
  exactEndSec: number;
}

export class SnrUiController {
  private static tracks: MultiTrack[] = [];
  private static activeTrack: MultiTrack | null = null;
  private static currentResult: SnrResult | null = null;
  private static savedRanges: SavedRangeEntry[] = [];
  private static currentMode: 'auto' | 'manual' = 'auto';
  private static pipelineResult: PipelineResult | null = null;

  // Manual ranges
  private static manualSpeech = { startSec: 0, endSec: 0 };
  private static manualNoise = { startSec: 0, endSec: 0 };

  // Callbacks
  public static onRangeSelectedOnWaveform?: (startSec: number, endSec: number) => void;

  /**
   * Initializes DOM event listeners.
   */
  public static init(): void {
    const streamSelect = document.getElementById('snr-stream-select') as HTMLSelectElement | null;
    const btnAuto = document.getElementById('btn-snr-mode-auto');
    const btnManual = document.getElementById('btn-snr-mode-manual');
    const chkHpf = document.getElementById('chk-snr-hpf') as HTMLInputElement | null;
    const chkAweight = document.getElementById('chk-snr-aweight') as HTMLInputElement | null;
    const btnRun = document.getElementById('btn-snr-run');
    const btnRunManual = document.getElementById('btn-snr-run-manual');
    const btnWholeStream = document.getElementById('btn-snr-whole-stream');
    const btnFromCanvasSel = document.getElementById('btn-snr-from-canvas-sel');
    const btnSaveRange = document.getElementById('btn-snr-save-range');
    const btnSetSpeech = document.getElementById('btn-snr-set-speech');
    const btnSetNoise = document.getElementById('btn-snr-set-noise');
    const btnExportCsv = document.getElementById('btn-snr-export-csv');
    const btnExportJson = document.getElementById('btn-snr-export-json');
    const btnClearSaved = document.getElementById('btn-snr-clear-saved');

    streamSelect?.addEventListener('change', () => {
      const ssrc = parseInt(streamSelect.value, 10);
      const t = this.tracks.find(tr => tr.ssrc === ssrc);
      if (t) this.setActiveTrack(t, true);
    });

    btnAuto?.addEventListener('click', () => this.setMode('auto'));
    btnManual?.addEventListener('click', () => this.setMode('manual'));

    chkHpf?.addEventListener('change', () => this.runAnalysis());
    chkAweight?.addEventListener('change', () => this.runAnalysis());

    btnRun?.addEventListener('click', () => this.runAnalysis());
    btnRunManual?.addEventListener('click', () => this.runAnalysis());

    btnWholeStream?.addEventListener('click', () => {
      if (!this.activeTrack) return;
      const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
      if (inputStart && inputEnd) {
        inputStart.value = '0:00.000';
        inputEnd.value = this.formatMmSsMs(this.activeTrack.duration);
      }
      this.runAnalysis();
    });

    btnFromCanvasSel?.addEventListener('click', () => {
      // Current canvas selection sync
      const badge = document.getElementById('mt-selection-range');
      if (badge && badge.textContent && this.activeTrack) {
        // Handled via external syncFromCanvasSelection
      }
    });

    btnSetSpeech?.addEventListener('click', () => {
      const spStart = document.getElementById('snr-manual-sp-start') as HTMLInputElement | null;
      const spEnd = document.getElementById('snr-manual-sp-end') as HTMLInputElement | null;
      const inStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
      if (spStart && spEnd && inStart && inEnd) {
        spStart.value = inStart.value;
        spEnd.value = inEnd.value;
        this.manualSpeech = {
          startSec: this.parseMmSsMs(spStart.value),
          endSec: this.parseMmSsMs(spEnd.value),
        };
      }
    });

    btnSetNoise?.addEventListener('click', () => {
      const nsStart = document.getElementById('snr-manual-ns-start') as HTMLInputElement | null;
      const nsEnd = document.getElementById('snr-manual-ns-end') as HTMLInputElement | null;
      const inStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
      if (nsStart && nsEnd && inStart && inEnd) {
        nsStart.value = inStart.value;
        nsEnd.value = inEnd.value;
        this.manualNoise = {
          startSec: this.parseMmSsMs(nsStart.value),
          endSec: this.parseMmSsMs(nsEnd.value),
        };
      }
    });

    btnSaveRange?.addEventListener('click', () => this.saveCurrentRange());
    btnExportCsv?.addEventListener('click', () => this.exportCsv());
    btnExportJson?.addEventListener('click', () => this.exportJson());
    btnClearSaved?.addEventListener('click', () => {
      this.savedRanges = [];
      this.renderSavedRangesTable();
    });
  }

  /**
   * Binds data from capture analysis pipeline & MultiTrack session.
   */
  public static setTracks(tracks: MultiTrack[], pipeline: PipelineResult): void {
    this.tracks = tracks;
    this.pipelineResult = pipeline;

    const streamSelect = document.getElementById('snr-stream-select') as HTMLSelectElement | null;
    if (!streamSelect) return;

    streamSelect.innerHTML = '';
    tracks.forEach((t) => {
      const opt = document.createElement('option');
      opt.value = String(t.ssrc);
      opt.textContent = `${t.legId} • SSRC ${t.ssrc} (${t.codec})`;
      streamSelect.appendChild(opt);
    });

    if (tracks.length > 0) {
      this.setActiveTrack(tracks[0], true);
    }
  }

  /**
   * Sets the active track being analyzed.
   */
  public static setActiveTrack(track: MultiTrack, resetInputs = false): void {
    this.activeTrack = track;

    const streamSelect = document.getElementById('snr-stream-select') as HTMLSelectElement | null;
    if (streamSelect) streamSelect.value = String(track.ssrc);

    if (resetInputs) {
      const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
      if (inputStart && inputEnd) {
        inputStart.value = '0:00.000';
        inputEnd.value = this.formatMmSsMs(track.duration);
      }
    }

    this.runAnalysis();
  }

  /**
   * Selects stream by SSRC (e.g. from Media Flow Ladder arrow click).
   */
  public static selectStreamBySsrc(ssrc: number, sessionStartSec?: number, sessionEndSec?: number): void {
    const t = this.tracks.find(tr => tr.ssrc === ssrc);
    if (!t) return;

    this.activeTrack = t;
    const streamSelect = document.getElementById('snr-stream-select') as HTMLSelectElement | null;
    if (streamSelect) streamSelect.value = String(ssrc);

    if (sessionStartSec !== undefined && sessionEndSec !== undefined) {
      this.syncFromCanvasSelection(sessionStartSec, sessionEndSec);
    } else {
      const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
      if (inputStart && inputEnd) {
        inputStart.value = '0:00.000';
        inputEnd.value = this.formatMmSsMs(t.duration);
      }
      this.runAnalysis();
    }
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

    // Snap to 20 ms frames
    const snappedStart = SnrEngine.snapToFrame(rawLocalStart);
    const snappedEnd = SnrEngine.snapToFrame(rawLocalEnd);

    const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
    const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
    if (inputStart && inputEnd) {
      inputStart.value = this.formatMmSsMs(snappedStart);
      inputEnd.value = this.formatMmSsMs(snappedEnd);
    }

    this.runAnalysis();
  }

  /**
   * Toggles between Auto and Manual mode.
   */
  public static setMode(mode: 'auto' | 'manual'): void {
    this.currentMode = mode;
    const btnAuto = document.getElementById('btn-snr-mode-auto');
    const btnManual = document.getElementById('btn-snr-mode-manual');
    const autoControls = document.getElementById('snr-auto-controls');
    const manualControls = document.getElementById('snr-manual-controls');

    if (mode === 'auto') {
      btnAuto?.classList.add('active');
      btnManual?.classList.remove('active');
      if (autoControls) autoControls.style.display = 'flex';
      if (manualControls) manualControls.style.display = 'none';
    } else {
      btnManual?.classList.add('active');
      btnAuto?.classList.remove('active');
      if (autoControls) autoControls.style.display = 'none';
      if (manualControls) manualControls.style.display = 'flex';
    }

    this.runAnalysis();
  }

  /**
   * Executes SNR analysis using Web Worker on cached decoded PCM.
   */
  public static async runAnalysis(): Promise<void> {
    if (!this.activeTrack || !this.activeTrack.pcm16 || this.activeTrack.pcm16.length === 0) {
      return;
    }

    const chkHpf = document.getElementById('chk-snr-hpf') as HTMLInputElement | null;
    const chkAweight = document.getElementById('chk-snr-aweight') as HTMLInputElement | null;
    const highPassCutoff = chkHpf && chkHpf.checked ? 80 : 0;
    const useAWeighting = chkAweight ? chkAweight.checked : false;

    let options: SnrOptions = {
      mode: this.currentMode,
      highPassCutoff,
      useAWeighting,
    };

    if (this.currentMode === 'manual') {
      const spStart = document.getElementById('snr-manual-sp-start') as HTMLInputElement | null;
      const spEnd = document.getElementById('snr-manual-sp-end') as HTMLInputElement | null;
      const nsStart = document.getElementById('snr-manual-ns-start') as HTMLInputElement | null;
      const nsEnd = document.getElementById('snr-manual-ns-end') as HTMLInputElement | null;

      options.manualSpeechRange = {
        startSec: this.parseMmSsMs(spStart?.value || '0:00.000'),
        endSec: this.parseMmSsMs(spEnd?.value || '0:00.000'),
      };
      options.manualNoiseRange = {
        startSec: this.parseMmSsMs(nsStart?.value || '0:00.000'),
        endSec: this.parseMmSsMs(nsEnd?.value || '0:00.000'),
      };
    } else {
      const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
      const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;

      const rawStart = this.parseMmSsMs(inputStart?.value || '0:00.000');
      const rawEnd = this.parseMmSsMs(inputEnd?.value || this.formatMmSsMs(this.activeTrack.duration));

      options.range = {
        startSec: rawStart,
        endSec: rawEnd,
      };
    }

    // Call off-main-thread Web Worker
    const result = await SnrWorkerClient.analyze(
      this.activeTrack.pcm16,
      this.activeTrack.sampleRate,
      options
    );

    this.currentResult = result;
    this.renderResult(result);
  }

  /**
   * Renders analysis results, diagnostics, caveats, and sliding timeline.
   */
  private static renderResult(res: SnrResult): void {
    if (!this.activeTrack) return;

    const heroVal = document.getElementById('snr-hero-val');
    const heroUnit = document.getElementById('snr-hero-unit');
    const confBadge = document.getElementById('snr-confidence-badge');
    const speechLevelVal = document.getElementById('snr-speech-level-val');
    const noiseFloorVal = document.getElementById('snr-noise-floor-val');
    const framesSplitVal = document.getElementById('snr-frames-split-val');
    const durationsVal = document.getElementById('snr-durations-val');
    const codecMetaVal = document.getElementById('snr-codec-meta-val');
    const exactBadge = document.getElementById('snr-exact-range-badge');
    const alertBanner = document.getElementById('snr-alert-banner');
    const alertText = document.getElementById('snr-alert-text');

    // Exact range badge
    if (exactBadge) {
      exactBadge.textContent = `Exact: ${this.formatMmSsMs(res.exactRange.startSec)} \u2013 ${this.formatMmSsMs(res.exactRange.endSec)} (${res.exactRange.durationSec.toFixed(3)}s, ${res.exactRange.frameCount} frames)`;
    }

    // Codec & rate
    if (codecMetaVal) {
      codecMetaVal.textContent = `${this.activeTrack.codec} • ${res.sampleRate} Hz`;
    }

    if (res.status === 'cannot_estimate' || res.snrDb === null) {
      // "Cannot estimate" state - NEVER output a number
      if (heroVal) {
        heroVal.textContent = 'Cannot Estimate';
        heroVal.style.fontSize = '24px';
        heroVal.style.color = '#e74c3c';
      }
      if (heroUnit) heroUnit.style.display = 'none';

      if (confBadge) {
        confBadge.textContent = 'Cannot Estimate';
        confBadge.style.background = 'rgba(231, 76, 60, 0.2)';
        confBadge.style.color = '#e74c3c';
      }

      if (speechLevelVal) speechLevelVal.textContent = '--';
      if (noiseFloorVal) noiseFloorVal.textContent = '--';
      if (framesSplitVal) framesSplitVal.textContent = '--% / --%';
      if (durationsVal) durationsVal.textContent = '0.0s / 0.0s';

      if (alertBanner && alertText) {
        alertBanner.style.display = 'flex';
        alertBanner.style.background = 'rgba(231, 76, 60, 0.15)';
        alertBanner.style.borderColor = 'rgba(231, 76, 60, 0.4)';
        alertBanner.style.color = '#e74c3c';
        alertText.textContent = res.cannotEstimateReason || 'Cannot estimate SNR: no speech or noise frames detected.';
      }
    } else {
      // Successful SNR calculation
      if (heroVal) {
        heroVal.textContent = res.snrDb.toFixed(1);
        heroVal.style.fontSize = '38px';
        heroVal.style.color = '#fff';
      }
      if (heroUnit) heroUnit.style.display = 'inline';

      if (confBadge) {
        if (res.confidence === 'high') {
          confBadge.textContent = 'High Confidence';
          confBadge.style.background = 'rgba(46, 204, 113, 0.15)';
          confBadge.style.color = '#2ecc71';
        } else {
          confBadge.textContent = 'Low Confidence';
          confBadge.style.background = 'rgba(243, 156, 18, 0.2)';
          confBadge.style.color = '#f39c12';
        }
      }

      if (speechLevelVal) speechLevelVal.textContent = `${res.speechLevelDbfs?.toFixed(1)} dBFS`;
      if (noiseFloorVal) noiseFloorVal.textContent = `${res.noiseFloorDbfs?.toFixed(1)} dBFS`;
      if (framesSplitVal) framesSplitVal.textContent = `${res.speechPct.toFixed(1)}% / ${res.noisePct.toFixed(1)}%`;
      if (durationsVal) durationsVal.textContent = `${res.speechDurationSec.toFixed(2)}s / ${res.noiseDurationSec.toFixed(2)}s`;

      // Low confidence alert
      if (alertBanner && alertText) {
        if (res.confidence === 'low' && res.lowConfidenceReasons.length > 0) {
          alertBanner.style.display = 'flex';
          alertBanner.style.background = 'rgba(243, 156, 18, 0.15)';
          alertBanner.style.borderColor = 'rgba(243, 156, 18, 0.4)';
          alertBanner.style.color = '#f39c12';
          alertText.textContent = res.lowConfidenceReasons.join(' • ');
        } else {
          alertBanner.style.display = 'none';
        }
      }
    }

    // Surface domain caveats
    this.renderCaveats();

    // Render sliding timeline chart
    this.renderTimeline(res.timeline, res.exactRange.durationSec);
  }

  /**
   * Surfaces contextual telephony domain caveats.
   */
  private static renderCaveats(): void {
    if (!this.activeTrack) return;

    const badgeCodec = document.getElementById('snr-badge-codec');
    const badgeCn = document.getElementById('snr-badge-cn');
    const badgeMs = document.getElementById('snr-badge-ms');
    const badgeConf = document.getElementById('snr-badge-conf');

    const codec = this.activeTrack.codec.toUpperCase();
    if (badgeCodec) {
      if (codec.includes('PCMU') || codec.includes('PCMA') || codec.includes('G711')) {
        badgeCodec.textContent = 'G.711 (Quantization Floor ~38 dBFS)';
        badgeCodec.style.display = 'inline-block';
      } else {
        badgeCodec.textContent = `Codec: ${this.activeTrack.codec}`;
        badgeCodec.style.display = 'inline-block';
      }
    }

    // Comfort noise / DTX detection
    if (badgeCn) {
      badgeCn.style.display = 'inline-block';
      badgeCn.title = 'DTX/Comfort noise creates synthetic background noise floor.';
    }

    // Media Server capture point
    if (badgeMs && this.pipelineResult?.mediaServer?.ip) {
      badgeMs.style.display = 'inline-block';
      badgeMs.title = 'Capture includes Media Server processing; levels may reflect AGC or noise suppression.';
    }

    // Conference mix
    if (badgeConf && this.pipelineResult?.conversations.some((c: any) => c.classification === 'Conference')) {
      badgeConf.style.display = 'inline-block';
      badgeConf.title = 'Conference mix includes multiple speakers; speech level is composite across talkers.';
    }
  }

  /**
   * Renders the 5s window sliding timeline canvas sparkline.
   */
  private static renderTimeline(timeline: SnrTimelinePoint[], totalDurSec: number): void {
    const canvas = document.getElementById('snr-timeline-canvas') as HTMLCanvasElement | null;
    const statsElem = document.getElementById('snr-timeline-stats');
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = rect.width > 0 ? rect.width : (canvas.parentElement?.clientWidth || 600);
    const h = rect.height > 0 ? rect.height : 56;

    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.scale(dpr, dpr);

    ctx.clearRect(0, 0, w, h);

    if (timeline.length === 0 || totalDurSec <= 0) {
      ctx.fillStyle = 'rgba(255, 255, 255, 0.2)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Timeline requires range > 5.0 seconds', w / 2, h / 2 + 4);
      if (statsElem) statsElem.textContent = 'Min: -- dB | Avg: -- dB | Max: -- dB';
      return;
    }

    const validSnrs = timeline.filter(p => p.snrDb !== null).map(p => p.snrDb as number);
    if (validSnrs.length === 0) {
      if (statsElem) statsElem.textContent = 'Min: -- dB | Avg: -- dB | Max: -- dB';
      return;
    }

    const minSnr = Math.min(...validSnrs);
    const maxSnr = Math.max(...validSnrs);
    const avgSnr = validSnrs.reduce((a, b) => a + b, 0) / validSnrs.length;

    if (statsElem) {
      statsElem.textContent = `Min: ${minSnr.toFixed(1)} dB | Avg: ${avgSnr.toFixed(1)} dB | Max: ${maxSnr.toFixed(1)} dB`;
    }

    const plotMin = Math.max(0, Math.floor(minSnr - 5));
    const plotMax = Math.max(plotMin + 10, Math.ceil(maxSnr + 5));

    // Draw grid baseline
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, h - 1);
    ctx.lineTo(w, h - 1);
    ctx.stroke();

    // Plot timeline curve
    ctx.beginPath();
    let isDrawing = false;

    for (let i = 0; i < timeline.length; i++) {
      const pt = timeline[i];
      const x = (pt.timeSec / totalDurSec) * w;

      if (pt.snrDb !== null) {
        const norm = (pt.snrDb - plotMin) / (plotMax - plotMin);
        const y = h - 6 - norm * (h - 14);

        if (!isDrawing) {
          ctx.moveTo(x, y);
          isDrawing = true;
        } else {
          ctx.lineTo(x, y);
        }
      } else {
        isDrawing = false;
      }
    }

    ctx.strokeStyle = '#7aa2f7';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Draw average reference line
    const avgY = h - 6 - ((avgSnr - plotMin) / (plotMax - plotMin)) * (h - 14);
    ctx.strokeStyle = 'rgba(122, 162, 247, 0.4)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, avgY);
    ctx.lineTo(w, avgY);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  /**
   * Saves current range and analysis result into comparison set.
   */
  public static saveCurrentRange(): void {
    if (!this.activeTrack || !this.currentResult) return;

    const id = `range-${Date.now()}`;
    const name = `Range ${this.savedRanges.length + 1} [${this.formatMmSsMs(this.currentResult.exactRange.startSec)}\u2013${this.formatMmSsMs(this.currentResult.exactRange.endSec)}]`;

    const entry: SavedRangeEntry = {
      id,
      name,
      ssrc: this.activeTrack.ssrc,
      legId: this.activeTrack.legId,
      codec: this.activeTrack.codec,
      mode: this.currentResult.mode,
      timeWindow: `${this.formatMmSsMs(this.currentResult.exactRange.startSec)} \u2013 ${this.formatMmSsMs(this.currentResult.exactRange.endSec)} (${this.currentResult.exactRange.durationSec.toFixed(2)}s)`,
      snrDb: this.currentResult.snrDb,
      speechLevelDbfs: this.currentResult.speechLevelDbfs,
      noiseFloorDbfs: this.currentResult.noiseFloorDbfs,
      speechPct: this.currentResult.speechPct,
      noisePct: this.currentResult.noisePct,
      confidence: this.currentResult.confidence,
      lowConfidenceReasons: this.currentResult.lowConfidenceReasons,
      exactStartSec: this.currentResult.exactRange.startSec,
      exactEndSec: this.currentResult.exactRange.endSec,
    };

    this.savedRanges.push(entry);
    this.renderSavedRangesTable();
  }

  /**
   * Renders the comparison table for multiple saved ranges.
   */
  private static renderSavedRangesTable(): void {
    const container = document.getElementById('snr-saved-ranges-container');
    const tbody = document.getElementById('snr-saved-tbody');
    if (!container || !tbody) return;

    if (this.savedRanges.length === 0) {
      container.style.display = 'none';
      tbody.innerHTML = '';
      return;
    }

    container.style.display = 'block';
    tbody.innerHTML = '';

    this.savedRanges.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const snrDisplay = r.snrDb !== null ? `${r.snrDb.toFixed(1)} dB` : 'Cannot Est.';
      const confBadge = r.confidence === 'high'
        ? `<span class="badge-tag" style="background: rgba(46, 204, 113, 0.15); color: #2ecc71;">High</span>`
        : `<span class="badge-tag" style="background: rgba(243, 156, 18, 0.15); color: #f39c12;" title="${r.lowConfidenceReasons.join(' ')}">Low</span>`;

      tr.innerHTML = `
        <td style="font-weight: 600;">${r.name}</td>
        <td style="font-family: monospace;">${r.timeWindow}</td>
        <td><span class="badge-tag">${r.mode.toUpperCase()}</span></td>
        <td style="font-family: monospace;">${r.speechLevelDbfs !== null ? r.speechLevelDbfs.toFixed(1) + ' dBFS' : '--'}</td>
        <td style="font-family: monospace;">${r.noiseFloorDbfs !== null ? r.noiseFloorDbfs.toFixed(1) + ' dBFS' : '--'}</td>
        <td style="font-weight: 700; font-family: monospace; color: ${r.snrDb !== null ? 'var(--accent)' : '#e74c3c'};">${snrDisplay}</td>
        <td>${r.speechPct.toFixed(1)}% / ${r.noisePct.toFixed(1)}%</td>
        <td>${confBadge}</td>
        <td>
          <button class="btn btn-recall-range" data-idx="${idx}" style="padding: 2px 8px; font-size: 11px;">Recall</button>
          <button class="btn btn-delete-range" data-idx="${idx}" style="padding: 2px 6px; font-size: 11px; color: #f7768e;">&times;</button>
        </td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.btn-recall-range').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        const item = this.savedRanges[idx];
        if (item) {
          const inputStart = document.getElementById('snr-input-start') as HTMLInputElement | null;
          const inputEnd = document.getElementById('snr-input-end') as HTMLInputElement | null;
          if (inputStart && inputEnd) {
            inputStart.value = this.formatMmSsMs(item.exactStartSec);
            inputEnd.value = this.formatMmSsMs(item.exactEndSec);
          }
          this.runAnalysis();
        }
      });
    });

    tbody.querySelectorAll('.btn-delete-range').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.getAttribute('data-idx') || '0', 10);
        this.savedRanges.splice(idx, 1);
        this.renderSavedRangesTable();
      });
    });
  }

  /**
   * Exports saved ranges as CSV.
   */
  public static exportCsv(): void {
    if (this.savedRanges.length === 0) return;

    const headers = ['Name', 'SSRC', 'Leg', 'Codec', 'Mode', 'Time Window', 'SNR (dB)', 'Speech Level (dBFS)', 'Noise Floor (dBFS)', 'Speech %', 'Noise %', 'Confidence'];
    const rows = this.savedRanges.map(r => [
      `"${r.name}"`,
      r.ssrc,
      `"${r.legId}"`,
      `"${r.codec}"`,
      r.mode,
      `"${r.timeWindow}"`,
      r.snrDb !== null ? r.snrDb : 'Cannot Estimate',
      r.speechLevelDbfs !== null ? r.speechLevelDbfs : '',
      r.noiseFloorDbfs !== null ? r.noiseFloorDbfs : '',
      r.speechPct,
      r.noisePct,
      r.confidence,
    ]);

    const csvContent = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    this.downloadFile(csvContent, `snr_comparison_${Date.now()}.csv`, 'text/csv');
  }

  /**
   * Exports saved ranges as JSON.
   */
  public static exportJson(): void {
    if (this.savedRanges.length === 0) return;
    const jsonStr = JSON.stringify(this.savedRanges, null, 2);
    this.downloadFile(jsonStr, `snr_comparison_${Date.now()}.json`, 'application/json');
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

  /**
   * Formats seconds into mm:ss.ms (e.g. 0:05.120).
   */
  public static formatMmSsMs(sec: number): string {
    const s = Math.max(0, sec);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    const wholeSec = Math.floor(rem);
    const ms = Math.floor((rem - wholeSec) * 1000);
    return `${m}:${wholeSec < 10 ? '0' : ''}${wholeSec}.${ms < 100 ? (ms < 10 ? '00' : '0') : ''}${ms}`;
  }

  /**
   * Parses mm:ss.ms or ss.ms to seconds.
   */
  public static parseMmSsMs(str: string): number {
    const trimmed = str.trim();
    if (trimmed.includes(':')) {
      const [mStr, sStr] = trimmed.split(':');
      const m = parseFloat(mStr) || 0;
      const s = parseFloat(sStr) || 0;
      return Math.max(0, m * 60 + s);
    }
    return Math.max(0, parseFloat(trimmed) || 0);
  }
}
