/**
 * SrtpUiController.ts
 * Manages the SRTP/DTLS Keys UI modal, manual key entry, log file parsing,
 * active in-memory keys table with redaction, emergency kill switch,
 * and selective stream re-decryption.
 * Strictly adheres to volatile-memory security policy (Zero persistence).
 */

import { SrtpKeyRegistry } from './SrtpKeyRegistry.ts';
import { SdesParser } from './SdesParser.ts';
import { LogKeyParser, type ExtractedLogKey } from './LogKeyParser.ts';
import { StreamDecryptor } from './StreamDecryptor.ts';
import type { SdesCrypto, SrtpCryptoSuite } from './SrtpTypes.ts';
import type { PipelineResult } from '../CapturePipeline.ts';
import { LinkType } from '../pcap/PacketTypes.ts';

export interface SrtpUiCallbacks {
  onStreamsUpdated: () => void;
  onRefreshLadder: () => void;
}

export class SrtpUiController {
  private keyRegistry: SrtpKeyRegistry;
  private pipelineResult: PipelineResult | null = null;
  private currentPcapData: File | Blob | Uint8Array | null = null;
  private callbacks: SrtpUiCallbacks;
  private logWorker: Worker | null = null;
  private workerReqId: number = 0;
  private pendingWorkerCallbacks = new Map<number, (keys: ExtractedLogKey[]) => void>();

  // Redaction state: set of record indices currently revealed
  private revealedKeyIndices = new Set<number>();

  constructor(keyRegistry: SrtpKeyRegistry, callbacks: SrtpUiCallbacks) {
    this.keyRegistry = keyRegistry;
    this.callbacks = callbacks;
    this.initWorker();
  }

  private initWorker(): void {
    if (typeof Worker !== 'undefined') {
      try {
        this.logWorker = new Worker(
          new URL('../workers/log-parser.worker.ts', import.meta.url),
          { type: 'module' }
        );
        this.logWorker.onmessage = (e) => {
          const { id, keys } = e.data;
          const cb = this.pendingWorkerCallbacks.get(id);
          if (cb) {
            this.pendingWorkerCallbacks.delete(id);
            cb(keys || []);
          }
        };
      } catch {
        // Fallback to main-thread LogKeyParser if Worker is unavailable
        this.logWorker = null;
      }
    }
  }

  public setCaptureState(
    result: PipelineResult | null,
    pcapData: File | Blob | Uint8Array | null
  ): void {
    this.pipelineResult = result;
    this.currentPcapData = pcapData;
    if (result?.keyRegistry) {
      this.keyRegistry = result.keyRegistry;
    }
    this.updateKeyPill();
  }

