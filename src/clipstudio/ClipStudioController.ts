/**
 * ClipStudioController.ts
 * Controller for the Clip Studio tab:
 * - Panel 1: Codec Raw-Clip Converter (Universal input loader, Preprocessing, Multi-format encoding, A/B Player)
 * - Panel 2: Text-to-Speech Studio (Multilingual Neural Voice Synthesis)
 */

import { CodecProfileRegistry, type CodecProfile, type AudioBandwidth } from '../codec/CodecProfileRegistry.ts';
import { AudioPreprocessor } from '../codec/AudioPreprocessor.ts';
import { G711Encoder } from '../encoders/G711Encoder.ts';
import { G711Decoder } from '../decoders/G711Decoder.ts';
import { G722Encoder } from '../encoders/G722Encoder.ts';
import { G722Decoder } from '../decoders/G722Decoder.ts';
import { G726Encoder } from '../encoders/G726Encoder.ts';
import { G726Decoder } from '../decoders/G726Decoder.ts';
import { G729Encoder } from '../encoders/G729Encoder.ts';
import { G729Decoder } from '../decoders/G729Decoder.ts';
import { RawClipPackager, type PackagedClip } from '../encoders/RawClipPackager.ts';
import { AmrNbEncoder } from '../encoders/AmrNbEncoder.ts';
import { AmrWbEncoder } from '../encoders/AmrWbEncoder.ts';
import { AmrDecoder } from '../decoders/AmrDecoder.ts';
import { EvsEncoder } from '../encoders/EvsEncoder.ts';
import { EvsDecoder } from '../decoders/EvsDecoder.ts';
import { Mp4BoxReader } from '../audio/Mp4BoxReader.ts';
import { WavExporter } from '../media/WavExporter.ts';
import { TtsEngine, type VoiceMetadata, type TtsSynthesizeResult } from '../tts/TtsEngine.ts';
import { RawAudioLoader, type LoadedAudio } from '../audio/RawAudioLoader.ts';
import { ChannelSplitter } from '../audio/ChannelSplitter.ts';
import { AudioEditorController } from './editor/AudioEditorController.ts';

export class ClipStudioController {
  private static instance: ClipStudioController;

  private currentInputAudio: LoadedAudio | null = null;
  private currentInputBytes: Uint8Array | null = null;
  private currentPackagedClip: PackagedClip | null = null;
  private currentReconstructedPcm: Float32Array | null = null;

  // Track A (preprocessed input) state
  private currentTrackAPcm16: Int16Array | null = null;
  private currentTrackAFloat: Float32Array | null = null;
  private currentTrackAWavBytes: Uint8Array | null = null;
  private currentTrackAFilename: string = '';

  // Web Audio A/B Player state
  private audioCtx: AudioContext | null = null;
  private sourceNode: AudioBufferSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private isPlaying = false;
  private currentTrack: 'A' | 'B' = 'B'; // 'A' = Original Input, 'B' = Encoded Reconstructed
  private playbackStartTime = 0;
  private pausedAtTime = 0;
  private animationFrameId: number | null = null;

  // TTS Studio state
  private ttsEngine: TtsEngine = TtsEngine.getInstance();
  private currentTtsResult: TtsSynthesizeResult | null = null;
  private ttsAudioCtx: AudioContext | null = null;
  private ttsSourceNode: AudioBufferSourceNode | null = null;
  private ttsIsPlaying = false;
  private ttsPlaybackStartTime = 0;
  private ttsPausedAtTime = 0;
  private ttsAnimationFrameId: number | null = null;

  public static getInstance(): ClipStudioController {
    if (!this.instance) {
      this.instance = new ClipStudioController();
    }
    return this.instance;
  }

  public init(): void {
    this.setupSubTabNavigation();
    this.setupConvertDropzone();
    this.populateCodecDropdown();
    this.setupConvertControls();
    this.setupPlayerControls();
    this.setupTtsControls();

    const pEditor = document.getElementById('panel-clipstudio-editor');
    if (pEditor) {
      AudioEditorController.getInstance().init(pEditor);
    }
  }

  private setupSubTabNavigation(): void {
    const subTabs = document.querySelectorAll('.clipstudio-subtab');
    subTabs.forEach(tab => {
      tab.addEventListener('click', () => {
        subTabs.forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.getAttribute('data-subtab');
        const pConvert = document.getElementById('panel-clipstudio-convert');
        const pTts = document.getElementById('panel-clipstudio-tts');
        const pEditor = document.getElementById('panel-clipstudio-editor');
        if (pConvert && pTts) {
          pConvert.style.display = target === 'convert' ? 'block' : 'none';
          pTts.style.display = target === 'tts' ? 'block' : 'none';
          if (pEditor) {
            pEditor.style.display = target === 'editor' ? 'block' : 'none';
            if (target === 'editor') {
              AudioEditorController.getInstance().renderAll();
            }
          }
        }
      });
    });
  }

