# MediaScan

> **100% Client-Side, Zero-Backend PCAP / PCAPNG Media Analyzer, RTP Decoder & Media Flow Ladder**

MediaScan is a high-performance, browser-native web application for analyzing, visualizing, decoding, and diagnosing VoIP and multimedia network captures. It runs entirely inside your browser using WebAssembly and WebCodecs—**zero backend, zero telemetry, and zero packet data leaves your machine**.

---

## Key Capabilities

### 1. Zero-Backend PCAP & PCAPNG Dissection
- **Capture Containers**: Supports classic PCAP (little-endian & big-endian; microsecond & nanosecond timestamps) and PCAPNG.
- **Link Layer**: Ethernet (LinkType 1), 802.1Q VLAN tags, Linux Cooked Mode v1 (SLL, LinkType 113) and v2 (SLL2, LinkType 276).
- **Network & Transport**: Full IPv4 and IPv6 dissector with RFC 5952 canonical formatting, UDP, and TCP.
- **Deduplication**: In-flight rolling-window deduplication matching Wireshark `editcap -D 1500`.

### 2. SIP & SDP Signaling Engine
- **RFC 3261 Transactions**: Parses SIP requests (`INVITE`, `ACK`, `BYE`, `CANCEL`, `INFO`, `OPTIONS`, `REGISTER`) and responses (`100`, `180`, `183`, `200 OK`).
- **RFC 4566 SDP Offer/Answer**: Extracts `c=`, `m=`, `a=rtpmap`, `a=fmtp`, `a=ptime`, `a=sendrecv`/`sendonly`/`recvonly`/`inactive`.
- **Dialog Session State**: Correlates sessions by `Call-ID`, tracking states from `Initial` to `Early`, `Confirmed`, and `Terminated`.

### 3. Interactive Media Flow Ladder
- **Media Server Auto-Detection**: Automatically identifies the common media server endpoint, with an interactive dropdown to pin or override.
- **Leg Correlation**: Maps RTP media streams directly to corresponding SIP dialogs and participants.
- **Conversation Grouping**: Correlates calls into Bridged (2-leg) or Conference (3+ leg) sessions.
- **Interactive SVG Ladder**:
  - Vertical lifelines for Media Server and client endpoints.
  - Color-coded stream bars by codec family.
  - In-line diagnostic badges: One-way media, high packet loss, excessive jitter, and SDP port mismatches.
  - Direct click-to-play from any stream arrow on the ladder diagram.

### 4. Multi-Track Synchronized Audio Player
- **Interactive Waveforms**: Per-stream amplitude waveforms with synchronized timeline, scrubbing playhead, and time displays.
- **GoldWave-Style Range Selection**: Drag across tracks to highlight and loop specific time regions.
- **Channel Isolation**: Individual track mute and solo controls, plus quick presets (Inbound Only, Outbound Only, Unmute All).
- **Exporting Options**:
  - Single-stream 16-bit linear PCM WAV.
  - Multi-track synchronized mixed WAV.
  - Time-selection mixed WAV.
  - Dual-channel Stereo Call Mix (Caller Left, Callee Right).

### 5. Multi-Codec Audio & Video Support
- **G.711 u-law & a-law (PCMU / PCMA)**: Pure JavaScript bit-exact decoding to 16-bit linear PCM.
- **G.722 SB-ADPCM**: 16 kHz wideband audio decoder bit-exact against ITU-T specifications.
- **AMR-NB & AMR-WB**: RFC 4867 depacketization (octet-aligned and bandwidth-efficient) and WASM decoding.
- **EVS (Enhanced Voice Services)**: 3GPP TS 26.445 depacketizer for both Compact and Header-Full (EVS-HF) streams across NB (8 kHz), WB (16 kHz), and SWB (32 kHz).
- **H.264 Video (RFC 6184)**: Depacketization of Single NAL, STAP-A aggregation, and FU-A fragmentation units with hardware-accelerated WebCodecs playback and client-side ISO BMFF MP4 container muxing.
- **VP8 Video (RFC 7741)**: Unpacking into IVF containers with hardware-accelerated playback.
- **DTMF (RFC 4733 / RFC 2833)**: Telephone-event detection, volume/duration metrics, Web Audio tone synthesizer, and visual badges.

### 6. Speech Signal-to-Noise Ratio (SNR) Analysis
- **ITU-T P.56 Active Speech Level Estimation**: Calculates digital speech level (dBFS) and background noise floor.
- **Audio Pre-Conditioning**: High-pass filtering (80 Hz Butterworth) and standard acoustic A-weighting curve filters.
- **Sliding-Window Timeline**: Time-windowed SNR timeline to inspect dynamic noise variations over call duration.
- **Off-Main-Thread Execution**: Offloaded to a dedicated Web Worker to ensure UI responsiveness.

