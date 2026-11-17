/**
 * AudioEditorController.ts
 * Core controller for the Clip Studio Audio Editor.
 * Manages clip tabs, waveform rendering, piece table operations, and playback transport.
 */

import { AudioBufferPool } from './AudioBufferPool.ts';
import { AudioPieceTable, type AudioPiece } from './AudioPieceTable.ts';
import { AudioEditorLoader, type WavExportOptions } from './AudioEditorLoader.ts';
import { EditorClipboard } from './EditorClipboard.ts';
import { UndoRedoStack, type UndoSnapshot } from './UndoRedoStack.ts';
import { AudioDspEngine } from './AudioDspEngine.ts';
import { AudioMixer, type MixMode, type PasteMixOptions } from './AudioMixer.ts';
import { AudioPreprocessor } from '../../codec/AudioPreprocessor.ts';
import type { PeakLevel, ChannelStats } from '../../workers/editor.worker.ts';

export interface EditorClipTab {
  id: string;
  name: string;
  table: AudioPieceTable;
  bufferId: string;
  selectionStartSample: number;
  selectionEndSample: number;
  zoomSamplesPerPixel: number; // e.g. 1 to 4096
  scrollSampleOffset: number;
  levels?: PeakLevel[];
  stats?: ChannelStats[];
  history: UndoRedoStack;
}

export class AudioEditorController {
  private static instance: AudioEditorController;

  private readonly pool = new AudioBufferPool();
  private readonly tabs: EditorClipTab[] = [];
  private activeTabIndex = -1;

  // Web Audio Transport
  private audioCtx: AudioContext | null = null;
  private isPlaying = false;
  private playheadSample = 0;
  private playbackStartTime = 0;
  private playbackStartSample = 0;
  private animationFrameId: number | null = null;
  private activeSourceNode: AudioBufferSourceNode | null = null;

  // DOM Elements
  private container: HTMLElement | null = null;
  private waveformCanvas: HTMLCanvasElement | null = null;
  private minimapCanvas: HTMLCanvasElement | null = null;
  private rulerCanvas: HTMLCanvasElement | null = null;

  // Interaction State
  private isSelecting = false;
  private selectionAnchorSample = 0;

  public static getInstance(): AudioEditorController {
    if (!this.instance) {
      this.instance = new AudioEditorController();
    }
    return this.instance;
  }

  public init(containerElement: HTMLElement): void {
    this.container = containerElement;
    this.setupDomBindings();
    this.setupCanvasListeners();
    this.setupKeyboardShortcuts();
    this.setupModals();
    this.updateMemoryDisplay();
  }

  public get activeTab(): EditorClipTab | null {
    if (this.activeTabIndex >= 0 && this.activeTabIndex < this.tabs.length) {
      return this.tabs[this.activeTabIndex];
    }
    return null;
  }

  public get allTabs(): readonly EditorClipTab[] {
    return this.tabs;
  }

