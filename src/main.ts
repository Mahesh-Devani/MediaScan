import { CapturePipeline } from './CapturePipeline.ts';
import type { PipelineResult } from './CapturePipeline.ts';
import { StreamAudioDecoder } from './decoders/StreamAudioDecoder.ts';
import { AudioPlayback } from './media/AudioPlayback.ts';
import { WavExporter } from './media/WavExporter.ts';
import { LadderSvgRenderer } from './ladder/LadderSvgRenderer.ts';
import { MultiTrackPlayer } from './media/MultiTrackPlayer.ts';
import { MultiTrackRenderer } from './media/MultiTrackRenderer.ts';
import { SnrUiController } from './analysis/SnrUiController.ts';
import { MosUiController } from './mos/MosUiController.ts';
import { DnsmosUiController } from './dnsmos/DnsmosUiController.ts';
import { VideoDecoderPlayer } from './video/VideoDecoderPlayer.ts';
import type { RtpStream } from './rtp/RtpDemuxer.ts';

// State
let pipelineResult: PipelineResult | null = null;
let currentPcapBytes: Uint8Array | null = null;
let activeStream: RtpStream | null = null;
let activePcm16: Int16Array | null = null;
let activeSampleRate: number = 8000;
let activeCodecName: string = 'PCM';
let waveformPeaks: number[] = [];
const audioPlayer = new AudioPlayback();
const multiTrackPlayer = new MultiTrackPlayer();
const videoPlayer = new VideoDecoderPlayer();
let isMtSessionLoaded = false;
let isMtScrubbing = false;
let mtHoverSec: number | null = null;

// DOM Elements
const dropzoneArea = document.getElementById('dropzone-area')!;
const dropzone = document.getElementById('dropzone')!;
const fileInput = document.getElementById('file-input') as HTMLInputElement;
const btnOpenFile = document.getElementById('btn-open-file')!;
const btnSelectFile = document.getElementById('btn-select-file')!;
const dashboard = document.getElementById('dashboard')!;
const msControl = document.getElementById('ms-control')!;
const msSelect = document.getElementById('ms-select') as HTMLSelectElement;
const conversationSelect = document.getElementById('conversation-select') as HTMLSelectElement;
const conversationBadge = document.getElementById('conversation-badge')!;
const ladderContainer = document.getElementById('ladder-svg-container')!;
const sipTbody = document.getElementById('sip-tbody')!;
const rtpTbody = document.getElementById('rtp-tbody')!;

// Multi-Track Player Elements
const mtCanvas = document.getElementById('multitrack-canvas') as HTMLCanvasElement;
const btnMtTogglePlay = document.getElementById('btn-mt-toggle-play')!;
const btnMtSkipBackward = document.getElementById('btn-mt-skip-backward');
const btnMtSkipForward = document.getElementById('btn-mt-skip-forward');
const mtCurrentTime = document.getElementById('mt-current-time')!;
const mtTotalDuration = document.getElementById('mt-total-duration')!;
const mtVolumeSlider = document.getElementById('mt-volume-slider') as HTMLInputElement;
const btnMtExportMix = document.getElementById('btn-mt-export-mix')!;
const mtTracksGutter = document.getElementById('mt-tracks-gutter')!;
const mtTrackCount = document.getElementById('mt-track-count')!;
const mtConversationSelect = document.getElementById('mt-conversation-select') as HTMLSelectElement | null;
const mtSortSelect = document.getElementById('mt-sort-select') as HTMLSelectElement | null;
const metricsConvSelect = document.getElementById('metrics-conv-select') as HTMLSelectElement | null;
const btnMtFilterAll = document.getElementById('btn-mt-filter-all');
const btnMtFilterIn = document.getElementById('btn-mt-filter-in');
const btnMtFilterOut = document.getElementById('btn-mt-filter-out');
const btnMtMuteAll = document.getElementById('btn-mt-mute-all');
const mtSelectionBadge = document.getElementById('mt-selection-badge');
const mtSelectionRange = document.getElementById('mt-selection-range');
const btnMtClearSel = document.getElementById('btn-mt-clear-sel');
const chkMtLoop = document.getElementById('chk-mt-loop') as HTMLInputElement | null;

// Player Dock Elements
const playerDock = document.getElementById('player-dock')!;
const playerTitle = document.getElementById('player-stream-title')!;
const playerMeta = document.getElementById('player-stream-meta')!;
const btnTogglePlay = document.getElementById('btn-toggle-play')!;
const btnSkipBackward = document.getElementById('btn-skip-backward');
const btnSkipForward = document.getElementById('btn-skip-forward');
const btnVolumeIcon = document.getElementById('btn-volume-icon');
const canvasWaveform = document.getElementById('waveform') as HTMLCanvasElement;
const playerCurrentTime = document.getElementById('player-current-time')!;
const playerDuration = document.getElementById('player-duration')!;
const volumeSlider = document.getElementById('volume-slider') as HTMLInputElement;
const chkFillSilence = document.getElementById('chk-fill-silence') as HTMLInputElement | null;
const btnDownloadWav = document.getElementById('btn-download-wav')!;
const btnDownloadAllWav = document.getElementById('btn-download-all-wav')!;
const btnClosePlayerDock = document.getElementById('btn-close-player-dock');
let activePlayRequestId = 0;
let previousVolume = 0.8;
let isLadderPlayerVisible = false;

// Video Player Modal Elements
const videoModal = document.getElementById('video-modal');
const videoCanvas = document.getElementById('video-canvas') as HTMLCanvasElement | null;
const videoStreamTitle = document.getElementById('video-stream-title');
const videoStreamMeta = document.getElementById('video-stream-meta');
const btnCloseVideoModal = document.getElementById('btn-close-video-modal');
const btnVideoTogglePlay = document.getElementById('btn-video-toggle-play');
const btnVideoDownloadRaw = document.getElementById('btn-video-download-raw');
const btnVideoDownloadMp4 = document.getElementById('btn-video-download-mp4');

if (btnCloseVideoModal) {
  btnCloseVideoModal.addEventListener('click', () => {
    videoPlayer.stop();
    videoPlayer.closeDecoder();
    if (videoModal) videoModal.style.display = 'none';
  });
}

if (btnVideoDownloadRaw) {
  btnVideoDownloadRaw.addEventListener('click', () => {
    const raw = videoPlayer.exportRawBitstream();
    if (raw) {
      downloadBlob(raw.data, raw.filename, 'application/octet-stream');
    }
  });
}

if (btnVideoDownloadMp4) {
  btnVideoDownloadMp4.addEventListener('click', () => {
    const container = videoPlayer.exportContainerFile();
    if (container) {
      downloadBlob(container.data, container.filename, container.mimeType);
    }
  });
}

// Initialize Audio Quality Controllers (SNR, Estimated MOS, DNSMOS)
SnrUiController.init();
MosUiController.initialize(() => renderLadder());
DnsmosUiController.init();

// Sub-Tab Switching for Audio Quality Analysis: Estimated MOS (E-model) vs SNR Analysis vs DNSMOS (estimated)
const btnTabMos = document.getElementById('btn-tab-mos');
const btnTabSnr = document.getElementById('btn-tab-snr');
const btnTabDnsmos = document.getElementById('btn-tab-dnsmos');
const mosPanel = document.getElementById('mos-panel');
const snrPanel = document.getElementById('snr-panel');
const dnsmosPanel = document.getElementById('dnsmos-panel');