  /**
   * Binds modal controls, event listeners, and file drag-and-drop.
   */
  public bindDomEvents(): void {
    const btnOpenKeys = document.getElementById('btn-open-keys');
    if (btnOpenKeys) {
      btnOpenKeys.addEventListener('click', () => {
        const count = this.keyRegistry.getKeyRecords().length;
        this.openModal(count > 0 ? 'active' : 'manual');
      });
    }

    const btnCloseModal = document.getElementById('btn-close-srtp-modal');
    if (btnCloseModal) btnCloseModal.addEventListener('click', () => this.closeModal());

    const btnDoneModal = document.getElementById('btn-done-srtp-modal');
    if (btnDoneModal) btnDoneModal.addEventListener('click', () => this.closeModal());

    const btnTabManual = document.getElementById('btn-srtp-tab-manual');
    if (btnTabManual) btnTabManual.addEventListener('click', () => this.switchTab('manual'));

    const btnTabImport = document.getElementById('btn-srtp-tab-import');
    if (btnTabImport) btnTabImport.addEventListener('click', () => this.switchTab('import'));

    const btnTabActive = document.getElementById('btn-srtp-tab-active');
    if (btnTabActive) btnTabActive.addEventListener('click', () => this.switchTab('active'));

    // Manual Key Add
    const btnAddManual = document.getElementById('btn-add-manual-key');
    const inputKey = document.getElementById('srtp-input-key') as HTMLTextAreaElement | null;
    const suiteSelect = document.getElementById('srtp-suite-select') as HTMLSelectElement | null;
    const targetSelect = document.getElementById('srtp-target-select') as HTMLSelectElement | null;
    const manualMsg = document.getElementById('srtp-manual-msg');

    if (btnAddManual && inputKey && suiteSelect && targetSelect) {
      btnAddManual.addEventListener('click', async () => {
        const res = await this.addManualKey(
          inputKey.value,
          suiteSelect.value as SrtpCryptoSuite,
          targetSelect.value
        );
        if (manualMsg) {
          manualMsg.style.display = 'block';
          manualMsg.style.background = res.success ? 'rgba(158, 206, 106, 0.2)' : 'rgba(247, 118, 142, 0.2)';
          manualMsg.style.border = `1px solid ${res.success ? '#9ece6a' : '#f7768e'}`;
          manualMsg.style.color = res.success ? '#9ece6a' : '#f7768e';
          manualMsg.textContent = res.message;
        }
        if (res.success) {
          inputKey.value = '';
        }
      });
    }

    // Log File Selection
    const btnSelectLog = document.getElementById('btn-select-log-file');
    const logFileInput = document.getElementById('srtp-log-file-input') as HTMLInputElement | null;
    const logTextarea = document.getElementById('srtp-log-textarea') as HTMLTextAreaElement | null;

    if (btnSelectLog && logFileInput && logTextarea) {
      btnSelectLog.addEventListener('click', () => logFileInput.click());
      logFileInput.addEventListener('change', async () => {
        const file = logFileInput.files?.[0];
        if (file) {
          const text = await file.text();
          logTextarea.value = text;
        }
      });
    }

    // Scan Logs
    const btnScan = document.getElementById('btn-scan-logs');
    const scannedArea = document.getElementById('srtp-scanned-keys-area');
    const scannedCount = document.getElementById('srtp-scanned-count');
    const scannedTbody = document.getElementById('srtp-scanned-tbody');
    const chkSelectAll = document.getElementById('chk-select-all-scanned') as HTMLInputElement | null;
    const btnImportScanned = document.getElementById('btn-import-scanned-keys');
    let lastScannedKeys: ExtractedLogKey[] = [];

    if (btnScan && logTextarea && scannedArea && scannedCount && scannedTbody) {
      btnScan.addEventListener('click', async () => {
        const text = logTextarea.value;
        if (!text.trim()) return;

        btnScan.textContent = 'Scanning...';
        const keys = await this.parseLogContent(text);
        lastScannedKeys = keys;
        btnScan.textContent = '🔍 Scan for Keys';

        scannedArea.style.display = 'flex';
        scannedCount.textContent = `Found ${keys.length} candidate key${keys.length === 1 ? '' : 's'}:`;
        scannedTbody.innerHTML = '';

        if (keys.length === 0) {
          scannedTbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-dim); padding: 12px;">No recognizable encryption keys found.</td></tr>`;
          return;
        }

        keys.forEach((k, kIdx) => {
          const tr = document.createElement('tr');
          const preview = k.format === 'nss-sslkeylog'
            ? `ClientRandom: ${k.clientRandomHex?.substring(0, 16)}...`
            : k.rawKeyBase64
            ? `${k.rawKeyBase64.substring(0, 8)}...`
            : 'Hex key';

          tr.innerHTML = `
            <td><input type="checkbox" class="chk-scanned-key" data-idx="${kIdx}" checked></td>
            <td><span class="badge-tag">${k.contextHint || k.source}</span></td>
            <td style="color: #2ac3de;">${k.cryptoSuite}</td>
            <td style="font-family: monospace;">${preview}</td>
          `;
          scannedTbody.appendChild(tr);
        });
      });
    }

    if (chkSelectAll && scannedTbody) {
      chkSelectAll.addEventListener('change', () => {
        const checkboxes = scannedTbody.querySelectorAll('.chk-scanned-key') as NodeListOf<HTMLInputElement>;
        checkboxes.forEach(c => c.checked = chkSelectAll.checked);
      });
    }

    if (btnImportScanned && scannedTbody) {
      btnImportScanned.addEventListener('click', async () => {
        const checkboxes = scannedTbody.querySelectorAll('.chk-scanned-key:checked') as NodeListOf<HTMLInputElement>;
        const toImport: ExtractedLogKey[] = [];
        checkboxes.forEach(c => {
          const idx = parseInt(c.getAttribute('data-idx') || '0', 10);
          if (lastScannedKeys[idx]) {
            toImport.push(lastScannedKeys[idx]);
          }
        });

        if (toImport.length > 0) {
          const count = await this.importExtractedKeys(toImport);
          this.switchTab('active');
        }
      });
    }

