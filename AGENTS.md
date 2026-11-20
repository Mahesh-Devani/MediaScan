# AGENTS.md — MediaScan System Blueprint & Developer Memory

> **Audience**: AI Agents (Antigravity, Cursor, Claude Code, Copilot, etc.) and Human Engineers.  
> **Repository**: [https://github.com/Mahesh-Devani/MediaScan](https://github.com/Mahesh-Devani/MediaScan)  
> **Primary Principle**: 100% Client-Side, Zero-Backend, Zero-Telemetry, Absolute Privacy. All packet capture parsing, audio decoding, video rendering, speech quality analysis, neural TTS synthesis, and audio editing execute locally in the browser and in background Web Workers.

---

## 1. System Overview & Technology Stack

MediaScan is an enterprise-grade, browser-native network media analyzer and telecom audio laboratory. It operates completely offline with zero server requirements.

- **Frontend & Runtime**: TypeScript (strict mode), Native ES Modules, HTML5, CSS3.
- **Build Tooling**: Vite 8+ (configured with COOP/COEP headers for `SharedArrayBuffer` support), Rollup/Rolldown, TypeScript (`tsc --noEmit`).
- **Test Framework**: Native Node.js Test Runner with experimental TypeScript strip (`node --experimental-strip-types --test`). Requires **Node.js >= 22.6.0** (Node 22 LTS or Node 24).
- **WebAssembly & Neural Inference**:
  - `onnxruntime-web` (SIMD + multi-threaded WebAssembly) running in Web Workers.
  - Microsoft DNSMOS neural models (`sig_bak_ovr.onnx`, `sig_bak_ovr_p.onnx`, `model_v8.onnx`).
  - Rhasspy Piper multilingual neural TTS models (ONNX) + eSpeak-ng G2P phonemizer WebAssembly (`piper_phonemize.wasm`).
  - 3GPP TS 26.445 reference EVS codec compiled to WebAssembly (`public/evs.wasm`).
  - OpenCORE AMR-NB and AMR-WB / vo-amrwbenc WebAssembly decoders.
- **Media Hardware Acceleration**: WebCodecs API (`VideoDecoder`) for real-time H.264 / VP8 depacketized stream playback.

---

## 2. Directory Structure & Module Architecture

```text
MediaScan/
├── .github/workflows/deploy.yml  # GitHub Actions CI/CD (tests, builds, publishes to GitHub Pages)
├── css/styles.css                # Pure CSS styling (dark theme, responsive layout, codec pills)
├── public/                       # Static runtime assets (vendored models & WASM binaries)
│   ├── evs.wasm                  # 3GPP TS 26.445 EVS Codec WebAssembly (8k, 16k, 32k, 48k)
│   ├── models/dnsmos/            # DNSMOS ONNX models (sig_bak_ovr, sig_bak_ovr_p, model_v8)
│   ├── voices/                   # Pre-packaged Piper TTS ONNX models & JSON configs (8 languages)
│   └── wasm/                     # ONNX Runtime WebAssembly & piper_phonemize G2P binaries
├── src/                          # TypeScript source code
│   ├── audio/                    # WAV/RF64 parser, RawAudioLoader, resamplers, MP4 box demuxer
│   ├── clipstudio/               # Clip Studio top-level tab
│   │   ├── ClipStudioController.ts # Coordinator, Codec Converter UI, TTS UI, A/B Monitor
│   │   └── editor/               # Audio Editor (PCM) GoldWave-style engine
│   │       ├── AudioBufferPool.ts    # Float32Array slab allocator with LRU caching
│   │       ├── AudioPieceTable.ts    # Immutable piece-table non-destructive edit list
│   │       ├── AudioDspEngine.ts     # Gain, peak & dBov normalization, fades, invert, reverse
│   │       ├── AudioMixer.ts         # Paste-Mix, crossfade, concatenation, soft-knee limiter
│   │       ├── AudioEditorLoader.ts  # WAV/raw PCM importer & 8/16/24/32-bit exporter
│   │       ├── EditorClipboard.ts    # Multi-tab shared clipboard with sinc resampling
│   │       ├── UndoRedoStack.ts      # Memory-capped undo/redo state manager
│   │       └── AudioEditorController.ts # Audio Editor UI controller & event coordinator
│   ├── codec/                    # CodecProfileRegistry, AudioPreprocessor (DC filter, highpass, norm)
│   ├── decoders/                 # RTP audio stream decoders (G.711, G.722, G.726, G.729, AMR, EVS)
│   ├── dnsmos/                   # DNSMOS speech quality engine, polynomial calibration, worker client
│   ├── encoders/                 # Raw clip encoders (G.711, G.722, G.726, G.729, AMR, EVS, Packager)
│   ├── ladder/                   # Media Flow Ladder SVG diagram renderer & anomaly detection
│   ├── media/                    # WavExporter, multi-track synchronized audio player, level meters
│   ├── mos/                      # E-model ITU-T G.107 MOS calculator, CodecConfigTable (G.113)
│   ├── pcap/                     # PCAP/PCAPNG parser, Ethernet, IPv4/IPv6, UDP, TCP, deduplication
│   ├── rtp/                      # RTP parsing, RFC 3550 jitter/loss/burst, RFC 4733 DTMF telephony events
│   ├── sip/                      # RFC 3261 SIP dialog state machine, RFC 4566 SDP offer/answer parser
│   ├── srtp/                     # RFC 3711 SRTP / RFC 4568 SDES unprotect engine, AES-CM-128, HMAC-SHA1
│   ├── tts/                      # Multilingual Piper neural TTS engine, TextNormalizer, VoiceRegistry
│   ├── video/                    # RFC 6184 H.264 & RFC 7741 VP8 depacketizers, MP4 ISO BMFF muxer
│   ├── workers/                  # Dedicated Web Workers (DNSMOS, TTS, Editor, SNR, LogParser)
│   └── main.ts                   # Application bootstrap, navigation, file drop handlers
├── test/                         # Node native unit tests (222+ tests)
│   ├── fixtures/                 # Golden PCAPs, reference clips, baseline snapshots
│   ├── baseline-snapshot.test.ts # Byte-identical regression golden tests
│   ├── codec-encoders.test.ts    # Telephony codec encoders, framing, EVS-NB/WB/SWB, packager
│   ├── dnsmos.test.ts            # DNSMOS calibration, golden parity, RTF benchmarks
│   ├── audio-editor-*.test.ts    # Piece table, DSP, mixer, clipboard, fidelity tests
│   └── ...                       # PCAP, SIP, SRTP, AMR, EVS, Video, MOS test suites
├── index.html                    # Single-page application HTML entry point
├── package.json                  # Scripts and dependencies
├── tsconfig.json                 # TypeScript compiler options
└── vite.config.ts                # Vite build configuration & server COOP/COEP headers
```

---

## 3. Top-Level Modules & Functional Tabs

MediaScan provides 6 major tabs in the top navigation bar:

1. **Media Flow Ladder**:
   - Visualizes end-to-end SIP signaling and bidirectional RTP streams on an interactive SVG ladder diagram.
   - Auto-detects media servers/gateways (with manual endpoint override).
   - Real-time anomaly detection: one-way audio, high packet loss, excessive jitter, and SDP port mismatches.
   - Inline DTMF keypad event badges on stream vectors; click-to-play directly from the ladder.

2. **SIP Dialogs & Signaling**:
   - RFC 3261 transaction engine correlating requests (`INVITE`, `ACK`, `BYE`, `CANCEL`, `INFO`, `OPTIONS`, `REGISTER`) and responses.
   - Session dialog correlation by `Call-ID`, tracking states from `Initial` &rarr; `Early` &rarr; `Confirmed` &rarr; `Terminated`.
   - Complete SDP offer/answer attribute inspection (`c=`, `m=`, `a=rtpmap`, `a=fmtp`, `a=ptime`, `a=sendrecv`/`sendonly`/`recvonly`).

3. **RTP Audio Streams & Multi-Track Player**:
   - Stream demuxing from PCAP/PCAPNG captures with packet deduplication (matching Wireshark `editcap -D 1500`).
   - RFC 3711 SRTP decryption supporting RFC 4568 SDES inline cryptographic contexts (`AES_CM_128_HMAC_SHA1_80`, rollover counter probe, and SRTCP unprotect).
   - Codec support: G.711 µ-law & A-law, G.722 SB-ADPCM, G.726 ADPCM, G.729, AMR-NB, AMR-WB, EVS (NB 8k, WB 16k, SWB 32k), and Opus.
   - Video playback: RFC 6184 H.264 (Single NAL, STAP-A, FU-A) and RFC 7741 VP8 with WebCodecs hardware decode and MP4 download.
   - Synchronized GoldWave-style multi-track waveform player with range selection, mute/solo, and multi-track WAV mixdown export.

4. **RTP Stream Metrics & Telemetry**:
   - RFC 3550 interarrival jitter, sequence loss, and Gilbert-Elliot burst loss density.
   - Passive ITU-T G.107 E-model transmission rating ($R$-factor) and MOS estimation (1.0 to 4.5).
   - ITU-T P.56 Active Speech Signal-to-Noise Ratio (SNR) sliding-window analysis with high-pass and A-weighting filters in a Web Worker.

5. **DNSMOS Tool (Standalone Audio File Scoring)**:
   - Direct audio file scoring (drag-and-drop WAV or raw codecs) without requiring a PCAP.
   - Microsoft DNSMOS P.835 deep neural model scoring Speech Quality (**SIG**), Background Noise (**BAK**), and Overall Quality (**OVRL**).
   - Multi-channel independent evaluation (Mono, Stereo, 5.1, 7.1) with spectral roll-off and silence detection.
   - Side-by-side comparison mode for evaluating noise suppression algorithms and transcoding degradation.

6. **Clip Studio (Telephony Speech & Codec Lab)**:
   - **Codec Raw-Clip Converter**:
     - Encodes audio into telephony bitstreams matching RTP generator (RTPG) conventions.
     - Supported profiles: G.711u (`.ulaw`), G.711a (`.alaw`), G.722 (`.722`), G.726 (`.g726`), AMR-NB (`.AMRr<rate>`, `.amr`), AMR-WB (`.AMRWBr<rate>`, `.awb`), EVS-NB (`.EVSNBr<rate>`, `.evs`), EVS-WB (`.EVSWBr<rate>`, `.evs`), EVS-SWB (`.EVSSWBr<rate>`, `.evs`), G.729 (`.729`).
     - Preprocessing: Channel downmix/selection, sinc resampling, DC offset removal, 70 Hz telecom high-pass, peak normalization (-1.0 dBFS), silence trim, and duration adjustment (pad/loop).
     - Synchronized A/B auditioning player with dual download options (Track [A] preprocessed WAV vs Track [B] raw encoded bitstream).
   - **Text-to-Speech (TTS) Studio**:
     - 100% client-side multilingual neural speech synthesis using Piper-compatible ONNX models.
     - Offline models pre-packaged for 8 languages: English (US), English (India / Commonwealth), Spanish, French, German, Turkish, Arabic, Polish.
     - Custom voice import (`.onnx` + `.json`) and live upstream HuggingFace voice catalog fetcher.
   - **Audio Editor (PCM)**:
     - GoldWave-style non-destructive audio editing using an immutable piece-table edit list ($O(\text{edits})$ manipulation).
     - Multi-clip tabs, multi-resolution peak pyramids, shared clipboard, undo/redo, mix/merge dialogs with soft-knee limiter, DSP operations (gain, normalize dBFS/dBov, fades, invert, reverse), telephony signal generators (sine, DTMF, call progress, calibrated noise), and seamless handoffs to DNSMOS/Converter.

---

## 4. Cross-Platform Transition: Moving to macOS / Linux

When transferring this workspace to another laptop (especially macOS):

### 4.1 Prerequisites
- **Node.js**: Install Node.js version **22 LTS** (or Node >= 22.6.0).  
  *On macOS*:
  ```bash
  # Using Homebrew:
  brew install node@22
  # Or using NVM (recommended):
  nvm install 22
  nvm use 22
  ```
- **Git**: Ensure Git is installed (`xcode-select --install` on macOS).

### 4.2 Installation & Startup
```bash
# 1. Enter repository
cd WebCapturedMediaAnalysis

# 2. Install dependencies cleanly
npm install

# 3. Start local development server
npm run dev
# Vite will serve at http://localhost:5173/
```

### 4.3 Key Platform Considerations for macOS
1. **Case-Sensitivity**: macOS typically uses APFS formatted case-insensitive (like Windows NTFS). However, Linux CI (GitHub Actions) runs on case-sensitive filesystems. Always ensure file import paths strictly match the file system casing (e.g., `EvsDecoder.ts`, not `evsDecoder.ts`).
2. **Line Endings**: Git may convert line endings (`CRLF` on Windows vs `LF` on macOS/Linux). The test suite and parsers use byte buffers (`Uint8Array`) and are immune to text line-ending differences, but keeping `LF` via git is standard.
3. **Web Audio Autoplay Policy**: Modern browsers on macOS (Safari, Chrome, Edge) block audio playback until an explicit user gesture (click or keypress) interacts with the page. MediaScan encapsulates all `AudioContext` resumption inside user-triggered button events (`play()`, `click`).
4. **SharedArrayBuffer Security Headers**: `onnxruntime-web` and multi-threaded WASM require cross-origin isolation. Vite is pre-configured with:
   ```ts
   headers: {
     'Cross-Origin-Opener-Policy': 'same-origin',
     'Cross-Origin-Embedder-Policy': 'require-corp',
   }
   ```
   Do not disable these headers when running a custom preview server.
5. **Safari WebCodecs & Audio**: Chrome, Edge, and Firefox provide the most consistent SIMD WebAssembly performance for neural models. On macOS, Chrome or Brave is recommended for optimal DNSMOS and Piper TTS throughput.

---

## 5. Development, Verification & Testing Workflow

### 5.1 Commands
- `npm run dev`: Starts Vite local development server on `http://localhost:5173`.
- `npm test`: Runs the complete Node.js unit test suite (222+ tests) using `node --experimental-strip-types --test`.
- `npm run build`: Type-checks with `tsc --noEmit` and bundles the production distribution with Vite into `dist/`.
- `npm run preview`: Previews the compiled `dist/` production build locally.

### 5.2 Mandatory Non-Regression Rules
Whenever modifying code:
1. **Baseline Snapshot Identity**: `test/fixtures/baseline/baseline-snapshot.json` represents the golden reference for PCAP and unencrypted RTP analysis. Run `node --experimental-strip-types --test test/baseline-snapshot.test.ts` to ensure 100% byte-for-byte fidelity.
2. **Native Sample Rate Preservation**: Codec inputs and imports must preserve the native file sample rate. Avoid decoding audio through browser `AudioContext.decodeAudioData` where the browser silently resamples audio to the hardware output rate (e.g. 48,000 Hz). Always use `WavParser.parse()` for WAV containers.
3. **Web Worker Isolation**: Heavy DSP, ONNX neural inference, audio resampling, and peak pyramid calculations must remain off the main UI thread in dedicated Web Workers.

---

## 6. Offline Models & Vendored Assets Reference

All assets required for 100% offline operation are committed directly into `public/`:

| File Path | Size | Purpose & License |
| :--- | :--- | :--- |
| `public/evs.wasm` | ~2.0 MB | 3GPP TS 26.445 EVS Reference Codec (NB, WB, SWB, FB up to 48 kHz). |
| `public/models/dnsmos/sig_bak_ovr.onnx` | ~1.1 MB | Microsoft DNSMOS P.835 primary model (CC-BY-4.0). |
| `public/models/dnsmos/sig_bak_ovr_p.onnx` | ~1.1 MB | Microsoft DNSMOS P.835 personalized model (CC-BY-4.0). |
| `public/models/dnsmos/model_v8.onnx` | ~225 KB | Microsoft DNSMOS P.808 overall quality model (CC-BY-4.0). |
| `public/voices/*.onnx` (8 models) | ~63 MB ea | Rhasspy Piper neural voices for US English, UK/IN English, Spanish, French, German, Turkish, Arabic, Polish. |
| `public/wasm/piper_phonemize.*` | ~18 MB | eSpeak-ng G2P phonemizer data & WebAssembly (GPLv3 / Apache 2.0). |
| `public/wasm/ort-wasm-simd-threaded.*` | ~29 MB | ONNX Runtime Web SIMD multi-threaded WebAssembly engine (MIT). |

---

## 7. Current Project State & Audio Editor Roadmap

- **Completed**:
  - Full PCAP/PCAPNG dissection, SIP dialog analysis, Media Flow Ladder, SRTP/SDES decryption.
  - Multi-track synchronized audio player, E-model ITU-T G.107 MOS, ITU-T P.56 active speech SNR.
  - Standalone DNSMOS speech quality evaluation tool with multi-channel and multi-row comparison.
  - Clip Studio Codec Converter supporting G.711, G.722, G.726, G.729, AMR-NB, AMR-WB, EVS-NB, EVS-WB, and EVS-SWB with track A/B monitoring.
  - Clip Studio Text-to-Speech Studio with 8 offline neural voices and upstream HuggingFace fetcher.
  - Audio Editor foundational engines: `AudioPieceTable.ts`, `AudioBufferPool.ts`, `AudioDspEngine.ts`, `AudioMixer.ts`, `EditorClipboard.ts`, `UndoRedoStack.ts`, `AudioEditorLoader.ts`, and full unit test suites.
- **Next Phase for Audio Editor**:
  - Full UI wiring of canvas multi-resolution waveform rendering (using `editor.worker.ts` peak pyramids).
  - AudioWorklet / chunked buffer streaming playback directly from the piece table without requiring a full audio re-render.
  - Drag-selection and zero-crossing snapping on the interactive canvas timeline.