if (btnTabMos && btnTabSnr && btnTabDnsmos && mosPanel && snrPanel && dnsmosPanel) {
  btnTabMos.addEventListener('click', () => {
    btnTabMos.classList.add('active');
    btnTabSnr.classList.remove('active');
    btnTabDnsmos.classList.remove('active');
    btnTabMos.style.background = 'rgba(42, 195, 222, 0.2)';
    btnTabMos.style.borderColor = '#2ac3de';
    btnTabMos.style.color = '#2ac3de';
    btnTabSnr.style.background = 'transparent';
    btnTabSnr.style.borderColor = 'var(--border)';
    btnTabSnr.style.color = 'var(--text-dim)';
    btnTabDnsmos.style.background = 'transparent';
    btnTabDnsmos.style.borderColor = 'var(--border)';
    btnTabDnsmos.style.color = 'var(--text-dim)';
    mosPanel.style.display = 'flex';
    snrPanel.style.display = 'none';
    dnsmosPanel.style.display = 'none';
    MosUiController.render();
  });

  btnTabSnr.addEventListener('click', () => {
    btnTabSnr.classList.add('active');
    btnTabMos.classList.remove('active');
    btnTabDnsmos.classList.remove('active');
    btnTabSnr.style.background = 'rgba(122, 162, 247, 0.2)';
    btnTabSnr.style.borderColor = '#7aa2f7';
    btnTabSnr.style.color = '#7aa2f7';
    btnTabMos.style.background = 'transparent';
    btnTabMos.style.borderColor = 'var(--border)';
    btnTabMos.style.color = 'var(--text-dim)';
    btnTabDnsmos.style.background = 'transparent';
    btnTabDnsmos.style.borderColor = 'var(--border)';
    btnTabDnsmos.style.color = 'var(--text-dim)';
    snrPanel.style.display = 'flex';
    mosPanel.style.display = 'none';
    dnsmosPanel.style.display = 'none';
  });

  btnTabDnsmos.addEventListener('click', () => {
    btnTabDnsmos.classList.add('active');
    btnTabMos.classList.remove('active');
    btnTabSnr.classList.remove('active');
    btnTabDnsmos.style.background = 'rgba(187, 154, 247, 0.2)';
    btnTabDnsmos.style.borderColor = '#bb9af7';
    btnTabDnsmos.style.color = '#bb9af7';
    btnTabMos.style.background = 'transparent';
    btnTabMos.style.borderColor = 'var(--border)';
    btnTabMos.style.color = 'var(--text-dim)';
    btnTabSnr.style.background = 'transparent';
    btnTabSnr.style.borderColor = 'var(--border)';
    btnTabSnr.style.color = 'var(--text-dim)';
    dnsmosPanel.style.display = 'flex';
    mosPanel.style.display = 'none';
    snrPanel.style.display = 'none';
    DnsmosUiController.render();
  });
}

// Tab switching
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => (c as HTMLElement).style.display = 'none');
    tab.classList.add('active');
    const targetId = tab.getAttribute('data-tab')!;
    document.getElementById(targetId)!.style.display = 'block';

    if (targetId === 'tab-rtp') {
      // RTP Audio Streams tab: unified multi-track player takes over; hide single stream dock
      audioPlayer.stop();
      playerDock.style.display = 'none';
      renderMultiTrackView();
    } else if (targetId === 'tab-metrics') {
      // RTP Stream Metrics & Telemetry tab
      multiTrackPlayer.pause();
      renderRtpTable();
    } else if (targetId === 'tab-ladder') {
      multiTrackPlayer.pause();
      if (isLadderPlayerVisible && activeStream) {
        playerDock.style.display = 'flex';
        btnTogglePlay.textContent = '\u25B6';
      } else {
        playerDock.style.display = 'none';
      }
    } else {
      // SIP Dialogs & other tabs: keep dock hidden and audio stopped/paused
      audioPlayer.stop();
      multiTrackPlayer.pause();
      playerDock.style.display = 'none';
    }
  });
});

// File opening
btnOpenFile.addEventListener('click', () => fileInput.click());
btnSelectFile.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (file) handleFile(file);
});

// Drag and drop
dropzone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropzone.classList.add('dragover');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  const file = e.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

async function handleFile(file: File) {
  const arrayBuffer = await file.arrayBuffer();
  currentPcapBytes = new Uint8Array(arrayBuffer);
  runAnalysis();
}

function runAnalysis(pinnedMsIp?: string) {
  if (!currentPcapBytes) return;

  isLadderPlayerVisible = false;
  playerDock.style.display = 'none';
  audioPlayer.stop();
  multiTrackPlayer.pause();

  pipelineResult = CapturePipeline.process(currentPcapBytes, pinnedMsIp);

  // Switch UI to dashboard
  dropzoneArea.style.display = 'none';
  dashboard.style.display = 'flex';
  msControl.style.display = 'flex';

  populateMediaServerSelect(pinnedMsIp);
  MosUiController.setData(
    pipelineResult.streams,
    pipelineResult.dialogs,
    pipelineResult.legs,
    pipelineResult.conversations
  );
  populateConversations();
  renderSipTable();
  renderRtpTable();
  loadMultiTrackSession();
}

function populateMediaServerSelect(currentPinned?: string) {
  if (!pipelineResult) return;
  msSelect.innerHTML = '';

  const detectedIp = pipelineResult.mediaServer?.ip || '';

  const optDetected = document.createElement('option');
  optDetected.value = detectedIp;
  optDetected.textContent = `${detectedIp} (Auto-detected)`;
  optDetected.selected = !currentPinned || currentPinned === detectedIp;
  msSelect.appendChild(optDetected);

  // Populate other IP candidates
  const allIps = new Set<string>();
  pipelineResult.streams.forEach(s => {
    allIps.add(s.dstIp);
    allIps.add(s.srcIp);
  });

  allIps.forEach(ip => {
    if (ip !== detectedIp) {
      const opt = document.createElement('option');
      opt.value = ip;
      opt.textContent = ip;
      if (currentPinned === ip) opt.selected = true;
      msSelect.appendChild(opt);
    }
  });

  msSelect.onchange = () => {
    runAnalysis(msSelect.value);
  };
}