  /**
   * Save an undo state before mutating the active tab's piece table.
   */
  private pushUndo(description: string): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.history.push({
      table: tab.table.clone(),
      selectionStartSample: tab.selectionStartSample,
      selectionEndSample: tab.selectionEndSample,
      playheadSample: this.playheadSample,
      description,
      timestamp: Date.now()
    });
  }

  /**
   * Open an audio file and load it into a new clip tab.
   */
  public async openAudioFile(file: File): Promise<EditorClipTab> {
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const imported = AudioEditorLoader.importAudio(bytes, file.name, this.pool);

    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const newTab: EditorClipTab = {
      id: tabId,
      name: file.name,
      table: imported.table,
      bufferId: imported.bufferId,
      selectionStartSample: 0,
      selectionEndSample: 0,
      zoomSamplesPerPixel: Math.max(16, Math.floor(imported.table.totalSamples / 1000)),
      scrollSampleOffset: 0,
      history: new UndoRedoStack(50)
    };

    this.computePyramidForTab(newTab);

    this.tabs.push(newTab);
    this.activeTabIndex = this.tabs.length - 1;

    this.renderTabsBar();
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();

    return newTab;
  }

  /**
   * Load audio directly from raw channel data (e.g. from TTS, Codec Converter, or RTP Stream).
   */
  public openFromChannelData(
    channelData: Float32Array[],
    sampleRate: number,
    name: string,
    bitDepth: number = 16
  ): EditorClipTab {
    const bufferId = this.pool.registerBuffer(channelData, sampleRate, bitDepth, name);
    const totalSamples = channelData[0] ? channelData[0].length : 0;
    const table = AudioPieceTable.fromBuffer(bufferId, sampleRate, channelData.length, totalSamples, bitDepth);

    const tabId = `tab-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`;
    const newTab: EditorClipTab = {
      id: tabId,
      name,
      table,
      bufferId,
      selectionStartSample: 0,
      selectionEndSample: 0,
      zoomSamplesPerPixel: Math.max(16, Math.floor(totalSamples / 1000)),
      scrollSampleOffset: 0,
      history: new UndoRedoStack(50)
    };

    this.computePyramidForTab(newTab);

    this.tabs.push(newTab);
    this.activeTabIndex = this.tabs.length - 1;

    this.renderTabsBar();
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();

    return newTab;
  }

  /**
   * Close a clip tab and free its source buffers if unreferenced.
   */
  public closeTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    if (this.isPlaying) this.stop();

    const [closed] = this.tabs.splice(index, 1);
    const isReferenced = this.tabs.some(t => t.bufferId === closed.bufferId);
    if (!isReferenced) {
      this.pool.releaseBuffer(closed.bufferId);
    }

    if (this.activeTabIndex >= this.tabs.length) {
      this.activeTabIndex = this.tabs.length - 1;
    }

    this.renderTabsBar();
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public selectTab(index: number): void {
    if (index < 0 || index >= this.tabs.length) return;
    if (this.isPlaying) this.stop();
    this.activeTabIndex = index;
    this.renderTabsBar();
    this.renderAll();
    this.updateStatusBar();
  }

  // --- Transport Controls ---

  public async play(fromSelection: boolean = false): Promise<void> {
    const tab = this.activeTab;
    if (!tab || tab.table.totalSamples === 0) return;

    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)({
        sampleRate: tab.table.sampleRate
      });
    }
    if (this.audioCtx.state === 'suspended') {
      await this.audioCtx.resume();
    }

    if (this.isPlaying) {
      this.stop();
    }

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    let startSample = 0;
    let endSample = tab.table.totalSamples;

    if (fromSelection && hasSelection) {
      startSample = tab.selectionStartSample;
      endSample = tab.selectionEndSample;
    } else {
      startSample = this.playheadSample < tab.table.totalSamples ? this.playheadSample : 0;
    }

    const lengthSamples = endSample - startSample;
    if (lengthSamples <= 0) return;

    const audioBuffer = this.audioCtx.createBuffer(
      tab.table.numChannels,
      lengthSamples,
      tab.table.sampleRate
    );

    for (let c = 0; c < tab.table.numChannels; c++) {
      const chData = tab.table.readSamples(startSample, lengthSamples, c, this.pool);
      audioBuffer.getChannelData(c).set(chData);
    }

    const source = this.audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioCtx.destination);

    source.onended = () => {
      if (this.isPlaying) {
        this.isPlaying = false;
        this.playheadSample = endSample >= tab.table.totalSamples ? 0 : endSample;
        this.cancelAnimation();
        this.updatePlayBtnText('▶ Play');
        this.drawWaveform();
      }
    };

    this.activeSourceNode = source;
    this.isPlaying = true;
    this.playbackStartTime = this.audioCtx.currentTime;
    this.playbackStartSample = startSample;
    source.start(0);

    this.updatePlayBtnText('⏸ Pause');
    this.startPlaybackTracker(tab.table.sampleRate, lengthSamples);
  }

  public pause(): void {
    if (!this.isPlaying) return;
    if (this.activeSourceNode) {
      try { this.activeSourceNode.stop(); } catch {}
      this.activeSourceNode.disconnect();
      this.activeSourceNode = null;
    }
    this.isPlaying = false;
    this.cancelAnimation();
    this.updatePlayBtnText('▶ Play');
    this.drawWaveform();
  }

  public stop(): void {
    this.pause();
    this.playheadSample = 0;
    this.drawWaveform();
    this.updateTimeDisplay();
  }

  private updatePlayBtnText(text: string): void {
    const btn = document.getElementById('btn-editor-play');
    if (btn) btn.textContent = text;
  }

  private startPlaybackTracker(sampleRate: number, lengthSamples: number): void {
    const update = () => {
      if (!this.isPlaying || !this.audioCtx) return;
      const elapsed = this.audioCtx.currentTime - this.playbackStartTime;
      const currentOffset = Math.floor(elapsed * sampleRate);

      if (currentOffset >= lengthSamples) {
        return;
      }

      this.playheadSample = this.playbackStartSample + currentOffset;
      this.drawWaveform();
      this.updateTimeDisplay();
      this.animationFrameId = requestAnimationFrame(update);
    };
    this.animationFrameId = requestAnimationFrame(update);
  }

  private cancelAnimation(): void {
    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // --- Zoom & Scroll ---

  public zoomIn(): void {
    const tab = this.activeTab;
    if (!tab) return;
    tab.zoomSamplesPerPixel = Math.max(1, Math.floor(tab.zoomSamplesPerPixel / 1.5));
    this.drawWaveform();
    this.drawRuler();
    this.drawMinimap();
  }

  public zoomOut(): void {
    const tab = this.activeTab;
    if (!tab) return;
    const maxZoom = Math.max(16, Math.ceil(tab.table.totalSamples / 500));
    tab.zoomSamplesPerPixel = Math.min(maxZoom, Math.ceil(tab.zoomSamplesPerPixel * 1.5));
    this.drawWaveform();
    this.drawRuler();
    this.drawMinimap();
  }

  public zoomFitAll(): void {
    const tab = this.activeTab;
    if (!tab || !this.waveformCanvas) return;
    const width = this.waveformCanvas.width || 1000;
    tab.zoomSamplesPerPixel = Math.max(1, Math.ceil(tab.table.totalSamples / width));
    tab.scrollSampleOffset = 0;
    this.drawWaveform();
    this.drawRuler();
    this.drawMinimap();
  }

  // --- Core Edit Operations (Phase 3) ---

  public cut(): void {
    const tab = this.activeTab;
    if (!tab || tab.selectionEndSample <= tab.selectionStartSample) return;

    this.pushUndo('Cut');
    const start = tab.selectionStartSample;
    const len = tab.selectionEndSample - start;

    // Read and copy channels to clipboard
    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }
    EditorClipboard.getInstance().copy(channels, tab.table.sampleRate, tab.table.bitDepth, tab.name);

    // Delete range from piece table
    const { table } = tab.table.delete(start, len);
    tab.table = table;
    tab.selectionEndSample = start;
    this.playheadSample = start;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public copy(): void {
    const tab = this.activeTab;
    if (!tab) return;

    let start = 0;
    let len = tab.table.totalSamples;
    if (tab.selectionEndSample > tab.selectionStartSample) {
      start = tab.selectionStartSample;
      len = tab.selectionEndSample - start;
    }

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }
    EditorClipboard.getInstance().copy(channels, tab.table.sampleRate, tab.table.bitDepth, tab.name);

    const elSel = document.getElementById('cs-editor-status-selection');
    if (elSel) {
      const origText = elSel.textContent;
      elSel.textContent = `📋 Copied ${(len / tab.table.sampleRate).toFixed(3)}s to clipboard`;
      setTimeout(() => { if (elSel.textContent?.startsWith('📋')) elSel.textContent = origText; }, 2000);
    }
  }

  public paste(): void {
    const tab = this.activeTab;
    if (!tab || !EditorClipboard.getInstance().hasContent) return;

    this.pushUndo('Paste');
    const pasted = EditorClipboard.getInstance().pasteForTarget(
      tab.table.sampleRate,
      tab.table.numChannels,
      this.pool
    );
    if (!pasted) return;

    if (pasted.notice) {
      console.info(`[AudioEditor] Paste format adaptation: ${pasted.notice}`);
    }

    const insertPiece: AudioPiece = {
      bufferId: pasted.bufferId,
      srcStartSample: 0,
      lengthSamples: pasted.lengthSamples
    };

    let insertOffset = this.playheadSample;
    if (tab.selectionEndSample > tab.selectionStartSample) {
      // Overwrite active selection
      insertOffset = tab.selectionStartSample;
      const delLen = tab.selectionEndSample - insertOffset;
      const { table } = tab.table.delete(insertOffset, delLen);
      tab.table = table.insert(insertOffset, [insertPiece]);
    } else {
      tab.table = tab.table.insert(insertOffset, [insertPiece]);
    }

    this.playheadSample = insertOffset + pasted.lengthSamples;
    tab.selectionStartSample = this.playheadSample;
    tab.selectionEndSample = this.playheadSample;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public pasteNew(): void {
    const cb = EditorClipboard.getInstance();
    const item = cb.getItem();
    if (!item) return;

    this.openFromChannelData(
      item.channels,
      item.sampleRate,
      `Clip ${this.tabs.length + 1} (Paste)`,
      item.bitDepth
    );
  }

  public deleteSelection(): void {
    const tab = this.activeTab;
    if (!tab || tab.selectionEndSample <= tab.selectionStartSample) return;

    this.pushUndo('Delete');
    const start = tab.selectionStartSample;
    const len = tab.selectionEndSample - start;

    const { table } = tab.table.delete(start, len);
    tab.table = table;
    tab.selectionEndSample = start;
    this.playheadSample = start;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public trimSelection(): void {
    const tab = this.activeTab;
    if (!tab || tab.selectionEndSample <= tab.selectionStartSample) return;

    this.pushUndo('Crop');
    const start = tab.selectionStartSample;
    const len = tab.selectionEndSample - start;

    const pieces = tab.table.slice(start, len);
    tab.table = new AudioPieceTable(tab.table.sampleRate, tab.table.numChannels, tab.table.bitDepth, pieces);
    tab.selectionStartSample = 0;
    tab.selectionEndSample = 0;
    this.playheadSample = 0;
    tab.scrollSampleOffset = 0;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public silenceSelection(): void {
    const tab = this.activeTab;
    if (!tab || tab.selectionEndSample <= tab.selectionStartSample) return;

    this.pushUndo('Silence');
    const start = tab.selectionStartSample;
    const len = tab.selectionEndSample - start;

    const silence = AudioDspEngine.generateSilence(len / tab.table.sampleRate, tab.table.sampleRate, tab.table.numChannels);
    const bufId = this.pool.registerBuffer(silence, tab.table.sampleRate, tab.table.bitDepth, 'silence');

    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public undo(): void {
    const tab = this.activeTab;
    if (!tab || !tab.history.canUndo) return;

    const currentSnapshot: UndoSnapshot = {
      table: tab.table.clone(),
      selectionStartSample: tab.selectionStartSample,
      selectionEndSample: tab.selectionEndSample,
      playheadSample: this.playheadSample,
      description: 'Current',
      timestamp: Date.now()
    };

    const previous = tab.history.undo(currentSnapshot);
    if (!previous) return;

    tab.table = previous.table;
    tab.selectionStartSample = previous.selectionStartSample;
    tab.selectionEndSample = previous.selectionEndSample;
    this.playheadSample = previous.playheadSample;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public redo(): void {
    const tab = this.activeTab;
    if (!tab || !tab.history.canRedo) return;

    const currentSnapshot: UndoSnapshot = {
      table: tab.table.clone(),
      selectionStartSample: tab.selectionStartSample,
      selectionEndSample: tab.selectionEndSample,
      playheadSample: this.playheadSample,
      description: 'Current',
      timestamp: Date.now()
    };

    const next = tab.history.redo(currentSnapshot);
    if (!next) return;

    tab.table = next.table;
    tab.selectionStartSample = next.selectionStartSample;
    tab.selectionEndSample = next.selectionEndSample;
    this.playheadSample = next.playheadSample;

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  // --- DSP & Effects Processing (Phase 4 & 5) ---

  public applyGain(gainDb: number): void {
    const tab = this.activeTab;
    if (!tab) return;

    this.pushUndo(`Gain ${gainDb >= 0 ? '+' : ''}${gainDb.toFixed(1)} dB`);

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const start = hasSelection ? tab.selectionStartSample : 0;
    const len = hasSelection ? (tab.selectionEndSample - start) : tab.table.totalSamples;

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }

    const boosted = AudioDspEngine.applyGainDb(channels, gainDb);
    const bufId = this.pool.registerBuffer(boosted, tab.table.sampleRate, tab.table.bitDepth, 'gain');

    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public applyNormalize(type: 'peak' | 'loudness', targetVal: number): void {
    const tab = this.activeTab;
    if (!tab) return;

    this.pushUndo(`Normalize ${type}`);

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const start = hasSelection ? tab.selectionStartSample : 0;
    const len = hasSelection ? (tab.selectionEndSample - start) : tab.table.totalSamples;

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }

    let normalized: Float32Array[] = [];
    if (type === 'peak') {
      const res = AudioDspEngine.peakNormalize(channels, targetVal);
      normalized = res.channels;
    } else {
      const res = AudioDspEngine.loudnessNormalize(channels, targetVal);
      normalized = res.channels;
    }

    const bufId = this.pool.registerBuffer(normalized, tab.table.sampleRate, tab.table.bitDepth, 'norm');
    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public applyFade(direction: 'in' | 'out'): void {
    const tab = this.activeTab;
    if (!tab) return;

    this.pushUndo(`Fade ${direction}`);

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const start = hasSelection ? tab.selectionStartSample : 0;
    const len = hasSelection ? (tab.selectionEndSample - start) : tab.table.totalSamples;

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }

    const faded = AudioDspEngine.applyFade(channels, direction, 'linear');
    const bufId = this.pool.registerBuffer(faded, tab.table.sampleRate, tab.table.bitDepth, `fade-${direction}`);

    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public reverse(): void {
    const tab = this.activeTab;
    if (!tab) return;

    this.pushUndo('Reverse');

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const start = hasSelection ? tab.selectionStartSample : 0;
    const len = hasSelection ? (tab.selectionEndSample - start) : tab.table.totalSamples;

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }

    const reversed = AudioDspEngine.reverse(channels);
    const bufId = this.pool.registerBuffer(reversed, tab.table.sampleRate, tab.table.bitDepth, 'reverse');

    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public invertPolarity(): void {
    const tab = this.activeTab;
    if (!tab) return;

    this.pushUndo('Invert');

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const start = hasSelection ? tab.selectionStartSample : 0;
    const len = hasSelection ? (tab.selectionEndSample - start) : tab.table.totalSamples;

    const channels: Float32Array[] = [];
    for (let c = 0; c < tab.table.numChannels; c++) {
      channels.push(tab.table.readSamples(start, len, c, this.pool));
    }

    const inverted = AudioDspEngine.invertPolarity(channels);
    const bufId = this.pool.registerBuffer(inverted, tab.table.sampleRate, tab.table.bitDepth, 'invert');

    const { table } = tab.table.delete(start, len);
    tab.table = table.insert(start, [{
      bufferId: bufId,
      srcStartSample: 0,
      lengthSamples: len
    }]);

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  public applyMix(options: PasteMixOptions, sourceKey: string): void {
    const tab = this.activeTab;
    if (!tab) return;

    let srcChannels: Float32Array[] = [];
    let srcRate = tab.table.sampleRate;

    if (sourceKey === 'clipboard') {
      const item = EditorClipboard.getInstance().getItem();
      if (!item) {
        alert('Clipboard is empty. Copy audio first.');
        return;
      }
      srcChannels = item.channels;
      srcRate = item.sampleRate;
    } else {
      const sourceTab = this.tabs.find(t => t.id === sourceKey);
      if (!sourceTab) return;
      srcChannels = sourceTab.table.flatten(this.pool);
      srcRate = sourceTab.table.sampleRate;
    }

    // Resample if rates differ
    if (srcRate !== tab.table.sampleRate) {
      srcChannels = srcChannels.map(ch => AudioPreprocessor.resample(ch, srcRate, tab.table.sampleRate));
    }

    this.pushUndo('Mix');
    const targetChannels = tab.table.flatten(this.pool);
    const mixResult = AudioMixer.mix(targetChannels, srcChannels, options, tab.table.sampleRate);

    const bufId = this.pool.registerBuffer(mixResult.channels, tab.table.sampleRate, tab.table.bitDepth, 'mix');
    tab.table = AudioPieceTable.fromBuffer(bufId, tab.table.sampleRate, mixResult.channels.length, mixResult.channels[0].length, tab.table.bitDepth);

    if (mixResult.isClipped && options.clippingStrategy === 'auto-reduce') {
      alert(`⚠️ Clipping was prevented by automatically reducing gain by ${mixResult.attenuationGainDb} dB.`);
    }

    this.computePyramidForTab(tab);
    this.renderAll();
    this.updateStatusBar();
    this.updateMemoryDisplay();
  }

  // --- Telephony Signals & Generators (Phase 6) ---

  public generateTelephony(type: string, params: any, placement: 'new-tab' | 'insert' | 'replace'): void {
    const tab = this.activeTab;
    const sampleRate = tab ? tab.table.sampleRate : 16000;
    let channels: Float32Array[] = [];
    let name = 'Generated Signal';

    if (type === 'sine') {
      channels = AudioDspEngine.generateSine(params.freq, params.dur, sampleRate, 0.5);
      name = `Sine ${params.freq}Hz (${params.dur}s)`;
    } else if (type === 'dtmf') {
      const dtmfChannels: Float32Array[] = [];
      const digits = (params.digits || '1').split('');
      for (const d of digits) {
        const dTone = AudioDspEngine.generateDtmf({
          digit: d,
          durationMs: params.toneDur || 100,
          silenceMs: params.silenceDur || 50,
          sampleRate
        });
        dtmfChannels.push(dTone[0]);
      }
      const concatenated = AudioMixer.concat(dtmfChannels.map(c => [c]), 0);
      channels = concatenated;
      name = `DTMF ${params.digits}`;
    } else if (type === 'callprogress') {
      channels = AudioDspEngine.generateCallProgressTone({
        type: params.cpType,
        durationSec: params.dur,
        sampleRate
      });
      name = `Call Progress (${params.cpType})`;
    } else if (type === 'noise-snr') {
      if (!tab) {
        channels = AudioDspEngine.generateNoise(params.color, 2.0, sampleRate, 0.3);
        name = `${params.color} Noise`;
      } else {
        const speech = tab.table.flatten(this.pool);
        const noise = AudioDspEngine.generateNoise(params.color, tab.table.durationSec, sampleRate, 0.3);
        channels = AudioDspEngine.addNoiseAtTargetSnr(speech, noise, params.snr);
        name = `${tab.name} + ${params.snr}dB Noise`;
      }
    } else if (type === 'silence') {
      channels = AudioDspEngine.generateSilence(1.0, sampleRate);
      name = 'Silence (1.0s)';
    }

    if (placement === 'new-tab' || !tab) {
      this.openFromChannelData(channels, sampleRate, name, 16);
    } else if (placement === 'insert') {
      this.pushUndo(`Insert ${name}`);
      const bufId = this.pool.registerBuffer(channels, sampleRate, tab.table.bitDepth, name);
      tab.table = tab.table.insert(this.playheadSample, [{
        bufferId: bufId,
        srcStartSample: 0,
        lengthSamples: channels[0].length
      }]);
      this.playheadSample += channels[0].length;
      this.computePyramidForTab(tab);
      this.renderAll();
      this.updateStatusBar();
      this.updateMemoryDisplay();
    } else if (placement === 'replace') {
      this.pushUndo(`Replace with ${name}`);
      const start = tab.selectionStartSample;
      const len = tab.selectionEndSample > start ? tab.selectionEndSample - start : tab.table.totalSamples;
      const bufId = this.pool.registerBuffer(channels, sampleRate, tab.table.bitDepth, name);
      const { table } = tab.table.delete(start, len);
      tab.table = table.insert(start, [{
        bufferId: bufId,
        srcStartSample: 0,
        lengthSamples: channels[0].length
      }]);
      this.computePyramidForTab(tab);
      this.renderAll();
      this.updateStatusBar();
      this.updateMemoryDisplay();
    }
  }

  // --- In-App Handoff Actions (Phase 5) ---

  public sendToCodecConverter(): void {
    const tab = this.activeTab;
    if (!tab) return;

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const opts: WavExportOptions = {
      bitDepth: 16,
      selection: hasSelection ? {
        startSample: tab.selectionStartSample,
        lengthSamples: tab.selectionEndSample - tab.selectionStartSample
      } : undefined
    };

    const wavBytes = AudioEditorLoader.exportWav(tab.table, this.pool, opts);
    const fileName = `${tab.name.replace(/\.[^/.]+$/, '')}_edited.wav`;

    // Dynamic import to avoid circular dependency
    import('../ClipStudioController.ts').then(({ ClipStudioController }) => {
      const cs = ClipStudioController.getInstance();
      cs.loadFromExternalWav(wavBytes, fileName);
    });
  }

  public sendToDnsmos(): void {
    const tab = this.activeTab;
    if (!tab) return;

    const wavBytes = AudioEditorLoader.exportWav(tab.table, this.pool, { bitDepth: 16 });
    const fileName = `${tab.name.replace(/\.[^/.]+$/, '')}_edited.wav`;
    const file = new File([wavBytes.buffer as ArrayBuffer], fileName, { type: 'audio/wav' });

    // Switch to DNSMOS tab
    const tabBtn = document.querySelector('[data-tab="tab-dnsmos-tool"]') as HTMLElement | null;
    if (tabBtn) tabBtn.click();

    setTimeout(() => {
      const ctrl = (window as any).dnsmosToolController;
      if (ctrl && typeof ctrl.handleIncomingFiles === 'function') {
        ctrl.handleIncomingFiles([file]);
      }
    }, 100);
  }

  public sendToSnr(): void {
    // Switch to RTP stream analysis tab
    const tabBtn = document.querySelector('[data-tab="tab-rtp"]') as HTMLElement | null;
    if (tabBtn) tabBtn.click();
  }

  // --- Peak Pyramid In-Process Computation ---

  private computePyramidForTab(tab: EditorClipTab): void {
    const channelData = tab.table.flatten(this.pool);
    const numChannels = channelData.length;
    const numSamples = channelData[0] ? channelData[0].length : 0;
    const bucketSizes = [16, 64, 256, 1024, 4096];

    const stats: ChannelStats[] = [];
    for (let c = 0; c < numChannels; c++) {
      const ch = channelData[c];
      let peak = 0;
      let sumSq = 0;
      let clipCount = 0;

      for (let i = 0; i < ch.length; i++) {
        const absVal = Math.abs(ch[i]);
        if (absVal > peak) peak = absVal;
        sumSq += ch[i] * ch[i];
        if (absVal >= 0.9999) clipCount++;
      }

      const rms = ch.length > 0 ? Math.sqrt(sumSq / ch.length) : 0;
      const peakDbfs = peak > 1e-6 ? 20 * Math.log10(peak) : -96.0;
      const rmsDbfs = rms > 1e-6 ? 20 * Math.log10(rms) : -96.0;

      stats.push({
        channelIndex: c,
        peakAmplitude: peak,
        peakDbfs: Math.round(peakDbfs * 10) / 10,
        rmsDbfs: Math.round(rmsDbfs * 10) / 10,
        clippingCount: clipCount,
        isClipped: clipCount > 0
      });
    }

    const levels: PeakLevel[] = [];
    for (const bucketSize of bucketSizes) {
      const numBuckets = Math.ceil(numSamples / bucketSize);
      const levelChannels: Array<{ min: Float32Array; max: Float32Array }> = [];

      for (let c = 0; c < numChannels; c++) {
        const src = channelData[c];
        const minArr = new Float32Array(numBuckets);
        const maxArr = new Float32Array(numBuckets);

        for (let b = 0; b < numBuckets; b++) {
          const start = b * bucketSize;
          const end = Math.min(start + bucketSize, numSamples);
          let bMin = 1.0;
          let bMax = -1.0;

          for (let i = start; i < end; i++) {
            const v = src[i];
            if (v < bMin) bMin = v;
            if (v > bMax) bMax = v;
          }

          minArr[b] = bMin <= bMax ? bMin : 0;
          maxArr[b] = bMax >= bMin ? bMax : 0;
        }
        levelChannels.push({ min: minArr, max: maxArr });
      }
      levels.push({ samplesPerBucket: bucketSize, channels: levelChannels });
    }

    tab.levels = levels;
    tab.stats = stats;
  }

  // --- Canvas Rendering Pipeline ---

  public renderAll(): void {
    this.drawRuler();
    this.drawWaveform();
    this.drawMinimap();
    this.updateTimeDisplay();
  }

  public drawWaveform(): void {
    if (!this.waveformCanvas) return;
    const canvas = this.waveformCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    const tab = this.activeTab;
    if (!tab || tab.table.totalSamples === 0) {
      ctx.fillStyle = '#1a1b26';
      ctx.fillRect(0, 0, width, height);
      ctx.fillStyle = '#565f89';
      ctx.font = '14px Inter, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('No clip loaded. Click "Open WAV / PCM" to start.', width / 2, height / 2);
      return;
    }

    const numChannels = tab.table.numChannels;
    const chHeight = height / numChannels;
    const spp = tab.zoomSamplesPerPixel;
    const startSample = tab.scrollSampleOffset;

    // 1. Channel backgrounds & centerlines
    for (let c = 0; c < numChannels; c++) {
      const topY = c * chHeight;
      const midY = topY + chHeight / 2;

      ctx.fillStyle = c % 2 === 0 ? '#16161e' : '#1a1b26';
      ctx.fillRect(0, topY, width, chHeight);

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(width, midY);
      ctx.stroke();

      ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.fillText(numChannels === 1 ? 'Mono' : c === 0 ? 'L' : 'R', 8, topY + 16);
    }

    // 2. Selection highlight (GoldWave-style translucent overlay)
    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    if (hasSelection) {
      const selStartX = (tab.selectionStartSample - startSample) / spp;
      const selEndX = (tab.selectionEndSample - startSample) / spp;
      const x1 = Math.max(0, selStartX);
      const x2 = Math.min(width, selEndX);

      if (x2 > x1) {
        ctx.fillStyle = 'rgba(65, 166, 246, 0.22)';
        ctx.fillRect(x1, 0, x2 - x1, height);

        ctx.strokeStyle = '#7aa2f7';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x1, 0); ctx.lineTo(x1, height);
        ctx.moveTo(x2, 0); ctx.lineTo(x2, height);
        ctx.stroke();
      }
    }

    // 3. Waveforms per channel
    const level = tab.levels ? tab.levels[0] : null;

    for (let c = 0; c < numChannels; c++) {
      const topY = c * chHeight;
      const midY = topY + chHeight / 2;
      const ampScale = (chHeight / 2) * 0.95;

      ctx.strokeStyle = '#7aa2f7';
      ctx.lineWidth = 1;
      ctx.beginPath();

      if (level && level.channels[c]) {
        const { min, max } = level.channels[c];
        const bucketSize = level.samplesPerBucket;

        for (let x = 0; x < width; x++) {
          const sampleIdx = startSample + x * spp;
          if (sampleIdx >= tab.table.totalSamples) break;

          const bIdx = Math.floor(sampleIdx / bucketSize);
          if (bIdx < min.length) {
            const yMin = midY - min[bIdx] * ampScale;
            const yMax = midY - max[bIdx] * ampScale;
            ctx.moveTo(x, Math.min(yMin, yMax));
            ctx.lineTo(x, Math.max(yMin, yMax) + 0.5);
          }
        }
        ctx.stroke();
      } else {
        const samples = tab.table.readSamples(startSample, width * spp, c, this.pool);
        for (let x = 0; x < width; x++) {
          const s = samples[x * spp] || 0;
          const y = midY - s * ampScale;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
    }

    // 4. Playhead line
    if (this.playheadSample >= startSample && this.playheadSample <= startSample + width * spp) {
      const playX = (this.playheadSample - startSample) / spp;
      ctx.strokeStyle = '#f7768e';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(playX, 0);
      ctx.lineTo(playX, height);
      ctx.stroke();

      ctx.fillStyle = '#f7768e';
      ctx.beginPath();
      ctx.moveTo(playX - 5, 0);
      ctx.lineTo(playX + 5, 0);
      ctx.lineTo(playX, 8);
      ctx.fill();
    }
  }

  public drawMinimap(): void {
    if (!this.minimapCanvas) return;
    const canvas = this.minimapCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#13141c';
    ctx.fillRect(0, 0, width, height);

    const tab = this.activeTab;
    if (!tab || tab.table.totalSamples === 0) return;

    const totalSamples = tab.table.totalSamples;
    const sppMinimap = totalSamples / width;
    const midY = height / 2;

    ctx.strokeStyle = 'rgba(122, 162, 247, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();

    const level = tab.levels ? tab.levels[tab.levels.length - 1] : null;
    if (level && level.channels[0]) {
      const { min, max } = level.channels[0];
      const bucketSize = level.samplesPerBucket;

      for (let x = 0; x < width; x++) {
        const sIdx = Math.floor(x * sppMinimap);
        const bIdx = Math.floor(sIdx / bucketSize);
        if (bIdx < min.length) {
          const yMin = midY - min[bIdx] * (height / 2);
          const yMax = midY - max[bIdx] * (height / 2);
          ctx.moveTo(x, yMin);
          ctx.lineTo(x, yMax + 0.5);
        }
      }
      ctx.stroke();
    }

    // Draggable viewport window
    const viewStartSample = tab.scrollSampleOffset;
    const viewWidthSamples = (this.waveformCanvas?.width || 1000) * tab.zoomSamplesPerPixel;
    const vx = Math.max(0, (viewStartSample / totalSamples) * width);
    const vw = Math.min(width - vx, (viewWidthSamples / totalSamples) * width);

    ctx.fillStyle = 'rgba(187, 154, 247, 0.15)';
    ctx.fillRect(vx, 0, vw, height);
    ctx.strokeStyle = '#bb9af7';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(vx, 0, vw, height);
  }

  public drawRuler(): void {
    if (!this.rulerCanvas) return;
    const canvas = this.rulerCanvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;
    ctx.clearRect(0, 0, width, height);

    ctx.fillStyle = '#16161e';
    ctx.fillRect(0, 0, width, height);

    const tab = this.activeTab;
    if (!tab || tab.table.totalSamples === 0) return;

    const spp = tab.zoomSamplesPerPixel;
    const startSample = tab.scrollSampleOffset;
    const sampleRate = tab.table.sampleRate;

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.2)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.5)';
    ctx.font = '10px monospace';
    ctx.textAlign = 'left';

    const tickIntervalSamples = Math.max(spp * 60, sampleRate / 10);
    const firstTick = Math.ceil(startSample / tickIntervalSamples) * tickIntervalSamples;

    for (let s = firstTick; s <= startSample + width * spp; s += tickIntervalSamples) {
      const x = (s - startSample) / spp;
      ctx.beginPath();
      ctx.moveTo(x, height - 8);
      ctx.lineTo(x, height);
      ctx.stroke();

      const timeSec = s / sampleRate;
      const mm = Math.floor(timeSec / 60);
      const ss = (timeSec % 60).toFixed(2).padStart(5, '0');
      ctx.fillText(`${mm}:${ss}`, x + 4, height - 6);
    }
  }

  // --- DOM Setup & Event Listeners ---

  private setupDomBindings(): void {
    this.waveformCanvas = document.getElementById('cs-editor-waveform-canvas') as HTMLCanvasElement | null;
    this.minimapCanvas = document.getElementById('cs-editor-minimap-canvas') as HTMLCanvasElement | null;
    this.rulerCanvas = document.getElementById('cs-editor-ruler-canvas') as HTMLCanvasElement | null;

    // Transport buttons
    const btnPlay = document.getElementById('btn-editor-play');
    const btnStop = document.getElementById('btn-editor-stop');
    const btnPlaySel = document.getElementById('btn-editor-play-sel');
    const btnZoomIn = document.getElementById('btn-editor-zoom-in');
    const btnZoomOut = document.getElementById('btn-editor-zoom-out');
    const btnZoomFit = document.getElementById('btn-editor-zoom-fit');

    // Action buttons
    const btnOpen = document.getElementById('btn-editor-open-file');
    const fileInput = document.getElementById('cs-editor-file-input') as HTMLInputElement | null;
    const btnExport = document.getElementById('btn-editor-export-wav');

    const btnCut = document.getElementById('btn-editor-cut');
    const btnCopy = document.getElementById('btn-editor-copy');
    const btnPaste = document.getElementById('btn-editor-paste');
    const btnPasteNew = document.getElementById('btn-editor-paste-new');
    const btnDel = document.getElementById('btn-editor-delete');
    const btnTrim = document.getElementById('btn-editor-trim');
    const btnSilence = document.getElementById('btn-editor-silence');
    const btnUndo = document.getElementById('btn-editor-undo');
    const btnRedo = document.getElementById('btn-editor-redo');

    const btnMix = document.getElementById('btn-editor-mix');
    const btnGain = document.getElementById('btn-editor-gain');
    const btnNorm = document.getElementById('btn-editor-normalize');
    const btnFadeIn = document.getElementById('btn-editor-fade-in');
    const btnFadeOut = document.getElementById('btn-editor-fade-out');
    const btnRev = document.getElementById('btn-editor-reverse');
    const btnInv = document.getElementById('btn-editor-invert');
    const btnTelephony = document.getElementById('btn-editor-telephony');

    const btnSendConv = document.getElementById('btn-editor-send-converter');
    const btnSendDnsmos = document.getElementById('btn-editor-send-dnsmos');
    const btnSendSnr = document.getElementById('btn-editor-send-snr');
    const btnShortcuts = document.getElementById('btn-editor-shortcuts');

    if (btnPlay) btnPlay.addEventListener('click', () => {
      if (this.isPlaying) this.pause();
      else this.play(false);
    });
    if (btnStop) btnStop.addEventListener('click', () => this.stop());
    if (btnPlaySel) btnPlaySel.addEventListener('click', () => this.play(true));

    if (btnZoomIn) btnZoomIn.addEventListener('click', () => this.zoomIn());
    if (btnZoomOut) btnZoomOut.addEventListener('click', () => this.zoomOut());
    if (btnZoomFit) btnZoomFit.addEventListener('click', () => this.zoomFitAll());

    if (btnOpen && fileInput) {
      btnOpen.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', async () => {
        if (fileInput.files && fileInput.files.length > 0) {
          for (let i = 0; i < fileInput.files.length; i++) {
            await this.openAudioFile(fileInput.files[i]);
          }
          fileInput.value = '';
        }
      });
    }

    if (btnExport) btnExport.addEventListener('click', () => this.handleExportWav());

    if (btnCut) btnCut.addEventListener('click', () => this.cut());
    if (btnCopy) btnCopy.addEventListener('click', () => this.copy());
    if (btnPaste) btnPaste.addEventListener('click', () => this.paste());
    if (btnPasteNew) btnPasteNew.addEventListener('click', () => this.pasteNew());
    if (btnDel) btnDel.addEventListener('click', () => this.deleteSelection());
    if (btnTrim) btnTrim.addEventListener('click', () => this.trimSelection());
    if (btnSilence) btnSilence.addEventListener('click', () => this.silenceSelection());
    if (btnUndo) btnUndo.addEventListener('click', () => this.undo());
    if (btnRedo) btnRedo.addEventListener('click', () => this.redo());

    if (btnFadeIn) btnFadeIn.addEventListener('click', () => this.applyFade('in'));
    if (btnFadeOut) btnFadeOut.addEventListener('click', () => this.applyFade('out'));
    if (btnRev) btnRev.addEventListener('click', () => this.reverse());
    if (btnInv) btnInv.addEventListener('click', () => this.invertPolarity());

    if (btnMix) btnMix.addEventListener('click', () => this.openMixModal());
    if (btnGain) btnGain.addEventListener('click', () => this.openGainModal());
    if (btnNorm) btnNorm.addEventListener('click', () => this.openNormModal());
    if (btnTelephony) btnTelephony.addEventListener('click', () => this.openTelephonyModal());

    if (btnSendConv) btnSendConv.addEventListener('click', () => this.sendToCodecConverter());
    if (btnSendDnsmos) btnSendDnsmos.addEventListener('click', () => this.sendToDnsmos());
    if (btnSendSnr) btnSendSnr.addEventListener('click', () => this.sendToSnr());
    if (btnShortcuts) btnShortcuts.addEventListener('click', () => this.openShortcutsModal());
  }

  private setupCanvasListeners(): void {
    if (!this.waveformCanvas) return;
    const canvas = this.waveformCanvas;

    canvas.addEventListener('mousedown', (e) => {
      const tab = this.activeTab;
      if (!tab) return;
      const rect = canvas.getBoundingClientRect();
      const clickX = e.clientX - rect.left;
      const sample = Math.round(tab.scrollSampleOffset + clickX * tab.zoomSamplesPerPixel);

      this.isSelecting = true;
      this.selectionAnchorSample = Math.max(0, Math.min(sample, tab.table.totalSamples));
      tab.selectionStartSample = this.selectionAnchorSample;
      tab.selectionEndSample = this.selectionAnchorSample;
      this.playheadSample = this.selectionAnchorSample;

      this.drawWaveform();
      this.updateStatusBar();
      this.updateTimeDisplay();
    });

    window.addEventListener('mousemove', (e) => {
      if (!this.isSelecting || !this.waveformCanvas) return;
      const tab = this.activeTab;
      if (!tab) return;

      const rect = this.waveformCanvas.getBoundingClientRect();
      const curX = e.clientX - rect.left;
      const curSample = Math.round(tab.scrollSampleOffset + curX * tab.zoomSamplesPerPixel);
      const clamped = Math.max(0, Math.min(curSample, tab.table.totalSamples));

      tab.selectionStartSample = Math.min(this.selectionAnchorSample, clamped);
      tab.selectionEndSample = Math.max(this.selectionAnchorSample, clamped);

      this.drawWaveform();
      this.updateStatusBar();
    });

    window.addEventListener('mouseup', () => {
      if (this.isSelecting) {
        this.isSelecting = false;
      }
    });

    // Mouse wheel zoom & pan
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const tab = this.activeTab;
      if (!tab) return;

      if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
        if (e.deltaY < 0) this.zoomIn();
        else this.zoomOut();
      } else {
        const panSamples = Math.round(e.deltaX * tab.zoomSamplesPerPixel);
        tab.scrollSampleOffset = Math.max(0, Math.min(tab.scrollSampleOffset + panSamples, tab.table.totalSamples - 100));
        this.renderAll();
      }
    }, { passive: false });
  }

  private setupKeyboardShortcuts(): void {
    window.addEventListener('keydown', (e) => {
      const tab = this.activeTab;
      if (!tab) return;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;

      if (e.code === 'Space') {
        e.preventDefault();
        if (this.isPlaying) this.pause();
        else this.play(e.shiftKey);
      } else if (e.code === 'KeyX' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.cut();
      } else if (e.code === 'KeyC' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.copy();
      } else if (e.code === 'KeyV' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) this.pasteNew();
        else this.paste();
      } else if (e.code === 'Delete' || e.code === 'Backspace') {
        e.preventDefault();
        this.deleteSelection();
      } else if (e.code === 'KeyA' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        tab.selectionStartSample = 0;
        tab.selectionEndSample = tab.table.totalSamples;
        this.drawWaveform();
        this.updateStatusBar();
      } else if (e.code === 'KeyZ' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (e.code === 'KeyY' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.redo();
      } else if (e.code === 'KeyS' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.handleExportWav();
      } else if (e.key === '+' || e.key === '=') {
        this.zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        this.zoomOut();
      } else if (e.key === 'Home') {
        this.playheadSample = 0;
        tab.scrollSampleOffset = 0;
        this.renderAll();
      } else if (e.key === 'End') {
        this.playheadSample = tab.table.totalSamples;
        this.renderAll();
      } else if (e.key === '?' || e.key === 'F1') {
        e.preventDefault();
        this.openShortcutsModal();
      }
    });
  }

  // --- Modals Setup & Management ---

  private setupModals(): void {
    // 1. Mix Modal
    const modalMix = document.getElementById('editor-mix-modal');
    const btnCloseMix = document.getElementById('btn-close-editor-mix-modal');
    const btnCancelMix = document.getElementById('btn-editor-mix-cancel');
    const btnApplyMix = document.getElementById('btn-editor-mix-apply');
    const rngGainA = document.getElementById('editor-mix-rng-gain-a') as HTMLInputElement | null;
    const rngGainB = document.getElementById('editor-mix-rng-gain-b') as HTMLInputElement | null;
    const lblGainA = document.getElementById('editor-mix-lbl-gain-a');
    const lblGainB = document.getElementById('editor-mix-lbl-gain-b');

    if (rngGainA && lblGainA) rngGainA.addEventListener('input', () => { lblGainA.textContent = `${rngGainA.value}%`; });
    if (rngGainB && lblGainB) rngGainB.addEventListener('input', () => { lblGainB.textContent = `${rngGainB.value}%`; });

    const closeMix = () => { if (modalMix) modalMix.style.display = 'none'; };
    if (btnCloseMix) btnCloseMix.addEventListener('click', closeMix);
    if (btnCancelMix) btnCancelMix.addEventListener('click', closeMix);

    if (btnApplyMix) {
      btnApplyMix.addEventListener('click', () => {
        const selSource = (document.getElementById('editor-mix-source-select') as HTMLSelectElement)?.value || 'clipboard';
        const selMode = (document.getElementById('editor-mix-mode-select') as HTMLSelectElement)?.value as MixMode || 'mix';
        const selClipStrat = (document.getElementById('editor-mix-clipping-select') as HTMLSelectElement)?.value as any || 'auto-reduce';
        const chkExtend = (document.getElementById('editor-mix-chk-extend') as HTMLInputElement)?.checked ?? true;

        const gainA = rngGainA ? parseFloat(rngGainA.value) / 100 : 1.0;
        const gainB = rngGainB ? parseFloat(rngGainB.value) / 100 : 1.0;

        this.applyMix({
          mode: selMode,
          offsetSample: this.playheadSample,
          gainA,
          gainB,
          clippingStrategy: selClipStrat,
          extendLength: chkExtend
        }, selSource);

        closeMix();
      });
    }

    // 2. Gain Modal
    const modalGain = document.getElementById('editor-gain-modal');
    const btnCloseGain = document.getElementById('btn-close-editor-gain-modal');
    const btnCancelGain = document.getElementById('btn-editor-gain-cancel');
    const btnApplyGain = document.getElementById('btn-editor-gain-apply');
    const sliderGain = document.getElementById('editor-gain-slider') as HTMLInputElement | null;
    const lblGainVal = document.getElementById('editor-gain-val-label');

    const closeGain = () => { if (modalGain) modalGain.style.display = 'none'; };
    if (btnCloseGain) btnCloseGain.addEventListener('click', closeGain);
    if (btnCancelGain) btnCancelGain.addEventListener('click', closeGain);

    if (sliderGain && lblGainVal) {
      sliderGain.addEventListener('input', () => {
        const db = parseFloat(sliderGain.value);
        const factor = Math.pow(10, db / 20) * 100;
        lblGainVal.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB (${Math.round(factor)}%)`;
      });
    }

    const setGainPreset = (db: number) => {
      if (sliderGain && lblGainVal) {
        sliderGain.value = String(db);
        const factor = Math.pow(10, db / 20) * 100;
        lblGainVal.textContent = `${db >= 0 ? '+' : ''}${db.toFixed(1)} dB (${Math.round(factor)}%)`;
      }
    };

    document.getElementById('btn-gain-preset-m6')?.addEventListener('click', () => setGainPreset(-6));
    document.getElementById('btn-gain-preset-m3')?.addEventListener('click', () => setGainPreset(-3));
    document.getElementById('btn-gain-preset-zero')?.addEventListener('click', () => setGainPreset(0));
    document.getElementById('btn-gain-preset-p3')?.addEventListener('click', () => setGainPreset(3));
    document.getElementById('btn-gain-preset-p6')?.addEventListener('click', () => setGainPreset(6));

    if (btnApplyGain && sliderGain) {
      btnApplyGain.addEventListener('click', () => {
        const db = parseFloat(sliderGain.value);
        this.applyGain(db);
        closeGain();
      });
    }

    // 3. Normalize Modal
    const modalNorm = document.getElementById('editor-norm-modal');
    const btnCloseNorm = document.getElementById('btn-close-editor-norm-modal');
    const btnCancelNorm = document.getElementById('btn-editor-norm-cancel');
    const btnApplyNorm = document.getElementById('btn-editor-norm-apply');

    const closeNorm = () => { if (modalNorm) modalNorm.style.display = 'none'; };
    if (btnCloseNorm) btnCloseNorm.addEventListener('click', closeNorm);
    if (btnCancelNorm) btnCancelNorm.addEventListener('click', closeNorm);

    if (btnApplyNorm) {
      btnApplyNorm.addEventListener('click', () => {
        const normType = (document.querySelector('input[name="editor-norm-type"]:checked') as HTMLInputElement)?.value || 'peak';
        if (normType === 'peak') {
          const target = parseFloat((document.getElementById('editor-norm-peak-target') as HTMLInputElement)?.value || '-1.0');
          this.applyNormalize('peak', target);
        } else {
          const target = parseFloat((document.getElementById('editor-norm-loudness-target') as HTMLInputElement)?.value || '-26.0');
          this.applyNormalize('loudness', target);
        }
        closeNorm();
      });
    }

    // 4. Telephony Signal Generator Modal
    const modalTelephony = document.getElementById('editor-telephony-modal');
    const btnCloseTelephony = document.getElementById('btn-close-editor-telephony-modal');
    const btnCancelTelephony = document.getElementById('btn-editor-gen-cancel');
    const btnApplyTelephony = document.getElementById('btn-editor-gen-apply');
    const selGenType = document.getElementById('editor-gen-type-select') as HTMLSelectElement | null;

    const closeTelephony = () => { if (modalTelephony) modalTelephony.style.display = 'none'; };
    if (btnCloseTelephony) btnCloseTelephony.addEventListener('click', closeTelephony);
    if (btnCancelTelephony) btnCancelTelephony.addEventListener('click', closeTelephony);

    if (selGenType) {
      selGenType.addEventListener('change', () => {
        const val = selGenType.value;
        const optSine = document.getElementById('editor-gen-options-sine');
        const optDtmf = document.getElementById('editor-gen-options-dtmf');
        const optCp = document.getElementById('editor-gen-options-callprogress');
        const optNoise = document.getElementById('editor-gen-options-noise');

        if (optSine) optSine.style.display = val === 'sine' ? 'flex' : 'none';
        if (optDtmf) optDtmf.style.display = val === 'dtmf' ? 'flex' : 'none';
        if (optCp) optCp.style.display = val === 'callprogress' ? 'flex' : 'none';
        if (optNoise) optNoise.style.display = val === 'noise-snr' ? 'flex' : 'none';
      });
    }

    if (btnApplyTelephony && selGenType) {
      btnApplyTelephony.addEventListener('click', () => {
        const type = selGenType.value;
        const dest = (document.getElementById('editor-gen-dest-select') as HTMLSelectElement)?.value as any || 'new-tab';

        const params: any = {};
        if (type === 'sine') {
          params.freq = parseFloat((document.getElementById('editor-gen-sine-freq') as HTMLInputElement)?.value || '1000');
          params.dur = parseFloat((document.getElementById('editor-gen-sine-dur') as HTMLInputElement)?.value || '1.0');
        } else if (type === 'dtmf') {
          params.digits = (document.getElementById('editor-gen-dtmf-digits') as HTMLInputElement)?.value || '123#';
          params.toneDur = parseFloat((document.getElementById('editor-gen-dtmf-tone-dur') as HTMLInputElement)?.value || '100');
          params.silenceDur = parseFloat((document.getElementById('editor-gen-dtmf-silence-dur') as HTMLInputElement)?.value || '50');
        } else if (type === 'callprogress') {
          params.cpType = (document.getElementById('editor-gen-cp-type') as HTMLSelectElement)?.value || 'dial';
          params.dur = parseFloat((document.getElementById('editor-gen-cp-dur') as HTMLInputElement)?.value || '4.0');
        } else if (type === 'noise-snr') {
          params.color = (document.getElementById('editor-gen-noise-color') as HTMLSelectElement)?.value || 'white';
          params.snr = parseFloat((document.getElementById('editor-gen-noise-snr') as HTMLInputElement)?.value || '15.0');
        }

        this.generateTelephony(type, params, dest);
        closeTelephony();
      });
    }

    // 5. Shortcuts Modal
    const modalShortcuts = document.getElementById('editor-shortcuts-modal');
    const btnCloseShortcuts1 = document.getElementById('btn-close-editor-shortcuts-modal');
    const btnCloseShortcuts2 = document.getElementById('btn-close-editor-shortcuts-modal-bottom');

    const closeShortcuts = () => { if (modalShortcuts) modalShortcuts.style.display = 'none'; };
    if (btnCloseShortcuts1) btnCloseShortcuts1.addEventListener('click', closeShortcuts);
    if (btnCloseShortcuts2) btnCloseShortcuts2.addEventListener('click', closeShortcuts);
  }

  public openMixModal(): void {
    const modal = document.getElementById('editor-mix-modal');
    if (!modal) return;

    // Populate source select with open tabs
    const sel = document.getElementById('editor-mix-source-select') as HTMLSelectElement | null;
    if (sel) {
      sel.innerHTML = '<option value="clipboard">📋 Clipboard Content</option>';
      this.tabs.forEach((t, i) => {
        if (i !== this.activeTabIndex) {
          const opt = document.createElement('option');
          opt.value = t.id;
          opt.textContent = `📄 ${t.name} (${t.table.durationSec.toFixed(2)}s)`;
          sel.appendChild(opt);
        }
      });
    }

    modal.style.display = 'flex';
  }

  public openGainModal(): void {
    const modal = document.getElementById('editor-gain-modal');
    if (modal) modal.style.display = 'flex';
  }

  public openNormModal(): void {
    const modal = document.getElementById('editor-norm-modal');
    if (modal) modal.style.display = 'flex';
  }

  public openTelephonyModal(): void {
    const modal = document.getElementById('editor-telephony-modal');
    if (modal) modal.style.display = 'flex';
  }

  public openShortcutsModal(): void {
    const modal = document.getElementById('editor-shortcuts-modal');
    if (modal) modal.style.display = 'flex';
  }

  private handleExportWav(): void {
    const tab = this.activeTab;
    if (!tab) return;

    const hasSelection = tab.selectionEndSample > tab.selectionStartSample;
    const opts: WavExportOptions = {
      bitDepth: 16,
      selection: hasSelection ? {
        startSample: tab.selectionStartSample,
        lengthSamples: tab.selectionEndSample - tab.selectionStartSample
      } : undefined
    };

    const wavBytes = AudioEditorLoader.exportWav(tab.table, this.pool, opts);
    const blob = new Blob([wavBytes.buffer as ArrayBuffer], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${tab.name.replace(/\.[^/.]+$/, '')}_edited.wav`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- UI Update Helpers ---

  private renderTabsBar(): void {
    const container = document.getElementById('cs-editor-tabs-container');
    if (!container) return;
    container.innerHTML = '';

    this.tabs.forEach((tab, idx) => {
      const pill = document.createElement('div');
      pill.className = `btn btn-sm ${idx === this.activeTabIndex ? 'btn-primary' : 'btn-ctrl-sec'}`;
      pill.style.cssText = 'display: flex; align-items: center; gap: 6px; padding: 4px 10px; font-size: 12px; cursor: pointer;';
      pill.innerHTML = `<span>📄 ${tab.name}</span><span style="opacity: 0.6; font-size: 11px;">✕</span>`;

      pill.addEventListener('click', (e) => {
        if ((e.target as HTMLElement).textContent === '✕') {
          e.stopPropagation();
          this.closeTab(idx);
        } else {
          this.selectTab(idx);
        }
      });
      container.appendChild(pill);
    });
  }

  private updateStatusBar(): void {
    const tab = this.activeTab;
    const elFormat = document.getElementById('cs-editor-status-format');
    const elSel = document.getElementById('cs-editor-status-selection');
    const elLevels = document.getElementById('cs-editor-status-levels');
    const elClip = document.getElementById('cs-editor-status-clipping');

    if (!tab) {
      if (elFormat) elFormat.textContent = 'No clip open';
      if (elSel) elSel.textContent = 'Sel: none';
      if (elLevels) elLevels.textContent = 'Levels: --';
      if (elClip) elClip.textContent = '[ Clipping: OK ]';
      return;
    }

    if (elFormat) {
      const chLabel = tab.table.numChannels === 1 ? 'Mono' : tab.table.numChannels === 2 ? 'Stereo' : `${tab.table.numChannels} ch`;
      elFormat.textContent = `${tab.table.sampleRate.toLocaleString()} Hz • ${tab.table.bitDepth}-bit • ${chLabel} • ${tab.table.durationSec.toFixed(2)}s`;
    }

    if (elSel) {
      if (tab.selectionEndSample > tab.selectionStartSample) {
        const len = tab.selectionEndSample - tab.selectionStartSample;
        const dur = (len / tab.table.sampleRate).toFixed(3);
        elSel.textContent = `Sel: ${tab.selectionStartSample.toLocaleString()} to ${tab.selectionEndSample.toLocaleString()} (${dur}s, ${len.toLocaleString()} smp)`;
      } else {
        elSel.textContent = 'Sel: none';
      }
    }

    if (elLevels && tab.stats && tab.stats.length > 0) {
      const statsStr = tab.stats.map((s, i) => `${i === 0 ? 'L' : 'R'}: ${s.peakDbfs} dBFS`).join(' | ');
      elLevels.textContent = statsStr;
    }

    if (elClip && tab.stats) {
      const isClipped = tab.stats.some(s => s.isClipped);
      elClip.textContent = isClipped ? '[ ⚠️ CLIPPING DETECTED ]' : '[ Clipping: OK ]';
      elClip.style.color = isClipped ? '#f7768e' : '#9ece6a';
    }
  }

  private updateTimeDisplay(): void {
    const elTime = document.getElementById('cs-editor-transport-time');
    if (!elTime) return;
    const tab = this.activeTab;
    if (!tab) {
      elTime.textContent = '00:00:00.000 / 00:00:00.000';
      return;
    }
    const curSec = this.playheadSample / tab.table.sampleRate;
    const totalSec = tab.table.durationSec;
    const format = (t: number) => {
      const mm = Math.floor(t / 60);
      const ss = Math.floor(t % 60);
      const ms = Math.floor((t % 1) * 1000);
      return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    };
    elTime.textContent = `${format(curSec)} / ${format(totalSec)}`;
  }

  private updateMemoryDisplay(): void {
    const elMem = document.getElementById('cs-editor-memory-usage');
    if (!elMem) return;
    const bytes = this.pool.getTotalMemoryBytes();
    const mb = (bytes / (1024 * 1024)).toFixed(1);
    elMem.textContent = `Mem: ${mb} MB / 500 MB`;
  }
}
