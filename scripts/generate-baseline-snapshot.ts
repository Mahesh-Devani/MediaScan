import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { CapturePipeline, type PipelineResult } from '../src/CapturePipeline.ts';
import { StreamAudioDecoder } from '../src/decoders/StreamAudioDecoder.ts';
import { WavExporter } from '../src/media/WavExporter.ts';
import { SnrEngine } from '../src/analysis/SnrEngine.ts';
import { H264Depacketizer } from '../src/video/H264Depacketizer.ts';
import { Mp4Muxer } from '../src/video/Mp4Muxer.ts';
import type { RtpStream } from '../src/rtp/RtpDemuxer.ts';

function sha256(buf: ArrayBufferView | ArrayBuffer): string {
  const hash = crypto.createHash('sha256');
  if (ArrayBuffer.isView(buf)) {
    hash.update(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
  } else {
    hash.update(Buffer.from(buf));
  }
  return hash.digest('hex');
}

export interface StreamSnapshot {
  ssrc: number;
  payloadType: number;
  codec: string;
  packetCount: number;
  lossCount: number;
  lossPercent: number;
  jitterUs: number;
  duration: number;
  startTime: number;
  endTime: number;
  src: string;
  dst: string;
  direction?: string;
  mos?: number;
  rFactor?: number;
  pcmSha256?: string;
  wavSha256?: string;
  pcmSampleCount?: number;
  sampleRate?: number;
  snrDb?: number | null;
  noiseFloorDbfs?: number | null;
}

export interface PcapBaseline {
  filename: string;
  fileSizeBytes: number;
  parseTimeMs: number;
  stats: PipelineResult['stats'];
  mediaServer: { ip: string; totalPackets: number; answerPackets: number } | null;
  dialogCount: number;
  dialogs: Array<{
    callId: string;
    from: string;
    to: string;
    state: string;
    offerCodec?: string;
    answerCodec?: string;
    startTime: number;
    endTime: number;
  }>;
  legCount: number;
  legs: Array<{
    id: string;
    callId: string;
    remote: { ip: string; port: number };
    ms: { ip: string; port: number };
    inboundSsrc?: number;
    outboundSsrc?: number;
    anomalies: string[];
    isCorrelatedWithSip: boolean;
  }>;
  conversationCount: number;
  conversations: Array<{
    id: string;
    classification: string;
    legIds: string[];
    startTime: number;
    endTime: number;
  }>;
  streams: StreamSnapshot[];
}

export interface BaselineSnapshot {
  generatedAt: string;
  gitCommit: string;
  gitTag: string;
  nodeVersion: string;
  pcaps: Record<string, PcapBaseline>;
  syntheticVideo: {
    nalCount: number;
    annexBSha256: string;
    mp4Sha256: string;
  };
}

export async function generateBaseline(): Promise<BaselineSnapshot> {
  const pcapFiles = [
    { name: 'mrfp-o.pcap', path: path.resolve('test/fixtures/mrfp-o/mrfp-o.pcap') },
    { name: 'mrfp-1.pcap', path: path.resolve('test/fixtures/mrfp-1/mrfp-1.pcap') }
  ];

  const pcapsRecord: Record<string, PcapBaseline> = {};

  for (const { name, path: pcapPath } of pcapFiles) {
    if (!fs.existsSync(pcapPath)) {
      console.warn(`Pcap not found: ${pcapPath}`);
      continue;
    }

    const fileBuffer = fs.readFileSync(pcapPath);
    const pcapBytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

    // Timing benchmark over 3 runs
    let totalParseTime = 0;
    const runs = 3;
    let pipelineResult!: PipelineResult;

    for (let r = 0; r < runs; r++) {
      const t0 = performance.now();
      pipelineResult = CapturePipeline.process(pcapBytes);
      totalParseTime += (performance.now() - t0);
    }
    const avgParseTime = +(totalParseTime / runs).toFixed(2);

    const streamSnapshots: StreamSnapshot[] = [];

    for (const s of pipelineResult.streams) {
      const snap: StreamSnapshot = {
        ssrc: s.ssrc,
        payloadType: s.payloadType,
        codec: '',
        packetCount: s.packetCount,
        lossCount: s.lossCount,
        lossPercent: +s.lossPercent.toFixed(2),
        jitterUs: +s.jitterUs.toFixed(2),
        duration: +(s.endTime - s.startTime).toFixed(3),
        startTime: +s.startTime.toFixed(3),
        endTime: +s.endTime.toFixed(3),
        src: `${s.srcIp}:${s.srcPort}`,
        dst: `${s.dstIp}:${s.dstPort}`,
        direction: (s as any).direction,
        mos: (s as any).mos,
        rFactor: (s as any).rFactor,
      };

      try {
        const codecInfo = StreamAudioDecoder.resolveCodec(s, pipelineResult.dialogs);
        snap.codec = codecInfo.normalizedCodec;

        // Decode audio
        const decoded = await StreamAudioDecoder.decodeStream(s, pipelineResult.dialogs);
        if (decoded && decoded.pcm && decoded.pcm.length > 0) {
          snap.pcmSha256 = sha256(decoded.pcm);
          snap.pcmSampleCount = decoded.pcm.length;
          snap.sampleRate = decoded.sampleRate;

          const wav = WavExporter.encodeWav([decoded.pcm], decoded.sampleRate, 16);
          snap.wavSha256 = sha256(wav);

          // SNR
          const snrRes = SnrEngine.analyze(decoded.pcm, decoded.sampleRate);
          snap.snrDb = snrRes.snrDb !== null ? +snrRes.snrDb.toFixed(2) : null;
          snap.noiseFloorDbfs = snrRes.noiseFloorDbfs !== null ? +snrRes.noiseFloorDbfs.toFixed(2) : null;
        }
      } catch (err: any) {
        snap.codec = snap.codec || `PT${s.payloadType}`;
      }

      streamSnapshots.push(snap);
    }

    // Sort streams by SSRC for deterministic golden snapshot
    streamSnapshots.sort((a, b) => a.ssrc - b.ssrc);

    pcapsRecord[name] = {
      filename: name,
      fileSizeBytes: fileBuffer.byteLength,
      parseTimeMs: avgParseTime,
      stats: pipelineResult.stats,
      mediaServer: pipelineResult.mediaServer ? {
        ip: pipelineResult.mediaServer.ip,
        totalPackets: pipelineResult.mediaServer.totalPackets,
        answerPackets: pipelineResult.mediaServer.answerPackets
      } : null,
      dialogCount: pipelineResult.dialogs.length,
      dialogs: pipelineResult.dialogs.map(d => ({
        callId: d.callId,
        from: d.from,
        to: d.to,
        state: d.state,
        offerCodec: d.offer?.media[0]?.rtpmap.get(d.offer.media[0]?.formats[0])?.name,
        answerCodec: d.answer?.media[0]?.rtpmap.get(d.answer.media[0]?.formats[0])?.name,
        startTime: +d.startTime.toFixed(3),
        endTime: +d.endTime.toFixed(3),
      })).sort((a, b) => a.callId.localeCompare(b.callId)),
      legCount: pipelineResult.legs.length,
      legs: pipelineResult.legs.map(l => ({
        id: l.id,
        callId: l.callId,
        remote: l.remoteEndpoint,
        ms: l.msEndpoint,
        inboundSsrc: l.inboundStream?.ssrc,
        outboundSsrc: l.outboundStream?.ssrc,
        anomalies: l.anomalies.map(a => a.type),
        isCorrelatedWithSip: l.isCorrelatedWithSip,
      })).sort((a, b) => a.id.localeCompare(b.id)),
      conversationCount: pipelineResult.conversations.length,
      conversations: pipelineResult.conversations.map(c => ({
        id: c.id,
        classification: c.classification,
        legIds: c.legs.map(l => l.id),
        startTime: +c.startTime.toFixed(3),
        endTime: +c.endTime.toFixed(3),
      })).sort((a, b) => a.id.localeCompare(b.id)),
      streams: streamSnapshots,
    };
  }

  // Synthetic Video Reference (from video.test.ts)
  const spsData = new Uint8Array([0x67, 0x42, 0xe0, 0x1e, 0xda, 0x02, 0x80, 0xf6, 0x80, 0x6d, 0x0a, 0x13, 0x50]);
  const ppsData = new Uint8Array([0x68, 0xce, 0x3c, 0x80]);
  const idrData = new Uint8Array([0x65, 0x88, 0x84, 0x00, 0x10, 0xff]);

  const videoStream: RtpStream = {
    id: 'video-ref',
    ssrc: 99999,
    payloadType: 99,
    srcIp: '192.168.1.1',
    srcPort: 5004,
    dstIp: '192.168.1.2',
    dstPort: 5004,
    startTime: 0.0,
    endTime: 1.0,
    firstSeq: 1,
    lastSeq: 3,
    minExtendedSeq: 1,
    maxExtendedSeq: 3,
    wrapCycles: 0,
    firstTimestamp: 90000,
    lastTimestamp: 93000,
    packetCount: 3,
    octetCount: spsData.length + ppsData.length + idrData.length,
    lossCount: 0,
    lossPercent: 0,
    jitterUs: 50,
    clockRate: 90000,
    packets: [
      { seq: 1, extendedSeq: 1, timestamp: 90000, pktTime: 0.0, marker: false, payload: spsData },
      { seq: 2, extendedSeq: 2, timestamp: 90000, pktTime: 0.0, marker: false, payload: ppsData },
      { seq: 3, extendedSeq: 3, timestamp: 90000, pktTime: 0.033, marker: true, payload: idrData },
    ],
    telephoneEvents: [],
  };

  const videoMeta = H264Depacketizer.depacketize(videoStream);
  const mp4Bytes = Mp4Muxer.mux(videoMeta);

  return {
    generatedAt: new Date().toISOString(),
    gitCommit: 'd401063',
    gitTag: 'pre-srtp-baseline',
    nodeVersion: process.version,
    pcaps: pcapsRecord,
    syntheticVideo: {
      nalCount: videoMeta.totalNalCount,
      annexBSha256: sha256(videoMeta.bitstream),
      mp4Sha256: sha256(mp4Bytes),
    }
  };
}

// Only run and save to disk if executed directly as a standalone script
if (process.argv[1] && process.argv[1].includes('generate-baseline-snapshot')) {
  generateBaseline().then(snapshot => {
    const outDir = path.resolve('test/fixtures/baseline');
    if (!fs.existsSync(outDir)) {
      fs.mkdirSync(outDir, { recursive: true });
    }
    const outFile = path.join(outDir, 'baseline-snapshot.json');
    fs.writeFileSync(outFile, JSON.stringify(snapshot, null, 2), 'utf-8');
    console.log(`Baseline snapshot saved to ${outFile}`);
  }).catch(err => {
    console.error('Failed to generate baseline snapshot:', err);
    process.exit(1);
  });
}