function populateConversations() {
  if (!pipelineResult) return;
  conversationSelect.innerHTML = '';
  if (mtConversationSelect) mtConversationSelect.innerHTML = '';
  if (metricsConvSelect) metricsConvSelect.innerHTML = '';

  // Determine default conversation: latest conversation that has actual media streams/packets
  let defaultIdx = -1;
  for (let i = pipelineResult.conversations.length - 1; i >= 0; i--) {
    const conv = pipelineResult.conversations[i];
    const hasMedia = conv.legs.some(l =>
      (l.inboundStream && l.inboundStream.packetCount > 0) ||
      (l.outboundStream && l.outboundStream.packetCount > 0)
    );
    if (hasMedia) {
      defaultIdx = i;
      break;
    }
  }
  if (defaultIdx === -1 && pipelineResult.conversations.length > 0) {
    defaultIdx = 0;
  }

  // Populate ladder conversationSelect
  pipelineResult.conversations.forEach((conv, idx) => {
    const opt = document.createElement('option');
    opt.value = String(idx);
    const mediaPktCount = conv.legs.reduce((acc, l) => {
      const inPkts = l.inboundStream ? l.inboundStream.packetCount : 0;
      const outPkts = l.outboundStream ? l.outboundStream.packetCount : 0;
      return acc + inPkts + outPkts;
    }, 0);
    const mediaTag = mediaPktCount > 0 ? ` [${mediaPktCount} pkts]` : ' [No Media]';
    opt.textContent = `${conv.id} (${conv.classification}, ${conv.legs.length} legs)${mediaTag}`;
    conversationSelect.appendChild(opt);
  });

  if (defaultIdx >= 0) {
    conversationSelect.value = String(defaultIdx);
  }

  // Populate mtConversationSelect (with "All Streams" option)
  if (mtConversationSelect) {
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'All Conversations / All Streams';
    mtConversationSelect.appendChild(optAll);

    pipelineResult.conversations.forEach((conv, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const mediaPktCount = conv.legs.reduce((acc, l) => {
        const inPkts = l.inboundStream ? l.inboundStream.packetCount : 0;
        const outPkts = l.outboundStream ? l.outboundStream.packetCount : 0;
        return acc + inPkts + outPkts;
      }, 0);
      const mediaTag = mediaPktCount > 0 ? ` [${mediaPktCount} pkts]` : ' [No Media]';
      opt.textContent = `${conv.id} (${conv.legs.length} legs)${mediaTag}`;
      mtConversationSelect.appendChild(opt);
    });

    if (defaultIdx >= 0) {
      mtConversationSelect.value = String(defaultIdx);
    } else {
      mtConversationSelect.value = 'all';
    }
  }

  // Populate metricsConvSelect
  if (metricsConvSelect) {
    const optAll = document.createElement('option');
    optAll.value = 'all';
    optAll.textContent = 'All Streams';
    metricsConvSelect.appendChild(optAll);

    pipelineResult.conversations.forEach((conv, idx) => {
      const opt = document.createElement('option');
      opt.value = String(idx);
      const mediaPktCount = conv.legs.reduce((acc, l) => {
        const inPkts = l.inboundStream ? l.inboundStream.packetCount : 0;
        const outPkts = l.outboundStream ? l.outboundStream.packetCount : 0;
        return acc + inPkts + outPkts;
      }, 0);
      const mediaTag = mediaPktCount > 0 ? ` [${mediaPktCount} pkts]` : ' [No Media]';
      opt.textContent = `${conv.id} (${conv.legs.length} legs)${mediaTag}`;
      metricsConvSelect.appendChild(opt);
    });

    if (defaultIdx >= 0) {
      metricsConvSelect.value = String(defaultIdx);
    } else {
      metricsConvSelect.value = 'all';
    }
  }

  // Synchronized event listeners
  conversationSelect.onchange = () => {
    const val = conversationSelect.value;
    if (mtConversationSelect && mtConversationSelect.value !== val) {
      mtConversationSelect.value = val;
      multiTrackPlayer.setConversationFilter(val);
      renderMultiTrackView();
      if (pipelineResult) {
        SnrUiController.setTracks(multiTrackPlayer.getTracks(), pipelineResult);
        DnsmosUiController.setData(multiTrackPlayer.getTracks(), pipelineResult);
      }
    }
    if (metricsConvSelect && metricsConvSelect.value !== val) {
      metricsConvSelect.value = val;
      renderRtpTable();
    }
    renderLadder();
  };

  if (mtConversationSelect) {
    mtConversationSelect.onchange = () => {
      const val = mtConversationSelect.value;
      multiTrackPlayer.setConversationFilter(val);
      if (val !== 'all') {
        if (conversationSelect.value !== val) {
          conversationSelect.value = val;
          renderLadder();
        }
        if (metricsConvSelect && metricsConvSelect.value !== val) {
          metricsConvSelect.value = val;
          renderRtpTable();
        }
      }
      renderMultiTrackView();
      if (pipelineResult) {
        SnrUiController.setTracks(multiTrackPlayer.getTracks(), pipelineResult);
        DnsmosUiController.setData(multiTrackPlayer.getTracks(), pipelineResult);
      }
    };
  }

  if (metricsConvSelect) {
    metricsConvSelect.onchange = () => {
      const val = metricsConvSelect.value;
      if (val !== 'all') {
        if (conversationSelect.value !== val) {
          conversationSelect.value = val;
          renderLadder();
        }
        if (mtConversationSelect && mtConversationSelect.value !== val) {
          mtConversationSelect.value = val;
          multiTrackPlayer.setConversationFilter(val);
          renderMultiTrackView();
          if (pipelineResult) {
            SnrUiController.setTracks(multiTrackPlayer.getTracks(), pipelineResult);
            DnsmosUiController.setData(multiTrackPlayer.getTracks(), pipelineResult);
          }
        }
      }
      renderRtpTable();
    };
  }

  if (mtSortSelect) {
    mtSortSelect.onchange = () => {
      const order = mtSortSelect.value as 'leg-pairs' | 'in-first' | 'out-first' | 'chronological';
      multiTrackPlayer.setSortOrder(order);
      renderMultiTrackView();
    };
  }

  const chkDetectAnomalies = document.getElementById('chk-detect-anomalies') as HTMLInputElement | null;
  if (chkDetectAnomalies) {
    chkDetectAnomalies.onchange = () => renderLadder();
  }
  const chkSipEvents = document.getElementById('chk-sip-events') as HTMLInputElement | null;
  if (chkSipEvents) {
    chkSipEvents.onchange = () => renderLadder();
  }
  const chkShowDtmf = document.getElementById('chk-show-dtmf') as HTMLInputElement | null;
  if (chkShowDtmf) {
    chkShowDtmf.onchange = () => {
      renderLadder();
      renderMultiTrackView();
    };
  }
  const chkShowMos = document.getElementById('chk-show-mos') as HTMLInputElement | null;
  if (chkShowMos) {
    chkShowMos.onchange = () => renderLadder();
  }

  renderLadder();
}

function renderLadder() {
  if (!pipelineResult || pipelineResult.conversations.length === 0) {
    ladderContainer.innerHTML = '<p style="color: var(--text-muted); padding: 20px;">No conversations detected.</p>';
    return;
  }

  const convIdx = parseInt(conversationSelect.value, 10) || 0;
  const conv = pipelineResult.conversations[convIdx] || pipelineResult.conversations[0];

  conversationBadge.textContent = `${conv.classification} (${conv.legs.length} legs)`;

  const msIp = pipelineResult.mediaServer?.ip || '';
  const chkDetectAnomalies = document.getElementById('chk-detect-anomalies') as HTMLInputElement | null;
  const chkSipEvents = document.getElementById('chk-sip-events') as HTMLInputElement | null;
  const chkShowDtmf = document.getElementById('chk-show-dtmf') as HTMLInputElement | null;
  const chkShowMos = document.getElementById('chk-show-mos') as HTMLInputElement | null;
  const showAnomalies = chkDetectAnomalies ? chkDetectAnomalies.checked : true;
  const showSipEvents = chkSipEvents ? chkSipEvents.checked : true;
  const showDtmf = chkShowDtmf ? chkShowDtmf.checked : false;
  const showMos = chkShowMos ? chkShowMos.checked : true;

  const svg = LadderSvgRenderer.render(conv, {
    mediaServerIp: msIp,
    showAnomalies,
    showSipEvents,
    showDtmf,
    showMos,
    dialogs: pipelineResult.dialogs,
  });
  ladderContainer.innerHTML = svg;

  // Attach interactive click on stream arrows in SVG
  ladderContainer.querySelectorAll('.stream-arrow').forEach(el => {
    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.ladder-dtmf-badge')) return;
      const ssrc = parseInt(el.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) {
        playStream(stream);
        SnrUiController.selectStreamBySsrc(ssrc);
        MosUiController.selectStreamBySsrc(ssrc);
        DnsmosUiController.selectStreamBySsrc(ssrc);
      }
    });
  });

  // Attach interactive click on DTMF keypad badges in SVG ladder
  ladderContainer.querySelectorAll('.ladder-dtmf-badge').forEach(el => {
    el.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const digit = el.getAttribute('data-digit') || '';
      if (digit) {
        audioPlayer.playDtmf(digit, 220);
      }
    });
  });
}

function renderSipTable() {
  if (!pipelineResult) return;
  sipTbody.innerHTML = '';

  pipelineResult.dialogs.forEach(d => {
    const tr = document.createElement('tr');
    const codecsStr = d.negotiatedCodecs.map(c => {
      let cls = 'pill-pcmu';
      const up = c.name.toUpperCase();
      if (up.includes('G722')) cls = 'pill-g722';
      else if (up.includes('AMR')) cls = 'pill-amr';
      else if (up.includes('OPUS')) cls = 'pill-opus';
      else if (up.includes('EVS')) cls = 'pill-evs';
      return `<span class="pill ${cls}">${c.name}</span>`;
    }).join(' ') || 'None';
    const remotePort = d.offerMediaEndpoint ? `${d.offerMediaEndpoint.port}` : '-';
    const msPort = d.answerMediaEndpoint ? `${d.answerMediaEndpoint.port}` : '-';
    const sipDuration = (d.endTime - d.startTime).toFixed(2);

    const leg = pipelineResult?.legs.find(l => l.callId === d.callId);
    const mediaDuration = leg ? Math.max(leg.inboundStream?.duration || 0, leg.outboundStream?.duration || 0) : 0;

    const durationDisplay = mediaDuration > 0
      ? `<div><strong style="color: var(--accent);">${mediaDuration.toFixed(2)}s</strong> <span style="font-size: 11px;">(Media)</span></div>
         <div style="font-size: 11px; color: var(--text-muted);">SIP: ${sipDuration}s ${d.state !== 'Terminated' ? '(No BYE)' : ''}</div>`
      : `<div>${sipDuration}s <span style="font-size: 11px; color: var(--text-muted);">(SIP)</span></div>`;

    tr.innerHTML = `
      <td style="font-family: monospace; font-size: 11px;">${d.callId}</td>
      <td><span class="badge-tag">${d.state}</span></td>
      <td>${d.from}</td>
      <td>${d.to}</td>
      <td>${codecsStr}</td>
      <td>${remotePort} &harr; ${msPort}</td>
      <td>${durationDisplay}</td>
    `;
    sipTbody.appendChild(tr);
  });
}

