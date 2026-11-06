/**
 * DnsmosToolController.ts
 * UI controller for the standalone "DNSMOS Tool" tab.
 * Handles drag-and-drop intake, table rendering, batch execution,
 * waveform inspection, A/B playback, multi-item comparison, and CSV/JSON export.
 */

import { DnsmosToolEngine, type FileItemToScore, type ChannelScoreTask, type MultiItemComparison } from './DnsmosToolEngine.ts';
import type { DnsmosResult, DnsmosOptions } from './DnsmosTypes.ts';
import type { SupportedRawCodec, RawPcmOptions } from '../audio/RawAudioLoader.ts';
import type { ChannelAudio } from '../audio/ChannelSplitter.ts';
import { WavExporter } from '../media/WavExporter.ts';

export class DnsmosToolController {
  private fileItems: FileItemToScore[] = [];
  private resultsMap: Map<string, DnsmosResult> = new Map();
  private selectedRowKey: string | null = null;
  private checkedRowKeys: Set<string> = new Set();

  // Playback state
  private audioCtx: AudioContext | null = null;
  private currentSourceNode: AudioBufferSourceNode | null = null;
  private isPlaying = false;
  private playbackMode: 'native' | 'model16k' = 'native';

  constructor() {
    this.initEventListeners();
  }