  private setupConvertDropzone(): void {
    const dropzone = document.getElementById('clipstudio-convert-dropzone');
    const fileInput = document.getElementById('clipstudio-convert-file-input') as HTMLInputElement | null;
    const btnSelect = document.getElementById('btn-clipstudio-select-file');

    if (!dropzone || !fileInput) return;

    if (btnSelect) {
      btnSelect.addEventListener('click', (e) => {
        e.stopPropagation();
        fileInput.click();
      });
    }

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.style.borderColor = '#7aa2f7';
      dropzone.style.backgroundColor = 'rgba(122, 162, 247, 0.1)';
    });

    dropzone.addEventListener('dragleave', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.style.borderColor = 'var(--border)';
      dropzone.style.backgroundColor = 'rgba(0,0,0,0.15)';
    });

    dropzone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      dropzone.style.borderColor = 'var(--border)';
      dropzone.style.backgroundColor = 'rgba(0,0,0,0.15)';
      const files = e.dataTransfer?.files;
      if (files && files.length > 0) {
        this.loadFile(files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      const files = (e.target as HTMLInputElement).files;
      if (files && files.length > 0) {
        this.loadFile(files[0]);
      }
    });

    const btnInputToEditor = document.getElementById('btn-cs-input-to-editor');
    if (btnInputToEditor) {
      btnInputToEditor.addEventListener('click', () => this.handleInputHandoffToEditor());
    }
  }

  private async loadFile(file: File): Promise<void> {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);

      // Decode input using RawAudioLoader
      this.currentInputBytes = bytes;
      const loaded = await RawAudioLoader.load(bytes, file.name);
      this.currentInputAudio = loaded;

      this.displayInputSummary(loaded, file.size);
      this.updateChannelSelector(loaded.numChannels);
      this.updateFilenamePreview();

      const btnEncode = document.getElementById('btn-clipstudio-encode') as HTMLButtonElement | null;
      if (btnEncode) btnEncode.disabled = false;

    } catch (err) {
      console.error('Failed to load audio file:', err);
      alert(`Could not load audio file: ${(err as Error).message}`);
    }
  }

  private displayInputSummary(audio: LoadedAudio, fileSize: number): void {
    const card = document.getElementById('clipstudio-input-summary-card');
    if (!card) return;

    card.style.display = 'block';

    const elName = document.getElementById('cs-input-filename');
    const elFormat = document.getElementById('cs-input-format');
    const elRate = document.getElementById('cs-input-rate');
    const elChannels = document.getElementById('cs-input-channels');
    const elDuration = document.getElementById('cs-input-duration');
    const elLevels = document.getElementById('cs-input-levels');

    if (elName) elName.textContent = audio.fileName;
    if (elFormat) elFormat.textContent = `${audio.formatName} (${(fileSize / 1024).toFixed(1)} KB)`;
    if (elRate) elRate.textContent = `${audio.sampleRate.toLocaleString()} Hz`;
    if (elChannels) elChannels.textContent = audio.numChannels === 1 ? 'Mono' : audio.numChannels === 2 ? 'Stereo' : `${audio.numChannels} Channels`;
    if (elDuration) elDuration.textContent = `${audio.durationSec.toFixed(2)}s`;

    if (elLevels && audio.channelData.length > 0) {
      const chInfo = ChannelSplitter.splitChannels(audio.channelData);
      const rms = chInfo[0]?.rmsDbfs ?? -100;
      const peak = chInfo[0]?.peakDbfs ?? -100;
      elLevels.textContent = `Peak: ${peak.toFixed(1)} dBFS | RMS: ${rms.toFixed(1)} dBFS`;
    }
  }

  private updateChannelSelector(numChannels: number): void {
    const sel = document.getElementById('cs-channel-select') as HTMLSelectElement | null;
    if (!sel) return;

    sel.innerHTML = '';
    if (numChannels > 1) {
      const optMix = document.createElement('option');
      optMix.value = 'mix';
      optMix.textContent = `Mono Downmix (${numChannels} Channels)`;
      sel.appendChild(optMix);
    }

    const standardNames = numChannels === 2 ? ['Left Channel', 'Right Channel'] : Array.from({ length: numChannels }, (_, i) => `Channel ${i + 1}`);
    for (let i = 0; i < numChannels; i++) {
      const opt = document.createElement('option');
      opt.value = i.toString();
      opt.textContent = standardNames[i];
      sel.appendChild(opt);
    }
  }

  private populateCodecDropdown(): void {
    const sel = document.getElementById('cs-codec-select') as HTMLSelectElement | null;
    if (!sel) return;

    sel.innerHTML = '';
    const profiles = CodecProfileRegistry.getAll();
    profiles.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = `${p.name} (${p.bandwidth})`;
      opt.title = p.description || p.name;
      sel.appendChild(opt);
    });

    sel.addEventListener('change', () => {
      this.onCodecChanged();
    });

    this.onCodecChanged();
  }

  private onCodecChanged(): void {
    const selCodec = document.getElementById('cs-codec-select') as HTMLSelectElement | null;
    const selMode = document.getElementById('cs-mode-select') as HTMLSelectElement | null;
    const chkDtx = document.getElementById('cs-chk-dtx') as HTMLInputElement | null;
    const lblDtx = document.getElementById('cs-lbl-dtx');
    const linkCodecSpec = document.getElementById('cs-codec-spec-link') as HTMLAnchorElement | null;
    const txtCodecDesc = document.getElementById('cs-codec-desc-text');

    if (!selCodec || !selMode) return;

    const profile = CodecProfileRegistry.get(selCodec.value);
    if (!profile) return;

    if (linkCodecSpec && profile.docUrl) {
      linkCodecSpec.href = profile.docUrl;
      linkCodecSpec.textContent = `[${profile.docTitle || 'Specs'} ↗]`;
      linkCodecSpec.title = `Open ${profile.docTitle || profile.name} standard specification`;
      linkCodecSpec.style.display = 'inline';
    }
    if (txtCodecDesc && profile.description) {
      txtCodecDesc.textContent = profile.description;
    }

    selMode.innerHTML = '';
    profile.modes.forEach((m, idx) => {
      const opt = document.createElement('option');
      opt.value = idx.toString();
      opt.textContent = `${m.bitrateKbps} kbps — ${m.description || m.rateLabel}`;
      opt.title = `${m.description || m.rateLabel} (${m.bitrateKbps} kbps, payload: ${m.framePayloadBytes} bytes/frame)`;
      selMode.appendChild(opt);
    });
    selMode.selectedIndex = profile.defaultModeIndex;

    if (chkDtx && lblDtx) {
      chkDtx.disabled = !profile.supportsDtx;
      chkDtx.checked = profile.defaultDtx;
      lblDtx.style.opacity = profile.supportsDtx ? '1.0' : '0.4';
    }

    this.updateFilenamePreview();
  }

  private setupConvertControls(): void {
    const selMode = document.getElementById('cs-mode-select');
    const chkDtx = document.getElementById('cs-chk-dtx');
    const inpBaseName = document.getElementById('cs-custom-basename') as HTMLInputElement | null;

    if (selMode) selMode.addEventListener('change', () => this.updateFilenamePreview());
    if (chkDtx) chkDtx.addEventListener('change', () => this.updateFilenamePreview());
    if (inpBaseName) inpBaseName.addEventListener('input', () => this.updateFilenamePreview());

    const btnEncode = document.getElementById('btn-clipstudio-encode');
    if (btnEncode) {
      btnEncode.addEventListener('click', () => this.executeEncoding());
    }
  }

  private updateFilenamePreview(): void {
    const selCodec = document.getElementById('cs-codec-select') as HTMLSelectElement | null;
    const selMode = document.getElementById('cs-mode-select') as HTMLSelectElement | null;
    const chkDtx = document.getElementById('cs-chk-dtx') as HTMLInputElement | null;
    const inpBaseName = document.getElementById('cs-custom-basename') as HTMLInputElement | null;
    const lblPreview = document.getElementById('cs-filename-preview');

    if (!selCodec || !lblPreview) return;

    const profile = CodecProfileRegistry.get(selCodec.value);
    if (!profile) return;

    const modeIdx = selMode ? parseInt(selMode.value, 10) : profile.defaultModeIndex;
    const mode = profile.modes[modeIdx] || profile.modes[0];
    const dtx = chkDtx ? chkDtx.checked : false;

    let base = inpBaseName && inpBaseName.value.trim() ? inpBaseName.value.trim() : 'speech';
    if (this.currentInputAudio && (!inpBaseName || !inpBaseName.value.trim())) {
      base = this.currentInputAudio.fileName.replace(/\.[^/.]+$/, '');
    }

    const filename = RawClipPackager.formatSuggestedFilename(profile, base, {
      rateLabel: mode.rateLabel,
      dtx,
      band: profile.bandwidth,
    });

    lblPreview.textContent = filename;
  }

  private async executeEncoding(): Promise<void> {
    if (!this.currentInputAudio) return;

    const selCodec = document.getElementById('cs-codec-select') as HTMLSelectElement | null;
    const selMode = document.getElementById('cs-mode-select') as HTMLSelectElement | null;
    const chkDtx = document.getElementById('cs-chk-dtx') as HTMLInputElement | null;
    const selChannel = document.getElementById('cs-channel-select') as HTMLSelectElement | null;
    const chkDc = document.getElementById('cs-chk-dc') as HTMLInputElement | null;
    const chkHp = document.getElementById('cs-chk-highpass') as HTMLInputElement | null;
    const chkNorm = document.getElementById('cs-chk-norm') as HTMLInputElement | null;
    const chkTrim = document.getElementById('cs-chk-trim') as HTMLInputElement | null;
    const chkForce = document.getElementById('cs-chk-force-reencode') as HTMLInputElement | null;
    const inpDuration = document.getElementById('cs-inp-duration') as HTMLInputElement | null;
    const selDurationMode = document.getElementById('cs-sel-duration-mode') as HTMLSelectElement | null;

    if (!selCodec) return;
    const profile = CodecProfileRegistry.get(selCodec.value);
    if (!profile) return;

    const modeIdx = selMode ? parseInt(selMode.value, 10) : profile.defaultModeIndex;
    const mode = profile.modes[modeIdx] || profile.modes[0];
    const dtxEnabled = chkDtx ? chkDtx.checked : false;
    const forceReencode = chkForce ? chkForce.checked : false;

    // 1. Audio Pre-processing
    const channelChoice = selChannel?.value === 'mix' ? 'mix' : parseInt(selChannel?.value || '0', 10);
    const targetDurationSec = inpDuration && parseFloat(inpDuration.value) > 0 ? parseFloat(inpDuration.value) : undefined;

    const prep = AudioPreprocessor.process(
      this.currentInputAudio.channelData,
      this.currentInputAudio.sampleRate,
      {
        channel: channelChoice,
        targetSampleRate: profile.sampleRate,
        removeDc: chkDc ? chkDc.checked : true,
        highPassFilter: chkHp ? chkHp.checked : false,
        normalize: chkNorm ? chkNorm.checked : true,
        targetPeakDbfs: -1.0,
        trimSilence: chkTrim ? chkTrim.checked : false,
        targetDurationSec,
        durationMode: (selDurationMode?.value as 'pad' | 'loop') || 'pad',
      }
    );

    // 2. Check for Zero-Transcode Pass-through
    const frames: Uint8Array[] = [];
    let reconstructedFloat: Float32Array;
    let isPassThrough = false;

    if (!forceReencode && this.currentInputBytes) {
      if (profile.id === 'amr-nb') {
        if (
          this.currentInputBytes.length >= 6 &&
          this.currentInputBytes[0] === 0x23 && this.currentInputBytes[1] === 0x21 &&
          this.currentInputBytes[2] === 0x41 && this.currentInputBytes[3] === 0x4d &&
          this.currentInputBytes[4] === 0x52 && this.currentInputBytes[5] === 0x0a
        ) {
          const SIZES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 6, 5, 5, 0, 0, 0, 0];
          let off = 6;
          while (off < this.currentInputBytes.length) {
            const ft = (this.currentInputBytes[off] >> 3) & 0x0f;
            const len = 1 + (SIZES[ft] ?? 0);
            if (off + len > this.currentInputBytes.length) break;
            frames.push(this.currentInputBytes.subarray(off, off + len));
            off += len;
          }
          if (frames.length > 0) isPassThrough = true;
        } else if (Mp4BoxReader.isMp4Or3gp(this.currentInputBytes)) {
          const mp4 = Mp4BoxReader.parse(this.currentInputBytes);
          const trk = mp4.audioTracks.find(t => t.codec === 'samr');
          if (trk && trk.samples.length > 0) {
            frames.push(...trk.samples);
            isPassThrough = true;
          }
        }
      } else if (profile.id === 'amr-wb') {
        if (
          this.currentInputBytes.length >= 9 &&
          this.currentInputBytes[0] === 0x23 && this.currentInputBytes[1] === 0x21 &&
          this.currentInputBytes[2] === 0x41 && this.currentInputBytes[3] === 0x4d &&
          this.currentInputBytes[4] === 0x52 && this.currentInputBytes[5] === 0x2d &&
          this.currentInputBytes[6] === 0x57 && this.currentInputBytes[7] === 0x42 &&
          this.currentInputBytes[8] === 0x0a
        ) {
          const WB_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, 0, 0, 0, 0, 0, 0];
          let off = 9;
          while (off < this.currentInputBytes.length) {
            const ft = (this.currentInputBytes[off] >> 3) & 0x0f;
            const len = 1 + (WB_SIZES[ft] ?? 0);
            if (off + len > this.currentInputBytes.length) break;
            frames.push(this.currentInputBytes.subarray(off, off + len));
            off += len;
          }
          if (frames.length > 0) isPassThrough = true;
        } else if (Mp4BoxReader.isMp4Or3gp(this.currentInputBytes)) {
          const mp4 = Mp4BoxReader.parse(this.currentInputBytes);
          const trk = mp4.audioTracks.find(t => t.codec === 'sawb');
          if (trk && trk.samples.length > 0) {
            frames.push(...trk.samples);
            isPassThrough = true;
          }
        }
      }
    }

    if (isPassThrough) {
      reconstructedFloat = prep.pcmFloat;
    } else {
      // Encode frames
      if (profile.id === 'g711u') {
        const rawOctets = G711Encoder.encodeUlaw(prep.pcm16);
        const frameSize = 160; // 20 ms @ 8000 Hz
        for (let offset = 0; offset < rawOctets.length; offset += frameSize) {
          frames.push(rawOctets.subarray(offset, Math.min(rawOctets.length, offset + frameSize)));
        }
        const dec16 = G711Decoder.decodeUlaw(rawOctets);
        reconstructedFloat = new Float32Array(dec16.length);
        for (let i = 0; i < dec16.length; i++) reconstructedFloat[i] = dec16[i] / 32768.0;

      } else if (profile.id === 'g711a') {
        const rawOctets = G711Encoder.encodeAlaw(prep.pcm16);
        const frameSize = 160;
        for (let offset = 0; offset < rawOctets.length; offset += frameSize) {
          frames.push(rawOctets.subarray(offset, Math.min(rawOctets.length, offset + frameSize)));
        }
        const dec16 = G711Decoder.decodeAlaw(rawOctets);
        reconstructedFloat = new Float32Array(dec16.length);
        for (let i = 0; i < dec16.length; i++) reconstructedFloat[i] = dec16[i] / 32768.0;

      } else if (profile.id === 'g722') {
        const bits = mode.bitrateKbps === 48 ? 6 : mode.bitrateKbps === 56 ? 7 : 8;
        const rawOctets = G722Encoder.encode(prep.pcm16, bits);
        const frameSize = bits === 8 ? 160 : bits === 7 ? 140 : 120;
        for (let offset = 0; offset < rawOctets.length; offset += frameSize) {
          frames.push(rawOctets.subarray(offset, Math.min(rawOctets.length, offset + frameSize)));
        }
        const dec16 = G722Decoder.decodeG722(rawOctets, bits);
        reconstructedFloat = new Float32Array(dec16.length);
        for (let i = 0; i < dec16.length; i++) reconstructedFloat[i] = dec16[i] / 32768.0;

      } else if (profile.id === 'amr-nb') {
        const nbMode = typeof mode.modeId === 'number' ? mode.modeId : AmrNbEncoder.modeFromBitrate(mode.bitrateKbps * 1000);
        const rawFrames = AmrNbEncoder.encode(prep.pcm16, { mode: nbMode, dtx: dtxEnabled });
        frames.push(...rawFrames);

        const amrFile = AmrNbEncoder.encodeToAmrFile(prep.pcm16, { mode: nbMode, dtx: dtxEnabled });
        const decoded = await AmrDecoder.decodeAmrFile(amrFile);
        reconstructedFloat = new Float32Array(decoded.pcm.length);
        for (let i = 0; i < decoded.pcm.length; i++) reconstructedFloat[i] = decoded.pcm[i] / 32768.0;

      } else if (profile.id === 'amr-wb') {
        const wbMode = typeof mode.modeId === 'number' ? mode.modeId : AmrWbEncoder.modeFromBitrate(mode.bitrateKbps * 1000);
        const rawFrames = await AmrWbEncoder.encode(prep.pcm16, { mode: wbMode, dtx: dtxEnabled });
        frames.push(...rawFrames);

        const awbFile = await AmrWbEncoder.encodeToAwbFile(prep.pcm16, { mode: wbMode, dtx: dtxEnabled });
        const decoded = await AmrDecoder.decodeAmrFile(awbFile);
        reconstructedFloat = new Float32Array(decoded.pcm.length);
        for (let i = 0; i < decoded.pcm.length; i++) reconstructedFloat[i] = decoded.pcm[i] / 32768.0;

      } else if (profile.id === 'evs') {
        const isIo = typeof mode.modeId === 'string' && mode.modeId.startsWith('io_');
        const rawFrames = await EvsEncoder.encode(prep.pcm16, {
          sampleRate: profile.sampleRate,
          bitrateBps: mode.bitrateKbps * 1000,
          bandwidth: profile.bandwidth,
          dtx: dtxEnabled,
          isAmrWbIo: isIo,
        });
        frames.push(...rawFrames);

        try {
          const decoded = await EvsDecoder.decodePayloads(frames, true, profile.sampleRate);
          reconstructedFloat = new Float32Array(decoded.pcm.length);
          for (let i = 0; i < decoded.pcm.length; i++) reconstructedFloat[i] = decoded.pcm[i] / 32768.0;
        } catch {
          reconstructedFloat = prep.pcmFloat;
        }

      } else if (profile.id === 'g726') {
        const rawOctets = G726Encoder.encode32(prep.pcm16);
        const frameSize = 80; // 20 ms @ 32 kbps = 80 bytes
        for (let offset = 0; offset < rawOctets.length; offset += frameSize) {
          frames.push(rawOctets.subarray(offset, Math.min(rawOctets.length, offset + frameSize)));
        }
        const dec16 = G726Decoder.decode32(rawOctets);
        reconstructedFloat = new Float32Array(dec16.length);
        for (let i = 0; i < dec16.length; i++) reconstructedFloat[i] = dec16[i] / 32768.0;

      } else if (profile.id === 'g729') {
        const rawFrames = G729Encoder.encode(prep.pcm16, { dtx: dtxEnabled });
        frames.push(...rawFrames);

        const totalBytes = frames.reduce((a, f) => a + f.length, 0);
        const packed = new Uint8Array(totalBytes);
        let off = 0;
        for (const f of frames) {
          packed.set(f, off);
          off += f.length;
        }
        const dec16 = G729Decoder.decode(packed);
        reconstructedFloat = new Float32Array(dec16.length);
        for (let i = 0; i < dec16.length; i++) reconstructedFloat[i] = dec16[i] / 32768.0;

      } else {
        alert(`Encoding for ${profile.name} will be active in the next release.`);
        return;
      }
    }

    // 3. Package Clip with Container Headers & Telemetry
    const base = this.currentInputAudio.fileName.replace(/\.[^/.]+$/, '');
    const packaged = RawClipPackager.package(profile, frames, {
      baseFilename: base,
      modeRateLabel: mode.rateLabel,
      dtxEnabled,
      bandwidth: profile.bandwidth,
    });

    // Save Track A (Original preprocessed input) & Track B (Reconstructed decoded output)
    this.currentTrackAPcm16 = prep.pcm16;
    this.currentTrackAFloat = prep.pcmFloat;
    this.currentTrackAFilename = `${base}_input.wav`;
    this.currentTrackAWavBytes = WavExporter.encodeWav([prep.pcm16], profile.sampleRate, 16);

    this.currentPackagedClip = packaged;
    this.currentReconstructedPcm = reconstructedFloat;

    // 4. Render Telemetry & Result Card
    this.displayResultCard(packaged, isPassThrough);

    // 5. Setup A/B Audio Player
    this.setupAudioBuffers(prep.pcmFloat, reconstructedFloat, profile.sampleRate);
  }

  private displayResultCard(packaged: PackagedClip, isPassThrough: boolean = false): void {
    const card = document.getElementById('clipstudio-result-card');
    if (!card) return;

    card.style.display = 'block';

    const elFilename = document.getElementById('cs-res-filename');
    const elBadge = document.getElementById('cs-res-badge');
    const elSize = document.getElementById('cs-res-size');
    const elDuration = document.getElementById('cs-res-duration');
    const elBitrate = document.getElementById('cs-res-bitrate');
    const elFrames = document.getElementById('cs-res-frames');
    const elDtx = document.getElementById('cs-res-dtx');
    const btnDownload = document.getElementById('btn-clipstudio-download') as HTMLButtonElement | null;

    if (elFilename) elFilename.textContent = packaged.suggestedFilename;
    if (elBadge) {
      elBadge.style.display = 'inline-block';
      if (isPassThrough) {
        elBadge.style.background = 'rgba(158, 206, 106, 0.2)';
        elBadge.style.color = '#9ece6a';
        elBadge.style.border = '1px solid #9ece6a';
        elBadge.textContent = '⚡ Pass-through (Lossless)';
      } else {
        elBadge.style.background = 'rgba(122, 162, 247, 0.2)';
        elBadge.style.color = '#7aa2f7';
        elBadge.style.border = '1px solid #7aa2f7';
        elBadge.textContent = 'Transcoded';
      }
    }
    if (elSize) elSize.textContent = `${(packaged.telemetry.totalBytes / 1024).toFixed(2)} KB (${packaged.telemetry.totalBytes} bytes)`;
    if (elDuration) elDuration.textContent = `${packaged.telemetry.durationSec.toFixed(2)}s`;
    if (elBitrate) elBitrate.textContent = `Avg: ${packaged.telemetry.averageBitrateKbps} kbps | Peak: ${packaged.telemetry.peakBitrateKbps} kbps`;
    if (elFrames) elFrames.textContent = `${packaged.telemetry.frameCount} frames`;
    if (elDtx) {
      elDtx.textContent = `Speech: ${packaged.telemetry.speechPercentage}% | Silence: ${packaged.telemetry.silencePercentage}%`;
    }

    if (btnDownload) {
      btnDownload.onclick = () => {
        if (this.currentTrack === 'A') {
          if (!this.currentTrackAWavBytes) return;
          const blob = new Blob([this.currentTrackAWavBytes as BlobPart], { type: 'audio/wav' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = this.currentTrackAFilename || 'input.wav';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        } else {
          if (!this.currentPackagedClip) return;
          const blob = new Blob([this.currentPackagedClip.data as BlobPart], { type: 'application/octet-stream' });
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = this.currentPackagedClip.suggestedFilename;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          URL.revokeObjectURL(url);
        }
      };
    }
  }

  private setupAudioBuffers(origFloat: Float32Array, reconFloat: Float32Array, sampleRate: number): void {
    if (!this.audioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new AudioCtxClass({ sampleRate });
      this.gainNode = this.audioCtx.createGain();
      this.gainNode.gain.value = 0.8;
      this.gainNode.connect(this.audioCtx.destination);
    }

    this.stopPlayback();
    this.currentTrack = 'B';
    this.updateTrackToggleButtons();
    this.renderWaveform(reconFloat);
  }

  private setupPlayerControls(): void {
    const btnPlay = document.getElementById('btn-cs-player-play');
    const btnTrackA = document.getElementById('btn-cs-track-a');
    const btnTrackB = document.getElementById('btn-cs-track-b');
    const canvas = document.getElementById('cs-waveform-canvas') as HTMLCanvasElement | null;

    if (btnPlay) {
      btnPlay.addEventListener('click', () => {
        if (this.isPlaying) {
          this.pausePlayback();
        } else {
          this.startPlayback();
        }
      });
    }

    if (btnTrackA) {
      btnTrackA.addEventListener('click', () => {
        this.switchTrack('A');
      });
    }

    if (btnTrackB) {
      btnTrackB.addEventListener('click', () => {
        this.switchTrack('B');
      });
    }

    if (canvas) {
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const totalDuration = this.currentPackagedClip?.telemetry.durationSec || 0;
        this.seekTo(pct * totalDuration);
      });
    }
  }

  private switchTrack(track: 'A' | 'B'): void {
    if (this.currentTrack === track) return;
    this.currentTrack = track;
    this.updateTrackToggleButtons();

    if (this.isPlaying) {
      // Seamless switch without stopping timeline
      const currentPos = this.getCurrentPlaybackTime();
      this.stopSourceOnly();
      this.playFrom(currentPos);
    } else {
      const buffer = track === 'A' ? this.currentTrackAFloat : this.currentReconstructedPcm;
      if (buffer) this.renderWaveform(buffer);
    }
  }

  private updateTrackToggleButtons(): void {
    const btnA = document.getElementById('btn-cs-track-a');
    const btnB = document.getElementById('btn-cs-track-b');
    const btnDownload = document.getElementById('btn-clipstudio-download') as HTMLButtonElement | null;
    const elResLabel = document.getElementById('cs-res-track-label');
    const elFilename = document.getElementById('cs-res-filename');

    if (btnA && btnB) {
      if (this.currentTrack === 'A') {
        btnA.classList.add('active');
        btnA.style.background = '#7aa2f7';
        btnA.style.color = '#16161e';
        btnA.style.fontWeight = '700';

        btnB.classList.remove('active');
        btnB.style.background = 'var(--bg-secondary)';
        btnB.style.color = '#9ece6a';
        btnB.style.fontWeight = 'normal';

        if (btnDownload) {
          btnDownload.textContent = '⬇ Download Input WAV [A]';
          btnDownload.title = 'Download preprocessed 16-bit linear PCM WAV [A] before codec compression';
        }
        if (elResLabel) {
          elResLabel.textContent = 'Preprocessed Input [A]:';
        }
        if (elFilename && this.currentTrackAFilename) {
          elFilename.textContent = this.currentTrackAFilename;
          elFilename.style.color = '#7aa2f7';
        }
      } else {
        btnB.classList.add('active');
        btnB.style.background = '#9ece6a';
        btnB.style.color = '#16161e';
        btnB.style.fontWeight = '700';

        btnA.classList.remove('active');
        btnA.style.background = 'var(--bg-secondary)';
        btnA.style.color = '#7aa2f7';
        btnA.style.fontWeight = 'normal';

        if (btnDownload) {
          btnDownload.textContent = '⬇ Download Raw Clip [B]';
          btnDownload.title = `Download encoded raw bitstream [B] (${this.currentPackagedClip?.suggestedFilename || ''})`;
        }
        if (elResLabel) {
          elResLabel.textContent = 'Encoded Output [B]:';
        }
        if (elFilename && this.currentPackagedClip) {
          elFilename.textContent = this.currentPackagedClip.suggestedFilename;
          elFilename.style.color = '#9ece6a';
        }
      }
    }
  }

  private startPlayback(): void {
    if (!this.audioCtx) return;
    if (this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
    this.playFrom(this.pausedAtTime);
  }

  private playFrom(timeSec: number): void {
    if (!this.audioCtx || !this.gainNode) return;

    const profile = CodecProfileRegistry.get(this.currentPackagedClip?.telemetry.codecId || '');
    const sampleRate = profile ? profile.sampleRate : 16000;

    let pcm = this.currentTrack === 'A' ? this.currentTrackAFloat : this.currentReconstructedPcm;
    if (!pcm || pcm.length === 0) return;

    const audioBuf = this.audioCtx.createBuffer(1, pcm.length, sampleRate);
    audioBuf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);

    this.sourceNode = this.audioCtx.createBufferSource();
    this.sourceNode.buffer = audioBuf;
    this.sourceNode.connect(this.gainNode);

    this.playbackStartTime = this.audioCtx.currentTime - timeSec;
    this.sourceNode.start(0, timeSec);
    this.isPlaying = true;

    this.sourceNode.onended = () => {
      if (this.isPlaying) {
        this.stopPlayback();
      }
    };

    const btnPlay = document.getElementById('btn-cs-player-play');
    if (btnPlay) btnPlay.textContent = '⏸ Pause';

    this.startAnimationLoop();
  }

  private pausePlayback(): void {
    if (!this.isPlaying) return;
    this.pausedAtTime = this.getCurrentPlaybackTime();
    this.stopSourceOnly();
    this.isPlaying = false;

    const btnPlay = document.getElementById('btn-cs-player-play');
    if (btnPlay) btnPlay.textContent = '▶ Play';

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  private stopPlayback(): void {
    this.stopSourceOnly();
    this.isPlaying = false;
    this.pausedAtTime = 0;

    const btnPlay = document.getElementById('btn-cs-player-play');
    if (btnPlay) btnPlay.textContent = '▶ Play';

    const elTime = document.getElementById('cs-player-time');
    if (elTime) elTime.textContent = '0:00.0 / 0:00.0';

    if (this.animationFrameId !== null) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }

    const pcm = this.currentTrack === 'A' ? this.currentTrackAFloat : this.currentReconstructedPcm;
    if (pcm) this.renderWaveform(pcm, 0);
  }

  private stopSourceOnly(): void {
    if (this.sourceNode) {
      try {
        this.sourceNode.stop();
        this.sourceNode.disconnect();
      } catch {
        // Ignored
      }
      this.sourceNode = null;
    }
  }

  private seekTo(timeSec: number): void {
    const duration = this.currentPackagedClip?.telemetry.durationSec || 0;
    const clamped = Math.max(0, Math.min(duration, timeSec));
    this.pausedAtTime = clamped;

    if (this.isPlaying) {
      this.stopSourceOnly();
      this.playFrom(clamped);
    } else {
      const pcm = this.currentTrack === 'A' ? this.currentTrackAFloat : this.currentReconstructedPcm;
      if (pcm) this.renderWaveform(pcm, clamped / (duration || 1));
    }
  }

  private getCurrentPlaybackTime(): number {
    if (!this.audioCtx || !this.isPlaying) return this.pausedAtTime;
    return this.audioCtx.currentTime - this.playbackStartTime;
  }

  private startAnimationLoop(): void {
    const update = () => {
      if (!this.isPlaying) return;
      const curTime = this.getCurrentPlaybackTime();
      const duration = this.currentPackagedClip?.telemetry.durationSec || 0;

      const elTime = document.getElementById('cs-player-time');
      if (elTime) {
        elTime.textContent = `${this.formatTime(curTime)} / ${this.formatTime(duration)}`;
      }

      const pcm = this.currentTrack === 'A' ? this.currentTrackAFloat : this.currentReconstructedPcm;
      if (pcm) {
        this.renderWaveform(pcm, duration > 0 ? curTime / duration : 0);
      }

      this.animationFrameId = requestAnimationFrame(update);
    };

    this.animationFrameId = requestAnimationFrame(update);
  }

  private formatTime(sec: number): string {
    const mins = Math.floor(sec / 60);
    const s = sec % 60;
    return `${mins}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
  }

  private renderWaveform(samples: Float32Array, progressPct = 0): void {
    const canvas = document.getElementById('cs-waveform-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#16161e';
    ctx.fillRect(0, 0, width, height);

    // Draw center line
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!samples || samples.length === 0) return;

    // Draw waveform
    const step = Math.max(1, Math.floor(samples.length / width));
    const midY = height / 2;

    ctx.fillStyle = this.currentTrack === 'A' ? '#7aa2f7' : '#9ece6a';
    for (let x = 0; x < width; x++) {
      let min = 1.0;
      let max = -1.0;
      const start = x * step;
      const end = Math.min(samples.length, start + step);

      for (let j = start; j < end; j++) {
        const val = samples[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      const yTop = midY - max * (midY - 4);
      const yBottom = midY - min * (midY - 4);
      ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
    }

    // Draw playhead
    if (progressPct > 0) {
      const playheadX = progressPct * width;
      ctx.fillStyle = '#f7768e';
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }
  }

  // =========================================================================
  // Text-to-Speech (TTS) Studio Controller Methods
  // =========================================================================

  private async setupTtsControls(): Promise<void> {
    const selLang = document.getElementById('tts-language-select') as HTMLSelectElement | null;
    const selVoice = document.getElementById('tts-voice-select') as HTMLSelectElement | null;
    const inpPrompt = document.getElementById('tts-prompt-input') as HTMLTextAreaElement | null;
    const rngSpeed = document.getElementById('tts-range-speed') as HTMLInputElement | null;
    const rngPause = document.getElementById('tts-range-pause') as HTMLInputElement | null;
    const lblSpeed = document.getElementById('tts-lbl-speed');
    const lblPause = document.getElementById('tts-lbl-pause');
    const lblChars = document.getElementById('tts-char-count');
    const btnSample = document.getElementById('btn-tts-load-sample');
    const btnAddVoice = document.getElementById('btn-tts-add-voice');
    const fileModel = document.getElementById('tts-custom-model-file') as HTMLInputElement | null;
    const fileConfig = document.getElementById('tts-custom-config-file') as HTMLInputElement | null;
    const btnSynth = document.getElementById('btn-tts-synthesize');
    const btnHandoff = document.getElementById('btn-tts-handoff-convert');
    const btnDownloadWav = document.getElementById('btn-tts-download-wav');

    // 1. Load Voice Manifest
    await this.ttsEngine.loadManifest();

    if (selLang) {
      this.updateTtsVoicesForLanguage(selLang.value);
      selLang.addEventListener('change', () => {
        this.updateTtsVoicesForLanguage(selLang.value);
      });
    }

    if (selVoice) {
      selVoice.addEventListener('change', () => {
        const v = this.ttsEngine.getVoice(selVoice.value);
        this.updateTtsVoiceNote(v);
        if (v && inpPrompt && (!inpPrompt.value || inpPrompt.value.trim() === '')) {
          inpPrompt.value = v.samplePhrase;
          this.updateCharCount();
        }
      });
    }

    // Live slider readouts
    if (rngSpeed && lblSpeed) {
      rngSpeed.addEventListener('input', () => {
        lblSpeed.textContent = `${parseFloat(rngSpeed.value).toFixed(1)}x`;
      });
    }

    if (rngPause && lblPause) {
      rngPause.addEventListener('input', () => {
        lblPause.textContent = `${rngPause.value} ms`;
      });
    }

    // Text area character counter
    if (inpPrompt && lblChars) {
      inpPrompt.addEventListener('input', () => this.updateCharCount());
    }

    // Load sample phrase button
    if (btnSample && selVoice && inpPrompt) {
      btnSample.addEventListener('click', () => {
        const v = this.ttsEngine.getVoice(selVoice.value);
        if (v) {
          inpPrompt.value = v.samplePhrase;
          this.updateCharCount();
        }
      });
    }

    // Add custom voice button
    if (btnAddVoice && fileModel) {
      btnAddVoice.addEventListener('click', () => fileModel.click());

      fileModel.addEventListener('change', async () => {
        const files = fileModel.files;
        if (!files || files.length === 0) return;
        const modelFile = files[0];

        const customName = prompt('Enter a name for this custom voice:', modelFile.name.replace(/\.onnx$/i, '')) || 'Custom Voice';
        const customLang = prompt('Enter language code (e.g. en_US, en_IN, es_ES):', selLang?.value || 'en_US') || 'en_US';

        try {
          const modelBuffer = await modelFile.arrayBuffer();
          let configObj: any = undefined;

          // Check if user also wants to load a .json config
          if (confirm('Do you have a Piper config .onnx.json file for this model?')) {
            if (fileConfig) fileConfig.click();
          }

          const registered = this.ttsEngine.registerCustomVoice(customName, customLang, modelBuffer, configObj);
          if (selLang) this.updateTtsVoicesForLanguage(selLang.value);
          if (selVoice) selVoice.value = registered.id;
          alert(`Custom voice '${registered.name}' loaded successfully into session.`);
        } catch (err) {
          alert(`Failed to load custom voice: ${(err as Error).message}`);
        }
      });
    }

    // Synthesize button
    if (btnSynth) {
      btnSynth.addEventListener('click', () => this.executeTtsSynthesis());
    }

    // Download WAV button
    if (btnDownloadWav) {
      btnDownloadWav.addEventListener('click', () => {
        if (!this.currentTtsResult) return;
        const blob = new Blob([this.currentTtsResult.wavBytes as BlobPart], { type: 'audio/wav' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `speech_tts_${this.currentTtsResult.sampleRate}hz.wav`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      });
    }

    // Handoff to Convert Panel
    if (btnHandoff) {
      btnHandoff.addEventListener('click', () => this.handleTtsHandoffToConvert());
    }

    // Handoff to Audio Editor
    const btnTtsToEditor = document.getElementById('btn-tts-to-editor');
    if (btnTtsToEditor) {
      btnTtsToEditor.addEventListener('click', () => this.handleTtsHandoffToEditor());
    }

    this.setupTtsPlayerControls();
    this.setupModelsManagerModal();
  }

  private setupModelsManagerModal(): void {
    const btnOpen = document.getElementById('btn-tts-models-manager');
    const modal = document.getElementById('tts-models-modal');
    const btnClose1 = document.getElementById('btn-close-tts-models-modal');
    const btnClose2 = document.getElementById('btn-close-tts-models-modal-bottom');
    const btnFetchAll = document.getElementById('btn-tts-fetch-all') as HTMLButtonElement | null;
    const container = document.getElementById('tts-models-table-container');
    const statusMsg = document.getElementById('tts-models-status-msg');

    if (!btnOpen || !modal || !container) return;

    const closeModal = () => {
      modal.style.display = 'none';
    };
    if (btnClose1) btnClose1.addEventListener('click', closeModal);
    if (btnClose2) btnClose2.addEventListener('click', closeModal);

    const renderTable = async () => {
      container.innerHTML = '';
      const voices = this.ttsEngine.getVoices();

      const table = document.createElement('table');
      table.style.width = '100%';
      table.style.borderCollapse = 'collapse';
      table.style.fontSize = '12px';
      table.style.color = '#fff';

      const thead = document.createElement('thead');
      thead.innerHTML = `
        <tr style="border-bottom: 1px solid var(--border); color: var(--text-dim); text-align: left;">
          <th style="padding: 8px 10px;">Language</th>
          <th style="padding: 8px 10px;">Voice Model</th>
          <th style="padding: 8px 10px;">License</th>
          <th style="padding: 8px 10px;">Size</th>
          <th style="padding: 8px 10px;">Status</th>
          <th style="padding: 8px 10px; text-align: right;">Action</th>
        </tr>
      `;
      table.appendChild(thead);

      const tbody = document.createElement('tbody');

      for (const v of voices) {
        const tr = document.createElement('tr');
        tr.style.borderBottom = '1px solid rgba(255,255,255,0.06)';

        const isLocalReady = !!v.modelBuffer || (typeof v.sizeBytes === 'number' && v.sizeBytes > 1000);
        const statusBadge = isLocalReady
          ? `<span style="background: rgba(158, 206, 106, 0.2); color: #9ece6a; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">✅ Ready Offline</span>`
          : `<span style="background: rgba(122, 162, 247, 0.2); color: #7aa2f7; padding: 2px 8px; border-radius: 4px; font-size: 11px;">⬇️ Available Upstream</span>`;

        tr.innerHTML = `
          <td style="padding: 10px;">
            <div style="font-weight: 600;">${v.languageName || v.language}</div>
            <div style="font-size: 10px; color: var(--text-dim); font-family: monospace;">${v.language}</div>
          </td>
          <td style="padding: 10px;">
            <div>${v.name}</div>
            <div style="font-size: 11px; color: var(--text-dim);">${v.gender} &bull; ${v.sampleRate} Hz</div>
          </td>
          <td style="padding: 10px;">
            <span style="font-size: 11px; color: #bb9af7;">${v.license}</span>
          </td>
          <td style="padding: 10px; font-size: 11px; color: var(--text-dim);">
            ${(v.sizeBytes / (1024 * 1024)).toFixed(1)} MB
          </td>
          <td style="padding: 10px;" id="status-cell-${v.id}">
            ${statusBadge}
          </td>
          <td style="padding: 10px; text-align: right;">
            <button class="btn btn-sm btn-secondary" id="btn-fetch-voice-${v.id}" style="padding: 4px 10px; font-size: 11px; white-space: nowrap;">
              ⬇️ Fetch Latest
            </button>
          </td>
        `;

        tbody.appendChild(tr);
      }

      table.appendChild(tbody);
      container.appendChild(table);

      // Attach button click listeners
      for (const v of voices) {
        const btnFetch = document.getElementById(`btn-fetch-voice-${v.id}`) as HTMLButtonElement | null;
        const cellStatus = document.getElementById(`status-cell-${v.id}`);
        if (btnFetch && cellStatus) {
          btnFetch.addEventListener('click', async () => {
            btnFetch.disabled = true;
            btnFetch.textContent = '⏳ Downloading 0%...';
            if (statusMsg) statusMsg.textContent = `Downloading ${v.name} from HuggingFace...`;

            try {
              await this.ttsEngine.fetchAndCacheUpstreamVoice(v.id, (pct) => {
                btnFetch.textContent = `⏳ ${pct}%`;
              });
              btnFetch.textContent = '✅ Updated';
              cellStatus.innerHTML = `<span style="background: rgba(158, 206, 106, 0.2); color: #9ece6a; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">✅ Updated & Cached</span>`;
              if (statusMsg) statusMsg.textContent = `Successfully updated and cached ${v.name}!`;

              // Refresh voice dropdown in main panel
              const selLang = document.getElementById('tts-language-select') as HTMLSelectElement | null;
              if (selLang) this.updateTtsVoicesForLanguage(selLang.value);
            } catch (err: any) {
              btnFetch.textContent = '❌ Failed';
              btnFetch.disabled = false;
              if (statusMsg) statusMsg.textContent = `Error: ${err?.message || err}`;
            }
          });
        }
      }
    };

    btnOpen.addEventListener('click', async () => {
      modal.style.display = 'flex';
      if (statusMsg) statusMsg.textContent = '';
      await renderTable();
    });

    if (btnFetchAll) {
      btnFetchAll.addEventListener('click', async () => {
        btnFetchAll.disabled = true;
        const voices = this.ttsEngine.getVoices();
        for (let i = 0; i < voices.length; i++) {
          const v = voices[i];
          if (!v.upstreamModelUrl) continue;
          if (statusMsg) statusMsg.textContent = `Downloading [${i + 1}/${voices.length}] ${v.name}...`;
          const btn = document.getElementById(`btn-fetch-voice-${v.id}`) as HTMLButtonElement | null;
          if (btn) btn.textContent = '⏳ Fetching...';

          try {
            await this.ttsEngine.fetchAndCacheUpstreamVoice(v.id);
            if (btn) btn.textContent = '✅ Updated';
            const cell = document.getElementById(`status-cell-${v.id}`);
            if (cell) cell.innerHTML = `<span style="background: rgba(158, 206, 106, 0.2); color: #9ece6a; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 600;">✅ Updated & Cached</span>`;
          } catch (e) {
            if (btn) btn.textContent = '❌ Error';
          }
        }
        if (statusMsg) statusMsg.textContent = 'All models checked and updated from HuggingFace!';
        btnFetchAll.disabled = false;
      });
    }
  }

  private updateCharCount(): void {
    const inpPrompt = document.getElementById('tts-prompt-input') as HTMLTextAreaElement | null;
    const lblChars = document.getElementById('tts-char-count');
    if (!inpPrompt || !lblChars) return;
    lblChars.textContent = `${inpPrompt.value.length} / 500 chars`;
  }

  private updateTtsVoicesForLanguage(lang: string): void {
    const selVoice = document.getElementById('tts-voice-select') as HTMLSelectElement | null;
    const inpPrompt = document.getElementById('tts-prompt-input') as HTMLTextAreaElement | null;
    if (!selVoice) return;

    selVoice.innerHTML = '';
    const allVoices = this.ttsEngine.getVoices();
    const matching = allVoices.filter(v => v.language.toLowerCase() === lang.toLowerCase());

    for (const v of matching) {
      const opt = document.createElement('option');
      opt.value = v.id;
      opt.textContent = `${v.name} (${v.gender})`;
      if (v.isDefault) opt.selected = true;
      selVoice.appendChild(opt);
    }

    // RTL handling for Arabic
    if (inpPrompt) {
      if (lang.toLowerCase().startsWith('ar')) {
        inpPrompt.setAttribute('dir', 'rtl');
        inpPrompt.style.textAlign = 'right';
      } else {
        inpPrompt.setAttribute('dir', 'ltr');
        inpPrompt.style.textAlign = 'left';
      }
    }

    const curVoice = matching[0];
    this.updateTtsVoiceNote(curVoice);

    if (curVoice && inpPrompt && (!inpPrompt.value || inpPrompt.value.trim() === '')) {
      inpPrompt.value = curVoice.samplePhrase;
      this.updateCharCount();
    }
  }

  private updateTtsVoiceNote(voice: VoiceMetadata | undefined): void {
    const box = document.getElementById('tts-voice-note-box');
    const txt = document.getElementById('tts-voice-note-text');
    if (!box || !txt) return;

    if (voice?.fallbackNote) {
      box.style.display = 'block';
      txt.textContent = voice.fallbackNote;
    } else {
      box.style.display = 'none';
      txt.textContent = '';
    }
  }

  private async executeTtsSynthesis(): Promise<void> {
    const selVoice = document.getElementById('tts-voice-select') as HTMLSelectElement | null;
    const inpPrompt = document.getElementById('tts-prompt-input') as HTMLTextAreaElement | null;
    const rngSpeed = document.getElementById('tts-range-speed') as HTMLInputElement | null;
    const rngPause = document.getElementById('tts-range-pause') as HTMLInputElement | null;
    const selRate = document.getElementById('tts-sample-rate-select') as HTMLSelectElement | null;
    const inpDuration = document.getElementById('tts-inp-duration') as HTMLInputElement | null;
    const selDurationMode = document.getElementById('tts-sel-duration-mode') as HTMLSelectElement | null;
    const chkNorm = document.getElementById('tts-chk-norm') as HTMLInputElement | null;
    const inpLead = document.getElementById('tts-inp-lead-silence') as HTMLInputElement | null;
    const inpTrail = document.getElementById('tts-inp-trail-silence') as HTMLInputElement | null;
    const progressContainer = document.getElementById('tts-progress-container');
    const btnSynth = document.getElementById('btn-tts-synthesize') as HTMLButtonElement | null;

    if (!selVoice || !inpPrompt) return;
    const voiceId = selVoice.value;
    const text = inpPrompt.value.trim();
    if (!text) {
      alert('Please enter or load a text prompt to synthesize.');
      return;
    }

    const voice = this.ttsEngine.getVoice(voiceId);
    if (!voice) return;

    if (progressContainer) progressContainer.style.display = 'block';
    if (btnSynth) btnSynth.disabled = true;

    try {
      const targetRate = selRate && parseInt(selRate.value, 10) > 0 ? parseInt(selRate.value, 10) : undefined;
      const targetDur = inpDuration && parseFloat(inpDuration.value) > 0 ? parseFloat(inpDuration.value) : undefined;

      const res = await this.ttsEngine.synthesize(text, voiceId, {
        speed: rngSpeed ? parseFloat(rngSpeed.value) : 1.0,
        sentencePauseMs: rngPause ? parseInt(rngPause.value, 10) : 300,
        targetSampleRate: targetRate,
        targetDurationSec: targetDur,
        durationMode: (selDurationMode?.value as 'pad' | 'loop') || 'pad',
        normalizeLevel: chkNorm ? chkNorm.checked : true,
        leadingSilenceSec: inpLead ? parseFloat(inpLead.value) : 0,
        trailingSilenceSec: inpTrail ? parseFloat(inpTrail.value) : 0,
      });

      this.currentTtsResult = res;
      this.displayTtsResultCard(res, voice);

    } catch (err) {
      console.error('TTS synthesis failed:', err);
      alert(`TTS Synthesis Error: ${(err as Error).message}`);
    } finally {
      if (progressContainer) progressContainer.style.display = 'none';
      if (btnSynth) btnSynth.disabled = false;
    }
  }

  private displayTtsResultCard(res: TtsSynthesizeResult, voice: VoiceMetadata): void {
    const card = document.getElementById('tts-result-card');
    if (!card) return;

    card.style.display = 'block';

    const lblVoice = document.getElementById('tts-res-voice-label');
    const elDur = document.getElementById('tts-res-duration');
    const elRate = document.getElementById('tts-res-rate');
    const elSamples = document.getElementById('tts-res-samples');
    const elNorm = document.getElementById('tts-res-norm-preview');

    if (lblVoice) lblVoice.textContent = `${voice.name} (${voice.language})`;
    if (elDur) elDur.textContent = `${res.durationSec.toFixed(2)}s`;
    if (elRate) elRate.textContent = `${res.sampleRate.toLocaleString()} Hz`;
    if (elSamples) elSamples.textContent = res.pcmFloat.length.toLocaleString();
    if (elNorm) {
      elNorm.textContent = res.normalizedText;
      elNorm.title = res.normalizedText;
    }

    const elTime = document.getElementById('tts-play-time');
    if (elTime) {
      elTime.textContent = `0:00.0 / ${this.formatTime(res.durationSec)}`;
    }
    this.ttsPausedAtTime = 0;

    this.renderTtsWaveform(res.pcmFloat, 0);
  }

  private handleTtsHandoffToConvert(): void {
    if (!this.currentTtsResult) return;

    // Create a synthetic LoadedAudio object from the synthesized audio
    const loaded: LoadedAudio = {
      fileName: `tts_${this.currentTtsResult.sampleRate}hz.wav`,
      codec: 'pcm',
      formatName: `WAV PCM 16-bit (${this.currentTtsResult.sampleRate} Hz)`,
      sampleRate: this.currentTtsResult.sampleRate,
      numChannels: 1,
      channelData: [this.currentTtsResult.pcmFloat],
      durationSec: this.currentTtsResult.durationSec,
      isContainerDecoded: true,
    };

    this.currentInputAudio = loaded;
    this.currentInputBytes = this.currentTtsResult.wavBytes;

    // Switch to Convert subtab
    const subTabs = document.querySelectorAll('.clipstudio-subtab');
    subTabs.forEach(tab => {
      const target = tab.getAttribute('data-subtab');
      if (target === 'convert') tab.classList.add('active');
      else tab.classList.remove('active');
    });

    const pConvert = document.getElementById('panel-clipstudio-convert');
    const pTts = document.getElementById('panel-clipstudio-tts');
    if (pConvert && pTts) {
      pConvert.style.display = 'block';
      pTts.style.display = 'none';
    }

    this.displayInputSummary(loaded, this.currentTtsResult.wavBytes.length);
    this.updateChannelSelector(1);
    this.updateFilenamePreview();

    const btnEncode = document.getElementById('btn-clipstudio-encode') as HTMLButtonElement | null;
    if (btnEncode) btnEncode.disabled = false;
  }

  public switchToSubtab(target: 'convert' | 'tts' | 'editor'): void {
    const subTabs = document.querySelectorAll('.clipstudio-subtab');
    subTabs.forEach(tab => {
      if (tab.getAttribute('data-subtab') === target) tab.classList.add('active');
      else tab.classList.remove('active');
    });

    const pConvert = document.getElementById('panel-clipstudio-convert');
    const pTts = document.getElementById('panel-clipstudio-tts');
    const pEditor = document.getElementById('panel-clipstudio-editor');

    if (pConvert) pConvert.style.display = target === 'convert' ? 'block' : 'none';
    if (pTts) pTts.style.display = target === 'tts' ? 'block' : 'none';
    if (pEditor) {
      pEditor.style.display = target === 'editor' ? 'block' : 'none';
      if (target === 'editor') {
        AudioEditorController.getInstance().renderAll();
      }
    }
  }

  private handleTtsHandoffToEditor(): void {
    if (!this.currentTtsResult) return;
    const editor = AudioEditorController.getInstance();
    editor.openFromChannelData(
      [this.currentTtsResult.pcmFloat],
      this.currentTtsResult.sampleRate,
      `tts_${this.currentTtsResult.sampleRate}hz.wav`,
      16
    );
    this.switchToSubtab('editor');
  }

  private handleInputHandoffToEditor(): void {
    if (!this.currentInputAudio) return;
    const editor = AudioEditorController.getInstance();
    editor.openFromChannelData(
      this.currentInputAudio.channelData,
      this.currentInputAudio.sampleRate,
      this.currentInputAudio.fileName,
      16
    );
    this.switchToSubtab('editor');
  }

  public async loadFromExternalWav(wavBytes: Uint8Array, fileName: string): Promise<void> {
    try {
      this.currentInputBytes = wavBytes;
      const loaded = await RawAudioLoader.load(wavBytes, fileName);
      this.currentInputAudio = loaded;

      this.switchToSubtab('convert');
      this.displayInputSummary(loaded, wavBytes.length);
      this.updateChannelSelector(loaded.numChannels);
      this.updateFilenamePreview();

      const btnEncode = document.getElementById('btn-clipstudio-encode') as HTMLButtonElement | null;
      if (btnEncode) btnEncode.disabled = false;
    } catch (err) {
      console.error('[ClipStudio] Failed to load external audio into converter:', err);
    }
  }

  // TTS Waveform & Audio Player
  private setupTtsPlayerControls(): void {
    const btnPlay = document.getElementById('btn-tts-play');
    const canvas = document.getElementById('tts-waveform-canvas') as HTMLCanvasElement | null;

    if (btnPlay) {
      btnPlay.addEventListener('click', () => {
        if (this.ttsIsPlaying) {
          this.pauseTtsPlayback();
        } else {
          this.resumeTtsPlayback();
        }
      });
    }

    if (canvas) {
      canvas.addEventListener('click', (e) => {
        if (!this.currentTtsResult) return;
        const rect = canvas.getBoundingClientRect();
        const clickX = e.clientX - rect.left;
        const pct = Math.max(0, Math.min(1, clickX / rect.width));
        const timeSec = pct * this.currentTtsResult.durationSec;
        this.seekTtsTo(timeSec);
      });
    }
  }

  private resumeTtsPlayback(): void {
    if (!this.currentTtsResult) return;
    if (!this.ttsAudioCtx) {
      const AudioCtxClass = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ttsAudioCtx = new AudioCtxClass();
    }
    if (this.ttsAudioCtx.state === 'suspended') {
      this.ttsAudioCtx.resume();
    }
    this.playTtsFrom(this.ttsPausedAtTime);
  }

  private playTtsFrom(timeSec: number): void {
    if (!this.ttsAudioCtx || !this.currentTtsResult) return;

    const pcm = this.currentTtsResult.pcmFloat;
    const rate = this.currentTtsResult.sampleRate;
    const audioBuf = this.ttsAudioCtx.createBuffer(1, pcm.length, rate);
    audioBuf.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);

    this.ttsSourceNode = this.ttsAudioCtx.createBufferSource();
    this.ttsSourceNode.buffer = audioBuf;
    this.ttsSourceNode.connect(this.ttsAudioCtx.destination);

    this.ttsPlaybackStartTime = this.ttsAudioCtx.currentTime - timeSec;
    this.ttsSourceNode.start(0, timeSec);
    this.ttsIsPlaying = true;

    this.ttsSourceNode.onended = () => {
      if (this.ttsIsPlaying) this.stopTtsPlayback();
    };

    const btnPlay = document.getElementById('btn-tts-play');
    if (btnPlay) btnPlay.textContent = '⏸ Pause';

    this.startTtsAnimationLoop();
  }

  private pauseTtsPlayback(): void {
    if (!this.ttsIsPlaying) return;
    this.ttsPausedAtTime = this.getCurrentTtsPlaybackTime();
    this.stopTtsSourceOnly();
    this.ttsIsPlaying = false;

    const btnPlay = document.getElementById('btn-tts-play');
    if (btnPlay) btnPlay.textContent = '▶ Play';

    if (this.ttsAnimationFrameId !== null) {
      cancelAnimationFrame(this.ttsAnimationFrameId);
      this.ttsAnimationFrameId = null;
    }
  }

  private stopTtsPlayback(): void {
    this.stopTtsSourceOnly();
    this.ttsIsPlaying = false;
    this.ttsPausedAtTime = 0;

    const btnPlay = document.getElementById('btn-tts-play');
    if (btnPlay) btnPlay.textContent = '▶ Play';

    const elTime = document.getElementById('tts-play-time');
    if (elTime && this.currentTtsResult) {
      elTime.textContent = `0:00.0 / ${this.formatTime(this.currentTtsResult.durationSec)}`;
    } else if (elTime) {
      elTime.textContent = '0:00.0 / 0:00.0';
    }

    if (this.ttsAnimationFrameId !== null) {
      cancelAnimationFrame(this.ttsAnimationFrameId);
      this.ttsAnimationFrameId = null;
    }

    if (this.currentTtsResult) this.renderTtsWaveform(this.currentTtsResult.pcmFloat, 0);
  }

  private stopTtsSourceOnly(): void {
    if (this.ttsSourceNode) {
      try {
        this.ttsSourceNode.stop();
        this.ttsSourceNode.disconnect();
      } catch {
        // Ignored
      }
      this.ttsSourceNode = null;
    }
  }

  private seekTtsTo(timeSec: number): void {
    if (!this.currentTtsResult) return;
    const dur = this.currentTtsResult.durationSec;
    const clamped = Math.max(0, Math.min(dur, timeSec));
    this.ttsPausedAtTime = clamped;

    if (this.ttsIsPlaying) {
      this.stopTtsSourceOnly();
      this.playTtsFrom(clamped);
    } else {
      this.renderTtsWaveform(this.currentTtsResult.pcmFloat, clamped / (dur || 1));
    }
  }

  private getCurrentTtsPlaybackTime(): number {
    if (!this.ttsAudioCtx || !this.ttsIsPlaying) return this.ttsPausedAtTime;
    return this.ttsAudioCtx.currentTime - this.ttsPlaybackStartTime;
  }

  private startTtsAnimationLoop(): void {
    const update = () => {
      if (!this.ttsIsPlaying || !this.currentTtsResult) return;
      const cur = this.getCurrentTtsPlaybackTime();
      const dur = this.currentTtsResult.durationSec;

      const elTime = document.getElementById('tts-play-time');
      if (elTime) {
        elTime.textContent = `${this.formatTime(cur)} / ${this.formatTime(dur)}`;
      }

      this.renderTtsWaveform(this.currentTtsResult.pcmFloat, dur > 0 ? cur / dur : 0);
      this.ttsAnimationFrameId = requestAnimationFrame(update);
    };

    this.ttsAnimationFrameId = requestAnimationFrame(update);
  }

  private renderTtsWaveform(samples: Float32Array, progressPct = 0): void {
    const canvas = document.getElementById('tts-waveform-canvas') as HTMLCanvasElement | null;
    if (!canvas) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const width = canvas.width;
    const height = canvas.height;

    ctx.fillStyle = '#16161e';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
    ctx.beginPath();
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
    ctx.stroke();

    if (!samples || samples.length === 0) return;

    const step = Math.max(1, Math.floor(samples.length / width));
    const midY = height / 2;

    ctx.fillStyle = '#7aa2f7';
    for (let x = 0; x < width; x++) {
      let min = 1.0;
      let max = -1.0;
      const start = x * step;
      const end = Math.min(samples.length, start + step);

      for (let j = start; j < end; j++) {
        const val = samples[j];
        if (val < min) min = val;
        if (val > max) max = val;
      }

      const yTop = midY - max * (midY - 4);
      const yBottom = midY - min * (midY - 4);
      ctx.fillRect(x, yTop, 1, Math.max(1, yBottom - yTop));
    }

    if (progressPct > 0) {
      const playheadX = progressPct * width;
      ctx.fillStyle = '#f7768e';
      ctx.fillRect(playheadX - 1, 0, 2, height);
    }
  }
}