function renderRtpTable() {
  if (!pipelineResult) return;
  rtpTbody.innerHTML = '';

  let streamsToShow = pipelineResult.streams;
  const convFilter = metricsConvSelect ? metricsConvSelect.value : 'all';
  if (convFilter !== 'all' && pipelineResult.conversations.length > 0) {
    const idx = parseInt(convFilter, 10);
    const conv = !isNaN(idx) ? pipelineResult.conversations[idx] : null;
    if (conv && conv.legs) {
      const ssrcSet = new Set<number>();
      for (const leg of conv.legs) {
        if (leg.inboundStream) ssrcSet.add(leg.inboundStream.ssrc);
        if (leg.outboundStream) ssrcSet.add(leg.outboundStream.ssrc);
      }
      streamsToShow = pipelineResult.streams.filter(s => ssrcSet.has(s.ssrc));
    }
  }

  streamsToShow.forEach(s => {
    const tr = document.createElement('tr');
    const info = StreamAudioDecoder.resolveCodec(s, pipelineResult?.dialogs || []);
    const isVideo = info.normalizedCodec === 'H264' || info.normalizedCodec === 'VP8' || s.payloadType === 99 || s.payloadType === 96;
    let codecClass = 'pill-pcmu';
    if (info.normalizedCodec === 'G722') codecClass = 'pill-g722';
    else if (info.normalizedCodec === 'AMR' || info.normalizedCodec === 'AMR-WB') codecClass = 'pill-amr';
    else if (info.normalizedCodec === 'OPUS') codecClass = 'pill-opus';
    else if (info.normalizedCodec === 'EVS' || info.normalizedCodec === 'EVS-HF') codecClass = 'pill-evs';
    else if (info.normalizedCodec === 'H264' || s.payloadType === 99) codecClass = 'pill-video';
    else if (info.normalizedCodec === 'VP8' || s.payloadType === 96) codecClass = 'pill-vp8';

    const isBitstreamAvailable = info.normalizedCodec === 'EVS' || info.normalizedCodec === 'EVS-HF' || info.normalizedCodec === 'AMR' || info.normalizedCodec === 'AMR-WB';
    const bitstreamLabel = info.normalizedCodec === 'EVS-HF' ? 'EVS-HF' : info.normalizedCodec === 'EVS' ? 'EVS' : info.normalizedCodec === 'AMR-WB' ? 'AMRWB' : 'AMR';

    const duration = (s.endTime - s.startTime).toFixed(2);
    const jitterMs = (s.jitterUs / 1000).toFixed(1);

    const mosVal = (s as any).mos;
    const rFactorVal = (s as any).rFactor;
    let mosDisplay = '--';
    if (mosVal !== undefined) {
      const mosColor = mosVal >= 4.0 ? '#9ece6a' : mosVal >= 3.6 ? '#2ac3de' : mosVal >= 3.1 ? '#e0af68' : '#f7768e';
      mosDisplay = `<span style="font-weight: 700; color: ${mosColor};">${mosVal.toFixed(2)}</span> <span style="font-size: 10px; color: var(--text-dim);">(R: ${rFactorVal !== undefined ? rFactorVal.toFixed(1) : '--'})</span>`;
    } else if (isVideo) {
      mosDisplay = `<span style="font-size: 11px; color: var(--text-dim);">N/A (Video)</span>`;
    }

    const leg = pipelineResult?.legs.find(l => l.inboundStream?.ssrc === s.ssrc || l.outboundStream?.ssrc === s.ssrc);
    const isIn = leg ? leg.inboundStream?.ssrc === s.ssrc : (pipelineResult?.mediaServer?.ip ? s.dstIp === pipelineResult.mediaServer.ip : false);
    const dirBadge = isIn
      ? `<span class="badge-inbound-compact" title="Inbound (Client &rarr; Media Server)">IN</span>`
      : `<span class="badge-outbound-compact" title="Outbound (Media Server &rarr; Client)">OUT</span>`;

    tr.innerHTML = `
      <td style="font-weight: 600; font-family: monospace; font-size: 11px;">${s.ssrc}</td>
      <td><span class="pill ${codecClass}">${info.name} (PT ${s.payloadType})</span></td>
      <td>${dirBadge}</td>
      <td style="font-size: 11px; font-family: monospace;">${s.srcIp}:${s.srcPort}</td>
      <td style="font-size: 11px; font-family: monospace;">${s.dstIp}:${s.dstPort}</td>
      <td>${s.packetCount}</td>
      <td style="${s.lossPercent > 0 ? 'color: var(--danger); font-weight: bold;' : ''}">${s.lossPercent}%</td>
      <td>${jitterMs}</td>
      <td>${mosDisplay}</td>
      <td>${duration}s</td>
      <td>
        ${isVideo ? `
          <button class="btn btn-primary btn-view-video" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px; background: #ff9e64; border-color: #ff9e64; color: #1a1b26;">&#x25B6; View Video</button>
          <button class="btn btn-download-video-mp4" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px;">&#x2B07; MP4</button>
          <button class="btn btn-download-video-raw" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px; background: rgba(255, 158, 100, 0.2); border: 1px solid #ff9e64; color: #ff9e64;">&#x2B07; ${info.normalizedCodec === 'VP8' ? 'IVF' : '264'}</button>
        ` : `
          <button class="btn btn-primary btn-play-stream" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px;">&#x25B6; Play</button>
          <button class="btn btn-download-single-wav" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px;">&#x2B07; WAV</button>
          ${isBitstreamAvailable ? `<button class="btn btn-download-single-bitstream" data-ssrc="${s.ssrc}" style="padding: 4px 10px; font-size: 12px; background: rgba(42, 195, 222, 0.2); border: 1px solid #2ac3de; color: #2ac3de;" title="Download standard 3GPP bitstream container">&#x2B07; ${bitstreamLabel}</button>` : ''}
        `}
      </td>
    `;
    rtpTbody.appendChild(tr);
  });

  // Attach buttons
  rtpTbody.querySelectorAll('.btn-play-stream').forEach(b => {
    b.addEventListener('click', () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) {
        playStream(stream);
        SnrUiController.selectStreamBySsrc(ssrc);
        MosUiController.selectStreamBySsrc(ssrc);
        DnsmosUiController.selectStreamBySsrc(ssrc);
      }
    });
  });

  rtpTbody.querySelectorAll('.btn-view-video').forEach(b => {
    b.addEventListener('click', () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) {
        const info = StreamAudioDecoder.resolveCodec(stream, pipelineResult?.dialogs || []);
        openVideoPlayer(stream, info.normalizedCodec);
      }
    });
  });

  rtpTbody.querySelectorAll('.btn-download-video-mp4').forEach(b => {
    b.addEventListener('click', async () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) {
        const vp = new VideoDecoderPlayer();
        await vp.loadStream(stream);
        const container = vp.exportContainerFile();
        if (container) {
          downloadBlob(container.data, `video_stream_${stream.ssrc}.mp4`, container.mimeType);
        }
      }
    });
  });

  rtpTbody.querySelectorAll('.btn-download-video-raw').forEach(b => {
    b.addEventListener('click', async () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) {
        const vp = new VideoDecoderPlayer();
        await vp.loadStream(stream);
        const raw = vp.exportRawBitstream();
        if (raw) {
          downloadBlob(raw.data, `video_stream_${stream.ssrc}_${raw.filename}`, 'application/octet-stream');
        }
      }
    });
  });

  rtpTbody.querySelectorAll('.btn-download-single-wav').forEach(b => {
    b.addEventListener('click', () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) downloadSingleStreamWav(stream);
    });
  });

  rtpTbody.querySelectorAll('.btn-download-single-bitstream').forEach(b => {
    b.addEventListener('click', () => {
      const ssrc = parseInt(b.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) downloadSingleStreamBitstream(stream);
    });
  });
}

async function openVideoPlayer(stream: RtpStream, codecHint?: string) {
  if (!videoModal || !videoCanvas) return;
  audioPlayer.stop();
  multiTrackPlayer.pause();
  playerDock.style.display = 'none';

  if (videoStreamTitle) videoStreamTitle.textContent = `SSRC: ${stream.ssrc} (${codecHint || 'Video'})`;
  if (videoStreamMeta) videoStreamMeta.textContent = `Depacketizing ${stream.packetCount} RTP packets...`;
  videoModal.style.display = 'flex';

  videoPlayer.attachCanvas(videoCanvas);
  try {
    const info = await videoPlayer.loadStream(stream, codecHint);
    if (videoStreamMeta) {
      videoStreamMeta.textContent = `${info.codec} • ${info.width}x${info.height} • ${info.fps} fps (${info.totalFrames} frames)`;
    }
    const frameCounter = document.getElementById('video-frame-counter');
    if (frameCounter) {
      frameCounter.textContent = `Frames: ${info.totalFrames}`;
    }
  } catch (err) {
    console.warn('[main] Video load error:', err);
  }
}