  public initEventListeners(): void {
    // Dropzone drag/drop
    const dropzone = document.getElementById('dnsmos-tool-dropzone');
    const fileInput = document.getElementById('dnsmos-tool-file-input') as HTMLInputElement | null;
    const folderInput = document.getElementById('dnsmos-tool-folder-input') as HTMLInputElement | null;
    const btnSelectFiles = document.getElementById('btn-tool-select-files');
    const btnSelectFolder = document.getElementById('btn-tool-select-folder');
    const btnRawConfig = document.getElementById('btn-tool-raw-config');

    if (dropzone) {
      dropzone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropzone.classList.add('dragover');
      });
      dropzone.addEventListener('dragleave', () => {
        dropzone.classList.remove('dragover');
      });
      dropzone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropzone.classList.remove('dragover');
        if (e.dataTransfer && e.dataTransfer.files) {
          this.handleIncomingFiles(Array.from(e.dataTransfer.files));
        }
      });
    }

    if (btnSelectFiles && fileInput) {
      btnSelectFiles.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', () => {
        if (fileInput.files) {
          this.handleIncomingFiles(Array.from(fileInput.files));
          fileInput.value = '';
        }
      });
    }

    if (btnSelectFolder && folderInput) {
      btnSelectFolder.addEventListener('click', () => folderInput.click());
      folderInput.addEventListener('change', () => {
        if (folderInput.files) {
          this.handleIncomingFiles(Array.from(folderInput.files));
          folderInput.value = '';
        }
      });
    }

    if (btnRawConfig) {
      btnRawConfig.addEventListener('click', () => {
        const modal = document.getElementById('modal-raw-stream-config');
        if (modal) modal.style.display = 'flex';
      });
    }

    // Modal Raw Stream Config Close & Submit
    const btnCloseModal = document.getElementById('btn-close-raw-modal');
    const btnApplyRaw = document.getElementById('btn-apply-raw-config');
    if (btnCloseModal) {
      btnCloseModal.addEventListener('click', () => {
        const modal = document.getElementById('modal-raw-stream-config');
        if (modal) modal.style.display = 'none';
      });
    }
    if (btnApplyRaw && fileInput) {
      btnApplyRaw.addEventListener('click', () => {
        const modal = document.getElementById('modal-raw-stream-config');
        if (modal) modal.style.display = 'none';
        fileInput.click();
      });
    }

    // Batch Actions
    const btnScoreAll = document.getElementById('btn-tool-score-all');
    const btnCancel = document.getElementById('btn-tool-cancel-queue');
    const btnClearAll = document.getElementById('btn-tool-clear-all');
    const btnExportCsv = document.getElementById('btn-tool-export-csv');
    const btnExportJson = document.getElementById('btn-tool-export-json');

    if (btnScoreAll) {
      btnScoreAll.addEventListener('click', () => this.runBatchScoring());
    }
    if (btnCancel) {
      btnCancel.addEventListener('click', () => {
        DnsmosToolEngine.cancelBatch();
        this.updateBatchStatus('Batch scoring cancelled by user.');
      });
    }
    if (btnClearAll) {
      btnClearAll.addEventListener('click', () => {
        this.fileItems = [];
        this.resultsMap.clear();
        this.selectedRowKey = null;
        this.checkedRowKeys.clear();
        this.renderTable();
        this.hideInspectionDrawer();
        this.hideCompareDrawer();
      });
    }
    if (btnExportCsv) {
      btnExportCsv.addEventListener('click', () => this.exportCsv());
    }
    if (btnExportJson) {
      btnExportJson.addEventListener('click', () => this.exportJson());
    }

    // Playback buttons in drawer
    const btnPlay = document.getElementById('btn-tool-play');
    if (btnPlay) {
      btnPlay.addEventListener('click', () => this.togglePlayback());
    }

    const btnSourceNative = document.getElementById('btn-tool-source-native');
    const btnSource16k = document.getElementById('btn-tool-source-16k');
    if (btnSourceNative && btnSource16k) {
      btnSourceNative.addEventListener('click', () => {
        this.playbackMode = 'native';
        btnSourceNative.classList.add('active');
        btnSource16k.classList.remove('active');
        if (this.isPlaying) {
          this.stopPlayback();
          this.startPlayback();
        }
      });
      btnSource16k.addEventListener('click', () => {
        this.playbackMode = 'model16k';
        btnSource16k.classList.add('active');
        btnSourceNative.classList.remove('active');
        if (this.isPlaying) {
          this.stopPlayback();
          this.startPlayback();
        }
      });
    }
  }

  public async handleIncomingFiles(files: File[]): Promise<void> {
    const chkDownmix = document.getElementById('chk-tool-downmix') as HTMLInputElement | null;
    const includeMonoDownmix = !!chkDownmix?.checked;

    for (const file of files) {
      const id = `file_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
      const statusText = document.getElementById('dnsmos-tool-status-text');
      if (statusText) statusText.innerText = `Parsing ${file.name}...`;

      try {
        const parsed = await DnsmosToolEngine.parseAudioFile(file, 'auto', undefined, includeMonoDownmix);
        this.fileItems.push({
          id,
          file,
          fileName: file.name,
          codec: 'auto',
          status: 'pending',
          channels: parsed.channels,
          sampleRate: parsed.sampleRate,
          durationSec: parsed.durationSec,
          formatName: parsed.formatName,
          bandwidth: parsed.bandwidth,
        });
      } catch (err: any) {
        console.error(`Failed to parse ${file.name}:`, err);
        this.fileItems.push({
          id,
          file,
          fileName: file.name,
          codec: 'auto',
          status: 'error',
          errorMessage: err?.message || 'Unsupported or corrupted audio file',
          channels: [],
          sampleRate: 0,
          durationSec: 0,
          formatName: 'Error',
        });
      }
    }

    this.renderTable();
    const statusText = document.getElementById('dnsmos-tool-status-text');
    if (statusText) statusText.innerText = `Loaded ${this.fileItems.length} files. Ready to score.`;
  }

  public async runBatchScoring(): Promise<void> {
    const chkPersonalized = document.getElementById('chk-tool-personalized') as HTMLInputElement | null;
    const chkP808 = document.getElementById('chk-tool-p808') as HTMLInputElement | null;

    const options: DnsmosOptions = {
      isPersonalized: !!chkPersonalized?.checked,
      includeP808: !!chkP808?.checked,
    };

    const tasks: ChannelScoreTask[] = [];
    for (const item of this.fileItems) {
      if (item.status === 'error') continue;
      for (const ch of item.channels) {
        const key = `${item.fileName}_ch${ch.channelIndex}`;
        if (!this.resultsMap.has(key)) {
          tasks.push({
            fileId: item.id,
            fileName: item.fileName,
            channel: ch,
            sampleRate: item.sampleRate,
            formatName: item.formatName,
            bandwidth: item.bandwidth,
          });
        }
      }
    }

    if (tasks.length === 0) {
      this.updateBatchStatus('All channels already scored.');
      return;
    }

    const progressBar = document.getElementById('dnsmos-tool-progress-inner');
    const progressText = document.getElementById('dnsmos-tool-progress-text');
    const progressContainer = document.getElementById('dnsmos-tool-progress-container');
    if (progressContainer) progressContainer.style.display = 'block';

    await DnsmosToolEngine.runBatch(tasks, options, (p) => {
      if (progressBar) progressBar.style.width = `${p.percent}%`;
      if (progressText) {
        progressText.innerText = `Scoring ${p.completed}/${p.total}: ${p.currentFileName} (${p.currentChannelName}) [${p.percent}%]`;
      }
      if (p.result) {
        const key = `${p.currentFileName}_ch${p.result.fileInfo?.channelIndex ?? 0}`;
        this.resultsMap.set(key, p.result);
        this.renderTable();
      }
    });

    if (progressText) progressText.innerText = 'Batch scoring completed.';
    this.renderTable();
  }

  public renderTable(): void {
    const tbody = document.getElementById('dnsmos-tool-tbody');
    if (!tbody) return;

    tbody.innerHTML = '';

    for (const item of this.fileItems) {
      if (item.status === 'error') {
        const tr = document.createElement('tr');
        tr.innerHTML = `
          <td><span style="color: #f7768e;">✕</span></td>
          <td style="font-weight: 600;">${item.fileName}</td>
          <td style="color: #f7768e;" colspan="11">${item.errorMessage}</td>
        `;
        tbody.appendChild(tr);
        continue;
      }

      for (const ch of item.channels) {
        const key = `${item.fileName}_ch${ch.channelIndex}`;
        const res = this.resultsMap.get(key);
        const isChecked = this.checkedRowKeys.has(key);
        const isSelected = this.selectedRowKey === key;

        const tr = document.createElement('tr');
        tr.className = `tool-row ${isSelected ? 'row-selected' : ''}`;
        tr.style.cursor = 'pointer';

        // Checkbox & selection click
        tr.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).tagName.toLowerCase() !== 'input') {
            this.selectRow(key, item, ch, res);
          }
        });

        const rateBadge = item.sampleRate <= 8000
          ? `<span class="badge-tag" style="background: rgba(224, 175, 104, 0.2); color: #e0af68; font-size: 10px;" title="Narrowband 8kHz telephony">8kHz NB</span>`
          : `<span style="font-size: 11px; color: var(--text-dim);">${item.sampleRate} Hz</span>`;

        const effectiveBw = item.bandwidth?.effectiveBandwidthHz
          ? `<span style="font-size: 10px; color: #7aa2f7;"> (~${(item.bandwidth.effectiveBandwidthHz / 1000).toFixed(1)}k eff)</span>`
          : '';

        const chNameLabel = ch.isMonoDownmix
          ? `<span class="badge-tag" style="background: rgba(187, 154, 247, 0.2); color: #bb9af7;">${ch.channelName}</span>`
          : ch.channelName;

        const chMetrics = ch.isSilent
          ? `<span style="color: var(--text-dim); font-size: 11px;">Silent (${ch.peakDbfs} dBFS)</span>`
          : `<span style="font-size: 11px; font-family: monospace;">RMS: ${ch.rmsDbfs} | Pk: ${ch.peakDbfs}</span>`;

        // DNSMOS scores cells
        let sigCell = '--';
        let bakCell = '--';
        let ovrlCell = '--';
        let p808Cell = '--';
        let confCell = '<span style="color: var(--text-dim);">Ready</span>';
        let rtfCell = '--';

        if (ch.isSilent) {
          confCell = `<span class="badge-tag" style="background: rgba(255,255,255,0.1); color: var(--text-dim); font-size: 10px;">Skipped (Silent)</span>`;
        } else if (res) {
          sigCell = `<span style="color: #2ac3de; font-weight: 700;">${res.sig.toFixed(2)}</span> <span style="font-size: 10px; color: var(--text-dim);">[${res.sig_min.toFixed(1)}-${res.sig_max.toFixed(1)}]</span>`;
          bakCell = `<span style="color: #bb9af7; font-weight: 700;">${res.bak.toFixed(2)}</span> <span style="font-size: 10px; color: var(--text-dim);">[${res.bak_min.toFixed(1)}-${res.bak_max.toFixed(1)}]</span>`;
          ovrlCell = `<span style="color: #9ece6a; font-weight: 700;">${res.ovrl.toFixed(2)}</span> <span style="font-size: 10px; color: var(--text-dim);">[${res.ovrl_min.toFixed(1)}-${res.ovrl_max.toFixed(1)}]</span>`;
          p808Cell = res.p808 !== undefined ? `<span style="color: #ff9e64; font-weight: 700;">${res.p808.toFixed(2)}</span>` : '--';
          const confColor = res.confidence.level === 'high' ? '#9ece6a' : res.confidence.level === 'medium' ? '#e0af68' : '#f7768e';
          confCell = `<span class="badge-tag" style="background: rgba(255,255,255,0.08); color: ${confColor}; font-size: 10px;" title="${res.confidence.reasons.join('\n')}">${res.confidence.level.toUpperCase()}</span>`;
          rtfCell = `<span style="font-size: 11px; font-family: monospace;">${res.realtimeFactor}x</span>`;
        }

        tr.innerHTML = `
          <td style="text-align: center;"><input type="checkbox" class="chk-tool-compare" data-key="${key}" ${isChecked ? 'checked' : ''}></td>
          <td><div style="font-weight: 600; font-size: 12px;">${item.fileName}</div><div style="font-size: 11px; color: var(--text-dim);">${chNameLabel}</div></td>
          <td style="font-size: 11px;">${item.formatName}</td>
          <td>${rateBadge}${effectiveBw}</td>
          <td style="font-size: 11px; font-family: monospace;">${item.durationSec.toFixed(1)}s</td>
          <td>${chMetrics}</td>
          <td>${sigCell}</td>
          <td>${bakCell}</td>
          <td>${ovrlCell}</td>
          <td>${p808Cell}</td>
          <td>${confCell}</td>
          <td>${rtfCell}</td>
          <td>
            <button class="btn btn-sm btn-tool-score-one" style="padding: 2px 8px; font-size: 11px;" data-key="${key}">
              ${res ? 'Re-Score' : 'Score'}
            </button>
          </td>
        `;

        // Checkbox event
        const chk = tr.querySelector('.chk-tool-compare') as HTMLInputElement | null;
        if (chk) {
          chk.addEventListener('change', () => {
            if (chk.checked) {
              this.checkedRowKeys.add(key);
            } else {
              this.checkedRowKeys.delete(key);
            }
            this.handleCompareSelectionChange();
          });
        }

        // Single Score button
        const btnSingle = tr.querySelector('.btn-tool-score-one') as HTMLButtonElement | null;
        if (btnSingle) {
          btnSingle.addEventListener('click', async (e) => {
            e.stopPropagation();
            btnSingle.innerText = 'Scoring...';
            btnSingle.disabled = true;
            try {
              const scored = await DnsmosToolEngine.scoreChannel({
                fileId: item.id,
                fileName: item.fileName,
                channel: ch,
                sampleRate: item.sampleRate,
                formatName: item.formatName,
                bandwidth: item.bandwidth,
              });
              this.resultsMap.set(key, scored);
              this.renderTable();
              if (this.selectedRowKey === key) {
                this.selectRow(key, item, ch, scored);
              }
            } catch (err: any) {
              alert(err?.message || 'Scoring error');
            } finally {
              btnSingle.disabled = false;
            }
          });
        }

        tbody.appendChild(tr);
      }
    }
  }

  public selectRow(key: string, item: FileItemToScore, ch: ChannelAudio, res?: DnsmosResult): void {
    this.selectedRowKey = key;
    this.renderTable(); // Update selected styling

    const drawer = document.getElementById('dnsmos-tool-inspect-drawer');
    if (!drawer) return;

    drawer.style.display = 'block';

    // Header info in drawer
    const titleEl = document.getElementById('dnsmos-tool-drawer-title');
    if (titleEl) {
      titleEl.innerText = `${item.fileName} — ${ch.channelName} (${item.formatName}, ${item.sampleRate} Hz)`;
    }

    // Render Waveform Canvas
    this.renderWaveform(ch.data);

    // Render Timeline Canvas if result available
    if (res && res.windows.length > 0) {
      this.renderTimeline(res);
    } else {
      const canvas = document.getElementById('dnsmos-tool-timeline-canvas') as HTMLCanvasElement | null;
      if (canvas) {
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          ctx.fillStyle = '#666';
          ctx.font = '12px sans-serif';
          ctx.fillText('No timeline data available (run score to evaluate)', 20, 40);
        }
      }
    }
  }

  private renderWaveform(data: Float32Array): void {
    const canvas = document.getElementById('dnsmos-tool-waveform-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = (canvas.width = canvas.parentElement?.clientWidth || 800);
    const h = (canvas.height = 100);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);

    // Center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(0, h / 2);
    ctx.lineTo(w, h / 2);
    ctx.stroke();

    if (data.length === 0) return;

    // Draw min/max waveform peaks
    ctx.fillStyle = '#7aa2f7';
    const step = Math.ceil(data.length / w);
    const amp = h / 2;

    for (let i = 0; i < w; i++) {
      let min = 1.0;
      let max = -1.0;
      const start = i * step;
      const end = Math.min(data.length, start + step);
      for (let j = start; j < end; j++) {
        const s = data[j];
        if (s < min) min = s;
        if (s > max) max = s;
      }
      if (max < min) { min = 0; max = 0; }
      const yMin = amp + min * amp;
      const yMax = amp + max * amp;
      ctx.fillRect(i, yMin, 1, Math.max(1, yMax - yMin));
    }
  }

  private renderTimeline(res: DnsmosResult): void {
    const canvas = document.getElementById('dnsmos-tool-timeline-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = (canvas.width = canvas.parentElement?.clientWidth || 800);
    const h = (canvas.height = 160);
    ctx.clearRect(0, 0, w, h);

    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);

    // Grid lines for 1.0 to 5.0
    const margin = { top: 20, bottom: 30, left: 40, right: 20 };
    const plotW = w - margin.left - margin.right;
    const plotH = h - margin.top - margin.bottom;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.font = '10px monospace';

    for (let score = 1; score <= 5; score++) {
      const y = margin.top + plotH - ((score - 1) / 4) * plotH;
      ctx.beginPath();
      ctx.moveTo(margin.left, y);
      ctx.lineTo(w - margin.right, y);
      ctx.stroke();
      ctx.fillText(score.toFixed(1), 10, y + 3);
    }

    const wins = res.windows;
    if (wins.length === 0) return;

    const xForIdx = (idx: number) => margin.left + (idx / Math.max(1, wins.length - 1)) * plotW;
    const yForScore = (s: number) => margin.top + plotH - ((Math.max(1.0, Math.min(5.0, s)) - 1) / 4) * plotH;

    // Draw SIG (cyan), BAK (purple), OVRL (green)
    const traces = [
      { name: 'SIG', color: '#2ac3de', fn: (w: any) => w.sig },
      { name: 'BAK', color: '#bb9af7', fn: (w: any) => w.bak },
      { name: 'OVRL', color: '#9ece6a', fn: (w: any) => w.ovrl },
    ];

    for (const trace of traces) {
      ctx.strokeStyle = trace.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < wins.length; i++) {
        const x = xForIdx(i);
        const y = yForScore(trace.fn(wins[i]));
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Dots
      ctx.fillStyle = trace.color;
      for (let i = 0; i < wins.length; i++) {
        const x = xForIdx(i);
        const y = yForScore(trace.fn(wins[i]));
        ctx.beginPath();
        ctx.arc(x, y, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  public handleCompareSelectionChange(): void {
    const selectedKeys = Array.from(this.checkedRowKeys);
    if (selectedKeys.length < 2) {
      this.hideCompareDrawer();
      return;
    }

    const results: DnsmosResult[] = [];
    for (const key of selectedKeys) {
      const r = this.resultsMap.get(key);
      if (r) results.push(r);
    }

    if (results.length < 2) {
      this.hideCompareDrawer();
      return;
    }

    const comparison = DnsmosToolEngine.compareMultiple(results);
    this.renderCompareDrawer(comparison);
  }

  private renderCompareDrawer(comp: MultiItemComparison): void {
    const drawer = document.getElementById('dnsmos-tool-compare-drawer');
    const tbody = document.getElementById('dnsmos-tool-compare-tbody');
    const alertBox = document.getElementById('dnsmos-tool-compare-alert');
    if (!drawer || !tbody) return;

    drawer.style.display = 'block';
    tbody.innerHTML = '';

    if (alertBox) {
      if (comp.hasRateMismatch) {
        alertBox.style.display = 'block';
        alertBox.className = 'alert-banner alert-warning';
        alertBox.innerText = comp.rateMismatchWarning || '';
      } else if (comp.hasCodecMismatch) {
        alertBox.style.display = 'block';
        alertBox.className = 'alert-banner alert-info';
        alertBox.innerText = comp.codecMismatchWarning || '';
      } else {
        alertBox.style.display = 'none';
      }
    }

    for (let i = 0; i < comp.items.length; i++) {
      const it = comp.items[i];
      const r = it.result;
      const isBase = i === 0;

      const formatDelta = (val: number) => {
        if (isBase) return '<span style="color: var(--text-dim);">(Base)</span>';
        const sign = val > 0 ? '+' : '';
        const color = val > 0 ? '#9ece6a' : val < 0 ? '#f7768e' : 'var(--text-dim)';
        return `<span style="color: ${color}; font-weight: 700;">${sign}${val.toFixed(2)}</span>`;
      };

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="font-weight: 600;">${r.fileInfo?.fileName || r.streamId} [${r.fileInfo?.channelName || 'Ch'}]</td>
        <td>${r.originalSampleRate} Hz</td>
        <td><span style="color: #2ac3de; font-weight: 700;">${r.sig.toFixed(2)}</span> ${formatDelta(it.deltaSigAgainstBase)}</td>
        <td><span style="color: #bb9af7; font-weight: 700;">${r.bak.toFixed(2)}</span> ${formatDelta(it.deltaBakAgainstBase)}</td>
        <td><span style="color: #9ece6a; font-weight: 700;">${r.ovrl.toFixed(2)}</span> ${formatDelta(it.deltaOvrl)}</td>
        <td>${r.p808 !== undefined ? r.p808.toFixed(2) : '--'}</td>
      `;
      tbody.appendChild(tr);
    }
  }

  private hideInspectionDrawer(): void {
    const drawer = document.getElementById('dnsmos-tool-inspect-drawer');
    if (drawer) drawer.style.display = 'none';
    this.stopPlayback();
  }

  private hideCompareDrawer(): void {
    const drawer = document.getElementById('dnsmos-tool-compare-drawer');
    if (drawer) drawer.style.display = 'none';
  }

  // --- Audio Playback ---
  private togglePlayback(): void {
    if (this.isPlaying) {
      this.stopPlayback();
    } else {
      this.startPlayback();
    }
  }

  private startPlayback(): void {
    if (!this.selectedRowKey) return;
    const parts = this.selectedRowKey.split('_ch');
    const fileName = parts[0];
    const chIdx = parseInt(parts[1], 10);
    const item = this.fileItems.find(f => f.fileName === fileName);
    if (!item) return;

    const ch = item.channels.find(c => c.channelIndex === chIdx);
    if (!ch || ch.data.length === 0) return;

    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const rate = this.playbackMode === 'model16k' ? 16000 : item.sampleRate;
    const audioData = ch.data; // normalized float32

    const buf = this.audioCtx.createBuffer(1, audioData.length, rate);
    buf.copyToChannel(audioData as any, 0);

    this.currentSourceNode = this.audioCtx.createBufferSource();
    this.currentSourceNode.buffer = buf;
    this.currentSourceNode.connect(this.audioCtx.destination);
    this.currentSourceNode.onended = () => {
      this.isPlaying = false;
      this.updatePlayButton();
    };

    this.currentSourceNode.start();
    this.isPlaying = true;
    this.updatePlayButton();
  }

  private stopPlayback(): void {
    if (this.currentSourceNode) {
      try {
        this.currentSourceNode.stop();
        this.currentSourceNode.disconnect();
      } catch (e) {}
      this.currentSourceNode = null;
    }
    this.isPlaying = false;
    this.updatePlayButton();
  }

  private updatePlayButton(): void {
    const btnPlay = document.getElementById('btn-tool-play');
    if (btnPlay) {
      btnPlay.innerHTML = this.isPlaying ? '&#x23F8; Pause' : '&#x25B6; Play';
    }
  }

  // --- CSV / JSON Export ---
  public exportCsv(): void {
    if (this.resultsMap.size === 0) {
      alert('No results available to export.');
      return;
    }

    const rows: string[] = [];
    rows.push('FileName,ChannelIndex,ChannelName,Codec,NativeSampleRate,ModelSampleRate,StartSec,EndSec,SIG,BAK,OVRL,P808,Confidence');

    for (const [key, res] of this.resultsMap.entries()) {
      for (const w of res.windows) {
        rows.push([
          `"${res.fileInfo?.fileName || res.streamId}"`,
          res.fileInfo?.channelIndex ?? 0,
          `"${res.fileInfo?.channelName || 'Ch'}"`,
          `"${res.codec}"`,
          res.originalSampleRate,
          res.modelSampleRate,
          w.startSec,
          w.endSec,
          w.sig,
          w.bak,
          w.ovrl,
          w.p808 !== undefined ? w.p808 : '',
          `"${res.confidence.level}"`,
        ].join(','));
      }
    }

    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dnsmos_tool_results_${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  public exportJson(): void {
    if (this.resultsMap.size === 0) {
      alert('No results available to export.');
      return;
    }

    const exportData = Array.from(this.resultsMap.values());
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `dnsmos_tool_results_${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  private updateBatchStatus(msg: string): void {
    const statusText = document.getElementById('dnsmos-tool-status-text');
    if (statusText) statusText.innerText = msg;
  }
}