    // Active Keys tab actions
    const btnClearKeys = document.getElementById('btn-clear-all-keys');
    if (btnClearKeys) {
      btnClearKeys.addEventListener('click', () => {
        if (confirm('Clear all encryption keys from browser memory?')) {
          this.clearAllKeys();
        }
      });
    }

    const chkKillSwitch = document.getElementById('chk-srtp-kill-switch') as HTMLInputElement | null;
    if (chkKillSwitch) {
      chkKillSwitch.addEventListener('change', () => {
        this.setKillSwitch(chkKillSwitch.checked);
      });
    }
  }

  public updateKeyPill(): void {
    const pill = document.getElementById('keys-count-pill');
    if (!pill) return;

    const records = this.keyRegistry.getKeyRecords();
    const count = records.length;
    const hasEncrypted = this.pipelineResult?.streams.some(s => s.isEncrypted);

    if (count > 0 || hasEncrypted) {
      pill.style.display = 'inline-block';
      pill.textContent = String(count);
      pill.style.background = count > 0 ? '#9ece6a' : '#f7768e';
      pill.style.color = '#1a1b26';
    } else {
      pill.style.display = 'none';
    }
  }

  public openModal(activeTab: 'manual' | 'import' | 'active' = 'manual'): void {
    const modal = document.getElementById('srtp-keys-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    this.switchTab(activeTab);
    this.populateTargetDropdown();
    this.renderActiveKeysTable();
  }

  public closeModal(): void {
    const modal = document.getElementById('srtp-keys-modal');
    if (modal) modal.style.display = 'none';
  }

  public switchTab(tabName: 'manual' | 'import' | 'active'): void {
    const tabs = ['manual', 'import', 'active'] as const;
    tabs.forEach(t => {
      const btn = document.getElementById(`btn-srtp-tab-${t}`);
      const pane = document.getElementById(`srtp-pane-${t}`);
      if (btn) btn.classList.toggle('active', t === tabName);
      if (pane) pane.style.display = t === tabName ? 'block' : 'none';
    });
    if (tabName === 'active') {
      this.renderActiveKeysTable();
    }
  }

  private populateTargetDropdown(): void {
    const select = document.getElementById('srtp-target-select') as HTMLSelectElement | null;
    if (!select) return;

    select.innerHTML = '';
    const defOpt = document.createElement('option');
    defOpt.value = 'all';
    defOpt.textContent = 'Auto (Match by SSRC or 5-tuple)';
    select.appendChild(defOpt);

    if (!this.pipelineResult) return;

    for (const stream of this.pipelineResult.streams) {
      const opt = document.createElement('option');
      opt.value = `ssrc:${stream.ssrc}`;
      const encBadge = stream.isEncrypted ? (stream.isDecrypted ? '🔒 [Decrypted]' : '🔒 [Encrypted]') : '[Plain]';
      opt.textContent = `${encBadge} SSRC 0x${stream.ssrc.toString(16).toUpperCase()} (${stream.srcIp}:${stream.srcPort} \u2192 ${stream.dstPort})`;
      select.appendChild(opt);
    }
  }

  /**
   * Adds a manual key entered by the user.
   */
  public async addManualKey(
    keyInput: string,
    suite: SrtpCryptoSuite,
    targetValue: string
  ): Promise<{ success: boolean; message: string }> {
    const clean = keyInput.trim();
    if (!clean) {
      return { success: false, message: 'Key input cannot be empty.' };
    }

    let parsedCrypto: SdesCrypto | null = null;

    if (clean.startsWith('a=crypto:') || clean.startsWith('crypto:')) {
      parsedCrypto = SdesParser.parseCryptoLine(clean.startsWith('a=') ? clean : `a=${clean}`);
    } else if (clean.length === 40 || clean.length === 44) {
      // 40/44 char Base64 master key + salt
      parsedCrypto = SdesParser.parseCryptoLine(`a=crypto:1 ${suite} inline:${clean}`);
    } else {
      // Try parsing separated hex strings
      const hexMatch = clean.replace(/[^0-9a-fA-F]/g, '');
      if (hexMatch.length === 60) {
        // 32 hex (16B key) + 28 hex (14B salt)
        const keyHex = hexMatch.substring(0, 32);
        const saltHex = hexMatch.substring(32, 60);
        const keyBytes = new Uint8Array(16);
        const saltBytes = new Uint8Array(14);
        for (let i = 0; i < 16; i++) keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
        for (let i = 0; i < 14; i++) saltBytes[i] = parseInt(saltHex.substring(i * 2, i * 2 + 2), 16);
        parsedCrypto = {
          tag: 1,
          cryptoSuite: suite,
          masterKey: keyBytes,
          masterSalt: saltBytes,
          unencryptedSrtp: false,
          unencryptedSrtcp: false,
          unauthenticatedSrtp: false,
          kdr: 0,
          rawInline: '',
        };
      }
    }

    if (!parsedCrypto) {
      return {
        success: false,
        message: 'Invalid key format. Provide a 40-character Base64 inline key, a=crypto: line, or 60-character Hex string (32 hex key + 28 hex salt).',
      };
    }

    // Register into KeyRegistry
    if (targetValue.startsWith('ssrc:')) {
      const ssrc = parseInt(targetValue.substring(5), 10);
      this.keyRegistry.registerSsrcKey(ssrc, parsedCrypto, 'manual');
    } else {
      // Match all streams or register broadly
      if (this.pipelineResult) {
        for (const s of this.pipelineResult.streams) {
          if (s.isEncrypted && !s.isDecrypted) {
            this.keyRegistry.registerSsrcKey(s.ssrc, parsedCrypto, 'manual');
          }
        }
      }
    }

    this.updateKeyPill();
    this.renderActiveKeysTable();

    // Trigger selective re-decryption
    await this.redecryptAffectedStreams();

    return { success: true, message: 'Key registered and affected streams re-decrypted.' };
  }

  /**
   * Scans log text or file content and returns extracted keys.
   */
  public async parseLogContent(text: string): Promise<ExtractedLogKey[]> {
    if (this.logWorker) {
      const reqId = ++this.workerReqId;
      return new Promise<ExtractedLogKey[]>((resolve) => {
        this.pendingWorkerCallbacks.set(reqId, resolve);
        this.logWorker!.postMessage({ id: reqId, text });
      });
    } else {
      return LogKeyParser.parseLogText(text);
    }
  }

  /**
   * Imports a set of extracted log keys.
   */
  public async importExtractedKeys(keys: ExtractedLogKey[]): Promise<number> {
    let imported = 0;
    for (const k of keys) {
      if (k.format === 'nss-sslkeylog' && k.clientRandomHex && k.masterSecretHex) {
        this.keyRegistry.registerNssKeyLog(k.clientRandomHex, k.masterSecretHex);
        imported++;
        continue;
      }

      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: k.cryptoSuite,
        masterKey: k.masterKey,
        masterSalt: k.masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: k.rawKeyBase64 || '',
      };

      if (k.ssrc !== undefined) {
        this.keyRegistry.registerSsrcKey(k.ssrc, crypto, 'log');
        imported++;
      } else if (k.endpoint) {
        const [ip, portStr] = k.endpoint.split(':');
        this.keyRegistry.registerEndpointKey(ip, parseInt(portStr, 10), crypto, 'log');
        imported++;
      } else {
        // Register key for any currently undecrypted encrypted stream
        if (this.pipelineResult) {
          for (const s of this.pipelineResult.streams) {
            if (s.isEncrypted && !s.isDecrypted) {
              this.keyRegistry.registerSsrcKey(s.ssrc, crypto, 'log');
              imported++;
            }
          }
        }
      }
    }

    this.updateKeyPill();
    this.renderActiveKeysTable();
    await this.redecryptAffectedStreams();
    return imported;
  }

  /**
   * Selectively re-decrypts affected streams without re-parsing entire capture.
   */
  public async redecryptAffectedStreams(): Promise<void> {
    if (!this.pipelineResult || !this.currentPcapData) return;

    let anyUpdated = false;

    for (const stream of this.pipelineResult.streams) {
      const srtpCtx = this.keyRegistry.getContextForPacket(
        stream.ssrc,
        stream.srcIp,
        stream.srcPort,
        stream.dstIp,
        stream.dstPort,
        stream.startTime
      );

      if (srtpCtx) {
        const success = await StreamDecryptor.redecryptStream({
          stream,
          source: this.currentPcapData,
          linkType: LinkType.ETHERNET,
          context: srtpCtx,
        });

        if (success) {
          anyUpdated = true;
        }
      }
    }

    if (anyUpdated) {
      this.callbacks.onStreamsUpdated();
      this.callbacks.onRefreshLadder();
    }
  }

  /**
   * Renders the Active Keys table in the modal with volatile memory warning and redaction.
   */
  public renderActiveKeysTable(): void {
    const tbody = document.getElementById('srtp-active-keys-tbody');
    const emptyMsg = document.getElementById('srtp-no-keys-msg');
    const killSwitchChk = document.getElementById('chk-srtp-kill-switch') as HTMLInputElement | null;

    if (killSwitchChk) {
      killSwitchChk.checked = SrtpKeyRegistry.isKillSwitchEnabled();
    }

    if (!tbody) return;
    tbody.innerHTML = '';

    const records = this.keyRegistry.getKeyRecords();
    if (records.length === 0) {
      if (emptyMsg) emptyMsg.style.display = 'block';
      return;
    }

    if (emptyMsg) emptyMsg.style.display = 'none';

    records.forEach((rec, idx) => {
      const tr = document.createElement('tr');
      const isRevealed = this.revealedKeyIndices.has(idx);

      const targetLabel = rec.ssrc !== undefined
        ? `SSRC 0x${rec.ssrc.toString(16).toUpperCase()}`
        : rec.srcEndpoint
        ? `Endpoint ${rec.srcEndpoint}`
        : 'Auto / Global';

      const rawB64 = rec.crypto.rawInline || (
        rec.crypto.masterKey.length === 16 && rec.crypto.masterSalt.length === 14
          ? SdesParser.base64Encode(new Uint8Array([...rec.crypto.masterKey, ...rec.crypto.masterSalt]))
          : '...'
      );

      const displayKey = isRevealed
        ? rawB64
        : rawB64.length > 8
        ? `${rawB64.substring(0, 4)}••••••••••••••••••••••••••••••••${rawB64.substring(rawB64.length - 4)}`
        : '••••••••••••••••';

      tr.innerHTML = `
        <td><span class="badge-tag" style="background: rgba(255,255,255,0.1);">${rec.source.toUpperCase()}</span></td>
        <td style="font-family: monospace;">${targetLabel}</td>
        <td><span style="font-size: 11px; color: #2ac3de;">${rec.crypto.cryptoSuite}</span></td>
        <td style="font-family: monospace; font-size: 11px; letter-spacing: 0.5px;">
          <span id="key-val-${idx}">${displayKey}</span>
          <button class="btn btn-sm" style="padding: 1px 6px; margin-left: 6px; font-size: 10px;" id="btn-toggle-reveal-${idx}" title="${isRevealed ? 'Mask key' : 'Reveal key'}">
            ${isRevealed ? '🙈' : '👁️'}
          </button>
        </td>
      `;

      tbody.appendChild(tr);

      const revealBtn = tr.querySelector(`#btn-toggle-reveal-${idx}`);
      if (revealBtn) {
        revealBtn.addEventListener('click', () => {
          if (this.revealedKeyIndices.has(idx)) {
            this.revealedKeyIndices.delete(idx);
          } else {
            this.revealedKeyIndices.add(idx);
          }
          this.renderActiveKeysTable();
        });
      }
    });
  }

  /**
   * Immediately clears all keys from memory.
   */
  public clearAllKeys(): void {
    this.keyRegistry.clear();
    this.revealedKeyIndices.clear();
    this.updateKeyPill();
    this.renderActiveKeysTable();

    // Reset decryption state on streams
    if (this.pipelineResult) {
      for (const s of this.pipelineResult.streams) {
        if (s.isEncrypted) {
          s.isDecrypted = false;
        }
      }
      this.callbacks.onStreamsUpdated();
      this.callbacks.onRefreshLadder();
    }
  }

  /**
   * Sets emergency kill switch state.
   */
  public setKillSwitch(disabled: boolean): void {
    SrtpKeyRegistry.setKillSwitch(disabled);
    if (disabled) {
      this.clearAllKeys();
    } else {
      this.redecryptAffectedStreams();
    }
  }
}