async function playStream(stream: RtpStream) {
  const info = StreamAudioDecoder.resolveCodec(stream, pipelineResult?.dialogs || []);
  if (info.normalizedCodec === 'H264' || info.normalizedCodec === 'VP8' || stream.payloadType === 99 || stream.payloadType === 96) {
    openVideoPlayer(stream, info.normalizedCodec);
    return;
  }

  // 1. Immediately pause and stop previous audio and callbacks
  multiTrackPlayer.pause();
  audioPlayer.stop();
  btnTogglePlay.textContent = '\u23F8';

  const reqId = ++activePlayRequestId;
  activeStream = stream;
  isLadderPlayerVisible = true;
  playerDock.style.display = 'flex';
  MosUiController.selectStreamBySsrc(stream.ssrc);

  playerTitle.textContent = `SSRC: ${stream.ssrc} (${info.name})`;
  playerMeta.textContent = `${stream.srcIp}:${stream.srcPort} \u2192 ${stream.dstIp}:${stream.dstPort} | Decoding audio...`;

  try {
    const fillSilence = chkFillSilence ? chkFillSilence.checked : true;
    const decoded = await StreamAudioDecoder.decodeStream(
      stream,
      pipelineResult?.dialogs || [],
      fillSilence
    );

    // If another stream was selected while this one was decoding, discard result
    if (reqId !== activePlayRequestId) return;

    activePcm16 = decoded.pcm;
    activeSampleRate = decoded.sampleRate;
    activeCodecName = decoded.codec;

    const durationSec = (decoded.pcm.length / decoded.sampleRate).toFixed(1);
    playerTitle.textContent = `SSRC: ${stream.ssrc} (${decoded.codec})`;
    playerMeta.textContent = `${stream.srcIp}:${stream.srcPort} \u2192 ${stream.dstIp}:${stream.dstPort} | ${decoded.sampleRate} Hz | ${durationSec}s | Mono`;

    audioPlayer.loadPcm16(activePcm16, decoded.sampleRate);
    resizeCanvas();
    const bucketCount = Math.min(500, Math.max(200, Math.floor((canvasWaveform.clientWidth || 800) / 2.5)));
    waveformPeaks = AudioPlayback.generateWaveformPeaks(activePcm16, bucketCount);
    drawWaveform(0);
    audioPlayer.play();
    btnTogglePlay.textContent = '\u23F8'; // Pause symbol
  } catch (err: any) {
    if (reqId !== activePlayRequestId) return;
    playerMeta.textContent = `Decoding failed: ${err?.message || err}`;
    console.error('Failed to decode stream:', err);
  }
}

async function downloadSingleStreamWav(stream: RtpStream) {
  try {
    const fillSilence = chkFillSilence ? chkFillSilence.checked : true;
    let pcm = activePcm16;
    let sampleRate = activeSampleRate;
    let codec = activeCodecName;

    if (!pcm || activeStream?.ssrc !== stream.ssrc) {
      const decoded = await StreamAudioDecoder.decodeStream(
        stream,
        pipelineResult?.dialogs || [],
        fillSilence
      );
      pcm = decoded.pcm;
      sampleRate = decoded.sampleRate;
      codec = decoded.codec;
    }

    if (!pcm || pcm.length === 0) {
      alert(`Stream ${stream.ssrc} contains no decodable audio packets.`);
      return;
    }

    const wavBytes = WavExporter.encodeWav([pcm], sampleRate, 16);
    const safeCodec = codec.toLowerCase().replace(/[^a-z0-9_-]/g, '');
    downloadBlob(wavBytes, `stream_${stream.ssrc}_${safeCodec}_${sampleRate}Hz.wav`, 'audio/wav');
  } catch (err: any) {
    alert(`Could not export WAV for stream ${stream.ssrc}: ${err?.message || err}`);
  }
}

async function downloadSingleStreamBitstream(stream: RtpStream) {
  try {
    const decoded = await StreamAudioDecoder.decodeStream(
      stream,
      pipelineResult?.dialogs || [],
      true
    );
    if (!decoded.bitstream || decoded.bitstream.length === 0) {
      alert(`Stream ${stream.ssrc} does not have an available 3GPP bitstream container.`);
      return;
    }
    const ext = decoded.bitstreamExt || 'evs';
    // Format filename: <dstIp>-<dstPort>-pt<pt>.<ext>
    const safeIp = stream.dstIp.replace(/:/g, ';');
    const filename = `${safeIp}-${stream.dstPort}-pt${stream.payloadType}.${ext}`;
    downloadBlob(decoded.bitstream, filename, 'application/octet-stream');
  } catch (err: any) {
    alert(`Could not export bitstream for stream ${stream.ssrc}: ${err?.message || err}`);
  }
}

chkFillSilence?.addEventListener('change', () => {
  if (activeStream) {
    playStream(activeStream);
  }
});

btnDownloadWav.addEventListener('click', () => {
  if (activeStream) downloadSingleStreamWav(activeStream);
});

btnDownloadAllWav.addEventListener('click', async () => {
  if (!pipelineResult) return;

  const convFilter = metricsConvSelect ? metricsConvSelect.value : (conversationSelect ? conversationSelect.value : 'all');
  let candidateLegs = pipelineResult.legs;
  if (convFilter !== 'all' && pipelineResult.conversations.length > 0) {
    const idx = parseInt(convFilter, 10);
    const conv = !isNaN(idx) ? pipelineResult.conversations[idx] : null;
    if (conv && conv.legs && conv.legs.length > 0) {
      candidateLegs = conv.legs;
    }
  }

  let mixedCount = 0;
  for (const leg of candidateLegs) {
    if (!leg.inboundStream || !leg.outboundStream) continue;

    const inStream = pipelineResult.streams.find(s => s.ssrc === leg.inboundStream!.ssrc);
    const outStream = pipelineResult.streams.find(s => s.ssrc === leg.outboundStream!.ssrc);
    if (!inStream || !outStream) continue;

    try {
      const fillSilence = chkFillSilence ? chkFillSilence.checked : true;
      const [decodedIn, decodedOut] = await Promise.all([
        StreamAudioDecoder.decodeStream(inStream, pipelineResult.dialogs, fillSilence),
        StreamAudioDecoder.decodeStream(outStream, pipelineResult.dialogs, fillSilence),
      ]);

      if (decodedIn.pcm.length === 0 || decodedOut.pcm.length === 0) continue;

      const targetRate = Math.max(decodedIn.sampleRate, decodedOut.sampleRate);
      let leftPcm = resamplePcm16(decodedIn.pcm, decodedIn.sampleRate, targetRate);
      let rightPcm = resamplePcm16(decodedOut.pcm, decodedOut.sampleRate, targetRate);

      // Time align based on packet start time
      const minStart = Math.min(inStream.startTime, outStream.startTime);
      const leftPadSamples = Math.max(0, Math.round((inStream.startTime - minStart) * targetRate));
      const rightPadSamples = Math.max(0, Math.round((outStream.startTime - minStart) * targetRate));

      if (leftPadSamples > 0) {
        const padded = new Int16Array(leftPadSamples + leftPcm.length);
        padded.set(leftPcm, leftPadSamples);
        leftPcm = padded;
      }
      if (rightPadSamples > 0) {
        const padded = new Int16Array(rightPadSamples + rightPcm.length);
        padded.set(rightPcm, rightPadSamples);
        rightPcm = padded;
      }

      const stereoWav = WavExporter.encodeStereoWav(leftPcm, rightPcm, targetRate);
      const legLabel = (leg.id || 'leg').replace(/[^a-zA-Z0-9_-]/g, '_');
      const inCodecLabel = decodedIn.codec.replace(/[^a-zA-Z0-9_-]/g, '');
      const outCodecLabel = decodedOut.codec.replace(/[^a-zA-Z0-9_-]/g, '');
      const filename = `call_stereo_${legLabel}_${inCodecLabel}_${outCodecLabel}_${targetRate}Hz.wav`;
      downloadBlob(stereoWav, filename, 'audio/wav');
      mixedCount++;
    } catch (err: any) {
      console.error(`Error mixing leg ${leg.id}:`, err);
    }
  }

  if (mixedCount === 0) {
    alert('No two-way media legs found for stereo mixing in the selected conversation.');
  }
});

function resamplePcm16(pcm: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || pcm.length === 0) return pcm;
  const ratio = toRate / fromRate;
  const outLen = Math.round(pcm.length * ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const srcPos = i / ratio;
    const idx = Math.floor(srcPos);
    const frac = srcPos - idx;
    const s0 = pcm[idx] || 0;
    const s1 = pcm[Math.min(idx + 1, pcm.length - 1)] || 0;
    out[i] = Math.round(s0 + frac * (s1 - s0));
  }
  return out;
}