### 7. Audio Quality: Estimated MOS (E-model ITU-T G.107)
- **Passive Network E-model**: Estimates transmission rating factor $R$ and Mean Opinion Score (MOS: 1.0 to 4.5) per audio stream.
- **Network Impairments**: Sequence-based packet loss, RFC 3550 interarrival jitter, Gilbert loss burst ratio, and playout jitter-buffer delay/late discards.
- **Delay Impairment ($I_d$)**: Supports true RTCP SR/RR/XR round-trip time and user delay assumptions.
- **Editable Codec Parameters**: Built-in ITU-T G.113 Appendix I parameters for G.711, G.722, G.729, AMR, AMR-WB, EVS, Opus, iLBC, and Speex.

### 8. Audio Quality: DNSMOS (estimated) Speech Quality
- **Microsoft DNSMOS P.835**: Deep neural network model predicting human perceptual ratings for Speech Signal Quality (**SIG**), Background Noise Intrusion (**BAK**), and Overall Quality (**OVRL**).
- **Optional P.808 Model**: Overall conversational listening quality estimation via mel-spectrogram front-end.
- **Noise Reduction Assessment**: Input vs. Output leg comparison tool identifying over-suppression ("BAK up, SIG down") or ineffective noise reduction.
- **100% Client-Side ONNX Runtime**: Uses `onnxruntime-web` in a dedicated Web Worker with vendored offline models.

### 9. Standalone DNSMOS Tool (No PCAP Required)
- **Direct Audio File Scoring**: Score audio files directly via drag-and-drop without needing a network packet capture.
- **Broad Format Support**: Parses standard & extensible WAV (PCM 8/16/24/32-bit int, 32/64-bit IEEE float, A-law, $\mu$-law, IMA/MS ADPCM), raw G.711, G.722, G.726, G.729, AMR-NB/WB, Opus, MP3, AAC, FLAC.
- **Multi-Channel & Bandwidth Telemetry**: Evaluates each channel independently (Mono, Stereo, 5.1, 7.1) with RMS and Peak dBFS reporting, silent channel detection, and spectral roll-off bandwidth estimation.
- **Side-by-Side Comparison**: Multi-row comparison mode with $\Delta$ score metrics, rate/codec mismatch warnings, and overlaid timeline waveforms.

---

## Attributions & Third-Party Licenses

- **Microsoft DNSMOS (Deep Noise Suppression Challenge)**:
  - Official Repository: [https://github.com/microsoft/DNS-Challenge](https://github.com/microsoft/DNS-Challenge)
  - Models (`sig_bak_ovr.onnx`, `sig_bak_ovr_p.onnx`, `model_v8.onnx`) and polynomial fitting equations licensed under [Creative Commons Attribution 4.0 International (CC-BY-4.0)](https://creativecommons.org/licenses/by/4.0/).
  - © Microsoft Corporation.
  - References:
    - C. K. A. Reddy, V. Gopal, R. Cutler, *"DNSMOS: A Non-Intrusive Perceptual Objective Speech Quality Metric to Evaluate Noise Suppressors"*, ICASSP 2021.
    - C. K. A. Reddy, V. Gopal, R. Cutler, et al., *"DNSMOS P.835: A Non-Intrusive Perceptual Objective Speech Quality Metric to Evaluate Noise Suppressors"*, ICASSP 2022.
- **ONNX Runtime Web**: Licensed under the MIT License by Microsoft Corporation.
- **EVS Codec WASM**: Standard 3GPP TS 26.445 decoder compiled to WebAssembly.

---

## Quick Start

### Installation
```bash
git clone https://github.com/<your-username>/MediaScan.git
cd MediaScan
npm install
```

### Development Server
```bash
npm run dev
```

### Running Test Suite
```bash
npm test
```

### Production Build
```bash
npm run build
npm run preview
```

The compiled application is generated in `dist/` and can be hosted statically on any web server or GitHub Pages.

---

## Deploying to GitHub Pages

This repository includes a turnkey GitHub Actions workflow (`.github/workflows/deploy.yml`).

To enable GitHub Pages:
1. Push your repository to GitHub.
2. In your repository on GitHub, navigate to **Settings** &rarr; **Pages**.
3. Under **Build and deployment** &rarr; **Source**, select **GitHub Actions**.
4. Pushes to `main` (or `master`) will automatically build and publish the live app at `https://<your-username>.github.io/MediaScan/`.

---

## Privacy & Security

All media analysis, PCAP dissection, audio decoding, and video playback take place strictly inside the user's web browser using client-side JavaScript, WebCodecs, and WebAssembly. No network packets or audio/video contents are transmitted over the network.