function concatPackets(packets: Array<{ payload: Uint8Array }>): Uint8Array {
  const total = packets.reduce((a, p) => a + p.payload.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of packets) {
    out.set(p.payload, off);
    off += p.payload.length;
  }
  return out;
}

function downloadBlob(data: Uint8Array, filename: string, mime: string) {
  const blob = new Blob([data as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Audio controls
btnTogglePlay.addEventListener('click', () => {
  const duration = audioPlayer.getDuration();
  if (duration === 0) return;
  multiTrackPlayer.pause();
  const current = audioPlayer.getCurrentTime();
  if (current >= duration) {
    audioPlayer.seek(0);
    audioPlayer.play();
    btnTogglePlay.textContent = '\u23F8';
  } else if (audioPlayer.isPlayingNow()) {
    audioPlayer.pause();
    btnTogglePlay.textContent = '\u25B6';
  } else {
    audioPlayer.play();
    btnTogglePlay.textContent = '\u23F8';
  }
});

btnClosePlayerDock?.addEventListener('click', () => {
  isLadderPlayerVisible = false;
  audioPlayer.stop();
  playerDock.style.display = 'none';
});

btnSkipBackward?.addEventListener('click', () => {
  const cur = audioPlayer.getCurrentTime();
  audioPlayer.seek(Math.max(0, cur - 5));
});

btnSkipForward?.addEventListener('click', () => {
  const cur = audioPlayer.getCurrentTime();
  const dur = audioPlayer.getDuration();
  audioPlayer.seek(Math.min(dur, cur + 5));
});

// Smooth Volume Slider & Mute Toggle
function setVolumeLevel(vol: number) {
  const clamped = Math.max(0, Math.min(1, vol));
  volumeSlider.value = String(clamped);
  const pct = Math.round(clamped * 100);
  volumeSlider.style.setProperty('--volume-pct', `${pct}%`);
  audioPlayer.setVolume(clamped);
  if (btnVolumeIcon) {
    btnVolumeIcon.textContent = clamped === 0 ? '\u{1F507}' : clamped < 0.4 ? '\u{1F509}' : '\u{1F50A}';
  }
}

volumeSlider.addEventListener('input', () => {
  const vol = parseFloat(volumeSlider.value);
  if (vol > 0) previousVolume = vol;
  setVolumeLevel(vol);
});

btnVolumeIcon?.addEventListener('click', () => {
  const currentVol = parseFloat(volumeSlider.value);
  if (currentVol > 0) {
    previousVolume = currentVol;
    setVolumeLevel(0);
  } else {
    setVolumeLevel(previousVolume || 0.8);
  }
});

// Initialize volume display
setVolumeLevel(0.8);

audioPlayer.onTimeUpdate = (current, duration) => {
  playerCurrentTime.textContent = formatTime(current);
  playerDuration.textContent = formatTime(duration);
  const progress = duration > 0 ? current / duration : 0;
  drawWaveform(progress);
};

audioPlayer.onEnded = () => {
  btnTogglePlay.textContent = '\u25B6';
  drawWaveform(0);
};

// Smooth Canvas Resizing
function resizeCanvas() {
  const rect = canvasWaveform.getBoundingClientRect();
  if (rect.width > 0) {
    const dpr = window.devicePixelRatio || 1;
    canvasWaveform.width = Math.round(rect.width * dpr);
    canvasWaveform.height = Math.round(rect.height * dpr);
    const dur = audioPlayer.getDuration();
    const cur = audioPlayer.getCurrentTime();
    drawWaveform(dur > 0 ? cur / dur : 0);
  }
  if (mtCanvas && mtCanvas.offsetParent !== null) {
    renderMultiTrackView();
  }
}
window.addEventListener('resize', resizeCanvas);

// Smooth Scrubber Dragging & Seeking
let isScrubbing = false;

function handleScrub(e: MouseEvent) {
  const rect = canvasWaveform.getBoundingClientRect();
  if (rect.width <= 0) return;
  const clickX = e.clientX - rect.left;
  const pct = Math.max(0, Math.min(1, clickX / rect.width));
  const duration = audioPlayer.getDuration();
  audioPlayer.seek(pct * duration);
  drawWaveform(pct);
}

canvasWaveform.addEventListener('mousedown', (e) => {
  isScrubbing = true;
  handleScrub(e);
});

window.addEventListener('mousemove', (e) => {
  if (isScrubbing) {
    handleScrub(e);
  }
});

window.addEventListener('mouseup', () => {
  if (isScrubbing) {
    isScrubbing = false;
  }
});

function drawWaveform(progress: number) {
  const ctx = canvasWaveform.getContext('2d');
  if (!ctx) return;

  const w = canvasWaveform.width;
  const h = canvasWaveform.height;
  ctx.clearRect(0, 0, w, h);

  const midY = h / 2;

  // Center subtle guide
  ctx.strokeStyle = 'rgba(65, 72, 104, 0.3)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, midY);
  ctx.lineTo(w, midY);
  ctx.stroke();

  if (waveformPeaks.length === 0) return;

  const barWidth = w / waveformPeaks.length;
  const playheadX = progress * w;

  // Vibrant gradient for played segment
  const playedGrad = ctx.createLinearGradient(0, 0, w, 0);
  playedGrad.addColorStop(0, '#7aa2f7');
  playedGrad.addColorStop(1, '#bb9af7');

  for (let i = 0; i < waveformPeaks.length; i++) {
    const peak = waveformPeaks[i];
    const barHeight = Math.max(3, peak * (h - 10));
    const x = i * barWidth;
    const y = midY - barHeight / 2;

    const isPlayed = (x + barWidth) <= playheadX;
    ctx.fillStyle = isPlayed ? playedGrad : '#414868';
    ctx.fillRect(x, y, Math.max(1, barWidth - 1), barHeight);
  }

  // Soft glowing playhead needle
  ctx.save();
  ctx.shadowColor = 'rgba(247, 118, 142, 0.7)';
  ctx.shadowBlur = 6;
  ctx.fillStyle = '#f7768e';
  ctx.fillRect(playheadX - 1.5, 0, 3, h);

  // Rounded circular caps at needle ends
  ctx.beginPath();
  ctx.arc(playheadX, 4, 3, 0, Math.PI * 2);
  ctx.arc(playheadX, h - 4, 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function formatTime(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = (sec % 60).toFixed(1);
  return `${m}:${s.padStart(4, '0')}`;
}

// ==========================================
// Multi-Track RTP Player Logic (Wireshark-style)
// ==========================================

async function loadMultiTrackSession() {
  if (!pipelineResult) return;
  isMtSessionLoaded = false;
  if (mtTrackCount) mtTrackCount.textContent = 'Decoding stream audio...';

  try {
    await multiTrackPlayer.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs,
      pipelineResult.conversations
    );
  } catch (err) {
    console.error('[MultiTrackPlayer] Error loading session:', err);
  }

  isMtSessionLoaded = true;

  // Apply default conversation filter & sort order
  const initialConv = mtConversationSelect ? mtConversationSelect.value : (conversationSelect ? conversationSelect.value : 'all');
  multiTrackPlayer.setConversationFilter(initialConv);
  if (mtSortSelect) {
    multiTrackPlayer.setSortOrder(mtSortSelect.value as any);
  }

  if (pipelineResult) {
    SnrUiController.setTracks(multiTrackPlayer.getTracks(), pipelineResult);
    DnsmosUiController.setData(multiTrackPlayer.getTracks(), pipelineResult);
  }
  renderMultiTrackView();
}

function renderMultiTrackView() {
  if (!mtCanvas || !pipelineResult) return;
  const tracks = multiTrackPlayer.getTracks();
  const totalDuration = multiTrackPlayer.getTotalDuration();
  const currentSec = multiTrackPlayer.getCurrentTime();
  const selection = multiTrackPlayer.getSelection();

  if (mtTrackCount) {
    mtTrackCount.textContent = `${tracks.length} streams`;
  }
  if (mtTotalDuration) {
    mtTotalDuration.textContent = formatTime(totalDuration);
  }
  if (mtCurrentTime) {
    mtCurrentTime.textContent = formatTime(currentSec);
  }

  // GoldWave selection indicator & action labels
  if (selection && selection.endSec > selection.startSec) {
    const selDur = selection.endSec - selection.startSec;
    if (mtSelectionBadge) mtSelectionBadge.style.display = 'inline-flex';
    if (mtSelectionRange) {
      mtSelectionRange.textContent = `${formatTime(selection.startSec)} \u2013 ${formatTime(selection.endSec)} (${selDur.toFixed(1)}s)`;
    }
    if (btnMtTogglePlay) {
      btnMtTogglePlay.textContent = multiTrackPlayer.getIsPlaying() ? '\u23F8 Pause Selection' : '\u25B6 Play Selection';
    }
    if (btnMtExportMix) {
      btnMtExportMix.textContent = `\u2B07 Export Selection WAV (${selDur.toFixed(1)}s)`;
    }
  } else {
    if (mtSelectionBadge) mtSelectionBadge.style.display = 'none';
    if (btnMtTogglePlay) {
      btnMtTogglePlay.textContent = multiTrackPlayer.getIsPlaying() ? '\u23F8 Pause' : '\u25B6 Play All (Mixed)';
    }
    if (btnMtExportMix) {
      btnMtExportMix.textContent = '\u2B07 Export Mixed WAV';
    }
  }

  // Set sharp canvas resolution matching right column width
  const dpr = window.devicePixelRatio || 1;
  const trackHeight = 52;
  const headerHeight = 28;
  const totalH = headerHeight + Math.max(1, tracks.length) * trackHeight;
  const rightCol = document.getElementById('mt-canvas-wrap');
  const totalW = rightCol && rightCol.clientWidth > 0 ? rightCol.clientWidth : (mtCanvas.parentElement?.clientWidth || 800);

  mtCanvas.width = totalW * dpr;
  mtCanvas.height = totalH * dpr;
  mtCanvas.style.width = `${totalW}px`;
  mtCanvas.style.height = `${totalH}px`;

  const chkShowDtmf = document.getElementById('chk-show-dtmf') as HTMLInputElement | null;
  const showDtmf = chkShowDtmf ? chkShowDtmf.checked : false;

  MultiTrackRenderer.render({
    canvas: mtCanvas,
    tracks,
    totalDuration,
    playheadSec: currentSec,
    hoverSec: mtHoverSec,
    selection,
    showDtmf,
  });

  renderMultiTrackGutter();
}

function renderMultiTrackGutter() {
  if (!mtTracksGutter) return;
  mtTracksGutter.innerHTML = '';

  const tracks = multiTrackPlayer.getTracks();

  for (const track of tracks) {
    const row = document.createElement('div');
    row.className = `mt-track-row ${track.isMuted ? 'muted' : ''}`;
    row.setAttribute('data-ssrc', String(track.ssrc));

    const isIn = track.direction === 'inbound';
    const dirBadge = isIn
      ? `<span class="badge-inbound-compact" title="Inbound (Client &rarr; Media Server)">IN</span>`
      : `<span class="badge-outbound-compact" title="Outbound (Media Server &rarr; Client)">OUT</span>`;

    row.innerHTML = `
      <div class="mt-track-line-top">
        <button class="mt-btn-solo ${track.isSolo ? 'active' : ''}" data-ssrc="${track.ssrc}" title="Solo stream">S</button>
        <button class="mt-btn-mute ${track.isMuted ? 'active' : ''}" data-ssrc="${track.ssrc}" title="Mute stream">M</button>
        <button class="mt-btn-quickplay" data-ssrc="${track.ssrc}" title="Solo &amp; Play">&#x25B6;</button>
        <span class="mt-color-dot" style="background: ${track.color};"></span>
        ${dirBadge}
        <span class="mt-track-label" title="${track.legId} &bull; ${track.codec}">${track.legId} &bull; ${track.codec}</span>
      </div>
      <div class="mt-track-line-bottom">
        <div class="mt-small-meta" title="SSRC: ${track.ssrc} | Port: ${track.srcPort} &rarr; ${track.dstPort}">
          <span>SSRC: <span class="meta-ssrc">${track.ssrc}</span></span>
          <span>|</span>
          <span>Port: <span class="meta-ports">${track.srcPort} &rarr; ${track.dstPort}</span></span>
        </div>
        <div style="display: flex; gap: 4px; align-items: center;">
          <button class="mt-btn-wav" data-ssrc="${track.ssrc}" title="Download WAV">&#x2B07; WAV</button>
          ${track.bitstream ? `<button class="mt-btn-bitstream" data-ssrc="${track.ssrc}" title="Download standard 3GPP ${track.bitstreamExt?.toUpperCase()} bitstream">&#x2B07; ${track.bitstreamExt?.toUpperCase()}</button>` : ''}
        </div>
      </div>
    `;

    row.addEventListener('click', () => {
      SnrUiController.selectStreamBySsrc(track.ssrc);
      MosUiController.selectStreamBySsrc(track.ssrc);
      DnsmosUiController.selectStreamBySsrc(track.ssrc);
    });

    mtTracksGutter.appendChild(row);
  }

  // Button listeners
  mtTracksGutter.querySelectorAll('.mt-btn-solo').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ssrc = parseInt(btn.getAttribute('data-ssrc') || '0', 10);
      const t = tracks.find(tr => tr.ssrc === ssrc);
      if (t) {
        multiTrackPlayer.setTrackSolo(ssrc, !t.isSolo);
        renderMultiTrackView();
      }
    });
  });

  mtTracksGutter.querySelectorAll('.mt-btn-mute').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ssrc = parseInt(btn.getAttribute('data-ssrc') || '0', 10);
      const t = tracks.find(tr => tr.ssrc === ssrc);
      if (t) {
        multiTrackPlayer.setTrackMute(ssrc, !t.isMuted);
        renderMultiTrackView();
      }
    });
  });

  mtTracksGutter.querySelectorAll('.mt-btn-quickplay').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ssrc = parseInt(btn.getAttribute('data-ssrc') || '0', 10);
      audioPlayer.stop();
      multiTrackPlayer.soloSingleStreamAndPlay(ssrc);
      btnMtTogglePlay.textContent = '\u23F8 Pause';
      SnrUiController.selectStreamBySsrc(ssrc);
      MosUiController.selectStreamBySsrc(ssrc);
      DnsmosUiController.selectStreamBySsrc(ssrc);
      renderMultiTrackView();
    });
  });

  mtTracksGutter.querySelectorAll('.mt-btn-wav').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ssrc = parseInt(btn.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) downloadSingleStreamWav(stream);
    });
  });

  mtTracksGutter.querySelectorAll('.mt-btn-bitstream').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ssrc = parseInt(btn.getAttribute('data-ssrc') || '0', 10);
      const stream = pipelineResult?.streams.find(s => s.ssrc === ssrc);
      if (stream) downloadSingleStreamBitstream(stream);
    });
  });
}

// MultiTrackPlayer events
multiTrackPlayer.onTimeUpdate = (current, total) => {
  if (mtCurrentTime) mtCurrentTime.textContent = formatTime(current);
  if (mtCanvas) {
    MultiTrackRenderer.render({
      canvas: mtCanvas,
      tracks: multiTrackPlayer.getTracks(),
      totalDuration: total,
      playheadSec: current,
      hoverSec: mtHoverSec,
    });
  }
};

multiTrackPlayer.onEnded = () => {
  btnMtTogglePlay.textContent = '\u25B6 Play All (Mixed)';
  renderMultiTrackView();
};

multiTrackPlayer.onTracksUpdated = () => {
  renderMultiTrackView();
};

// Transport button listeners
btnMtTogglePlay.addEventListener('click', () => {
  audioPlayer.stop();
  if (multiTrackPlayer.getIsPlaying()) {
    multiTrackPlayer.pause();
    btnMtTogglePlay.textContent = '\u25B6 Play All (Mixed)';
  } else {
    multiTrackPlayer.play();
    btnMtTogglePlay.textContent = '\u23F8 Pause';
  }
  renderMultiTrackView();
});

btnMtSkipBackward?.addEventListener('click', () => {
  const cur = multiTrackPlayer.getCurrentTime();
  multiTrackPlayer.seek(Math.max(0, cur - 5));
});

btnMtSkipForward?.addEventListener('click', () => {
  const cur = multiTrackPlayer.getCurrentTime();
  const dur = multiTrackPlayer.getTotalDuration();
  multiTrackPlayer.seek(Math.min(dur, cur + 5));
});

mtVolumeSlider?.addEventListener('input', () => {
  multiTrackPlayer.setMasterVolume(parseFloat(mtVolumeSlider.value));
});

btnMtFilterAll?.addEventListener('click', () => {
  multiTrackPlayer.muteAll(false);
  renderMultiTrackView();
});

btnMtFilterIn?.addEventListener('click', () => {
  multiTrackPlayer.filterByDirection('inbound');
  renderMultiTrackView();
});

btnMtFilterOut?.addEventListener('click', () => {
  multiTrackPlayer.filterByDirection('outbound');
  renderMultiTrackView();
});

btnMtMuteAll?.addEventListener('click', () => {
  multiTrackPlayer.muteAll(true);
  renderMultiTrackView();
});

btnMtExportMix.addEventListener('click', () => {
  const mixedWav = multiTrackPlayer.exportMixedWav();
  if (mixedWav.length > 0) {
    const sel = multiTrackPlayer.getSelection();
    const filename = sel
      ? `multitrack_selection_${sel.startSec.toFixed(1)}s-${sel.endSec.toFixed(1)}s.wav`
      : `multitrack_mixed_session_${Math.round(multiTrackPlayer.getTotalDuration())}s.wav`;
    downloadBlob(mixedWav, filename, 'audio/wav');
  } else {
    alert('No active unmuted tracks to export.');
  }
});

// GoldWave-Style Interactive Drag-to-Select and Scrub
let mtDragAnchorSec: number | null = null;
let mtDragStartX: number = 0;
let mtDragMode: 'create' | 'handle-start' | 'handle-end' | null = null;
let isMtDragging = false;

chkMtLoop?.addEventListener('change', () => {
  multiTrackPlayer.setIsLooping(chkMtLoop.checked);
});

btnMtClearSel?.addEventListener('click', () => {
  multiTrackPlayer.clearSelection();
  renderMultiTrackView();
});

mtCanvas.addEventListener('mousedown', (e) => {
  const totalDuration = multiTrackPlayer.getTotalDuration();
  if (totalDuration <= 0) return;
  const sec = MultiTrackRenderer.getSecFromEvent(e, mtCanvas, totalDuration);
  if (sec === null) return;

  audioPlayer.stop();

  // Check if clicking near start '{' or end '}' handle of existing selection
  const nearHandle = MultiTrackRenderer.getNearHandle(e, mtCanvas, totalDuration, multiTrackPlayer.getSelection());
  if (nearHandle === 'start') {
    mtDragMode = 'handle-start';
    isMtDragging = true;
  } else if (nearHandle === 'end') {
    mtDragMode = 'handle-end';
    isMtDragging = true;
  } else {
    // Starting a new selection drag
    mtDragMode = 'create';
    mtDragAnchorSec = sec;
    mtDragStartX = e.clientX;
    isMtDragging = true;
  }
});

window.addEventListener('mousemove', (e) => {
  const totalDuration = multiTrackPlayer.getTotalDuration();
  if (totalDuration <= 0) return;

  if (isMtDragging) {
    const sec = MultiTrackRenderer.getSecFromEvent(e, mtCanvas, totalDuration);
    if (sec === null) return;

    if (mtDragMode === 'create' && mtDragAnchorSec !== null) {
      const movedPx = Math.abs(e.clientX - mtDragStartX);
      if (movedPx >= 4 || Math.abs(sec - mtDragAnchorSec) >= 0.05) {
        const s1 = Math.min(mtDragAnchorSec, sec);
        const s2 = Math.max(mtDragAnchorSec, sec);
        multiTrackPlayer.setSelection(s1, s2);
        renderMultiTrackView();
      }
    } else if (mtDragMode === 'handle-start') {
      const currentSel = multiTrackPlayer.getSelection();
      if (currentSel) {
        const newStart = Math.min(Math.max(0, sec), currentSel.endSec - 0.05);
        multiTrackPlayer.setSelection(newStart, currentSel.endSec);
        renderMultiTrackView();
      }
    } else if (mtDragMode === 'handle-end') {
      const currentSel = multiTrackPlayer.getSelection();
      if (currentSel) {
        const newEnd = Math.max(Math.min(totalDuration, sec), currentSel.startSec + 0.05);
        multiTrackPlayer.setSelection(currentSel.startSec, newEnd);
        renderMultiTrackView();
      }
    }
  } else if (mtCanvas && mtCanvas.offsetParent !== null) {
    const sec = MultiTrackRenderer.getSecFromEvent(e, mtCanvas, totalDuration);
    if (sec !== null) {
      // Update cursor based on whether mouse is over handles
      const nearHandle = MultiTrackRenderer.getNearHandle(e, mtCanvas, totalDuration, multiTrackPlayer.getSelection());
      if (nearHandle) {
        mtCanvas.style.cursor = 'ew-resize';
      } else {
        mtCanvas.style.cursor = 'crosshair';
      }

      if (sec !== mtHoverSec) {
        mtHoverSec = sec;
        MultiTrackRenderer.render({
          canvas: mtCanvas,
          tracks: multiTrackPlayer.getTracks(),
          totalDuration,
          playheadSec: multiTrackPlayer.getCurrentTime(),
          hoverSec: mtHoverSec,
          selection: multiTrackPlayer.getSelection(),
        });
      }
    }
  }
});

window.addEventListener('mouseup', (e) => {
  if (isMtDragging) {
    const totalDuration = multiTrackPlayer.getTotalDuration();
    if (mtDragMode === 'create' && mtDragAnchorSec !== null) {
      const movedPx = Math.abs(e.clientX - mtDragStartX);
      if (movedPx < 4) {
        // It was a simple click (not a drag):
        const clickedSec = MultiTrackRenderer.getSecFromEvent(e, mtCanvas, totalDuration);
        const sel = multiTrackPlayer.getSelection();
        if (sel && clickedSec !== null) {
          if (clickedSec < sel.startSec || clickedSec > sel.endSec) {
            // Click outside current selection clears it and seeks
            multiTrackPlayer.clearSelection();
            multiTrackPlayer.seek(clickedSec);
          } else {
            // Click inside seeks playhead within selection
            multiTrackPlayer.seek(clickedSec);
          }
        } else if (clickedSec !== null) {
          multiTrackPlayer.seek(clickedSec);
        }
      } else {
        // Drag selection complete: position playhead at start of selection
        const sel = multiTrackPlayer.getSelection();
        if (sel) {
          multiTrackPlayer.seek(sel.startSec);
        }
      }
    }

    isMtDragging = false;
    mtDragMode = null;
    mtDragAnchorSec = null;
    renderMultiTrackView();

    const sel = multiTrackPlayer.getSelection();
    if (sel && sel.endSec > sel.startSec) {
      SnrUiController.syncFromCanvasSelection(sel.startSec, sel.endSec);
      DnsmosUiController.syncFromCanvasSelection(sel.startSec, sel.endSec);
    }
  }
});

// Double-click clears selection
mtCanvas.addEventListener('dblclick', () => {
  multiTrackPlayer.clearSelection();
  renderMultiTrackView();
});

mtCanvas.addEventListener('mouseleave', () => {
  if (!isMtDragging && mtHoverSec !== null) {
    mtHoverSec = null;
    MultiTrackRenderer.render({
      canvas: mtCanvas,
      tracks: multiTrackPlayer.getTracks(),
      totalDuration: multiTrackPlayer.getTotalDuration(),
      playheadSec: multiTrackPlayer.getCurrentTime(),
      hoverSec: null,
      selection: multiTrackPlayer.getSelection(),
    });
  }
});

// Keyboard shortcuts (GoldWave style)
window.addEventListener('keydown', (e) => {
  const isMtActive = document.getElementById('tab-rtp')?.style.display !== 'none';
  if (!isMtActive) return;

  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement || e.target instanceof HTMLTextAreaElement) {
    return;
  }

  if (e.key === 'Escape') {
    multiTrackPlayer.clearSelection();
    renderMultiTrackView();
  } else if (e.key === ' ' || e.code === 'Space') {
    e.preventDefault();
    if (multiTrackPlayer.getIsPlaying()) {
      multiTrackPlayer.pause();
    } else {
      multiTrackPlayer.play();
    }
    renderMultiTrackView();
  } else if (e.key === '[') {
    const cur = multiTrackPlayer.getCurrentTime();
    const sel = multiTrackPlayer.getSelection();
    const end = sel ? sel.endSec : multiTrackPlayer.getTotalDuration();
    multiTrackPlayer.setSelection(cur, Math.max(cur + 0.1, end));
    renderMultiTrackView();
  } else if (e.key === ']') {
    const cur = multiTrackPlayer.getCurrentTime();
    const sel = multiTrackPlayer.getSelection();
    const start = sel ? sel.startSec : 0;
    multiTrackPlayer.setSelection(Math.min(start, cur - 0.1), cur);
    renderMultiTrackView();
  }
});
