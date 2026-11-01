import { G711Decoder } from './G711Decoder.ts';
import { G722Decoder } from './G722Decoder.ts';
import { AmrDecoder } from './AmrDecoder.ts';
import { AmrDepacketizer } from './AmrDepacketizer.ts';
import { OpusDecoder } from './OpusDecoder.ts';
import { EvsDepacketizer } from './EvsDepacketizer.ts';
import { EvsDecoder } from './EvsDecoder.ts';
import type { RtpStream } from '../rtp/RtpDemuxer.ts';
import type { SipDialog } from '../sip/DialogManager.ts';

export interface CodecInfo {
  name: string;
  normalizedCodec: 'PCMU' | 'PCMA' | 'G722' | 'AMR' | 'AMR-WB' | 'OPUS' | 'EVS' | 'EVS-HF' | 'H264' | 'VP8' | 'UNKNOWN';
  clockRate: number;
  octetAligned: boolean;
  bandwidth?: 'NB' | 'WB' | 'SWB' | 'FB';
  isHeaderFull?: boolean;
}

export interface DecodedAudio {
  pcm: Int16Array;
  sampleRate: number;
  codec: string;
  bitstream?: Uint8Array;
  bitstreamExt?: 'evs' | 'evs_hf' | 'amr' | 'amrwb';
}

export class StreamAudioDecoder {
  /**
   * Resolves codec name and parameters from SIP dialog SDP or standard defaults.
   */
  public static resolveCodec(stream: RtpStream, dialogs: SipDialog[] = []): CodecInfo {
    let rawName = '';
    let clockRate = stream.clockRate;
    let octetAligned = false;
    let bandwidth: CodecInfo['bandwidth'] = undefined;
    let isHeaderFull = false;

    // Search dialogs for negotiated codec matching stream PT
    for (const d of dialogs) {
      const match = d.negotiatedCodecs.find(c => c.pt === stream.payloadType);
      if (match) {
        rawName = match.name;
        clockRate = match.clockRate || clockRate;
        // Check fmtp in offer and answer
        const fmtpOffer = d.offer?.media[0]?.fmtp.get(stream.payloadType) || '';
        const fmtpAnswer = d.answer?.media[0]?.fmtp.get(stream.payloadType) || '';
        const combinedFmtp = `${fmtpOffer};${fmtpAnswer}`.toLowerCase();

        if (combinedFmtp.includes('octet-align=1')) {
          octetAligned = true;
        }
        if (combinedFmtp.includes('hf-only=1')) {
          isHeaderFull = true;
        }
        if (combinedFmtp.includes('bw=swb') || combinedFmtp.includes('=swb')) {
          bandwidth = 'SWB';
        } else if (combinedFmtp.includes('bw=wb') || combinedFmtp.includes('=wb')) {
          bandwidth = 'WB';
        } else if (combinedFmtp.includes('bw=nb') || combinedFmtp.includes('=nb')) {
          bandwidth = 'NB';
        } else if (combinedFmtp.includes('bw=fb') || combinedFmtp.includes('=fb')) {
          bandwidth = 'FB';
        }
        break;
      }
    }

    // Fallbacks if not negotiated in SIP
    if (!rawName) {
      switch (stream.payloadType) {
        case 0:
          rawName = 'PCMU';
          clockRate = 8000;
          break;
        case 8:
          rawName = 'PCMA';
          clockRate = 8000;
          break;
        case 9:
          rawName = 'G722';
          clockRate = 16000;
          break;
        case 100:
          rawName = 'AMR';
          clockRate = 8000;
          break;
        case 101:
          rawName = 'AMR-WB';
          clockRate = 16000;
          break;
        case 105:
          rawName = 'EVS-HF';
          bandwidth = 'NB';
          isHeaderFull = true;
          clockRate = 8000;
          break;
        case 106:
          rawName = 'EVS-HF';
          bandwidth = 'WB';
          isHeaderFull = true;
          clockRate = 16000;
          break;
        case 107:
          rawName = 'EVS';
          bandwidth = 'SWB';
          isHeaderFull = false;
          clockRate = 32000;
          break;
        case 111:
          rawName = 'opus';
          clockRate = 48000;
          break;
        default:
          rawName = `PT-${stream.payloadType}`;
      }
    }

    const upper = rawName.toUpperCase();
    let normalizedCodec: CodecInfo['normalizedCodec'] = 'UNKNOWN';
    if (upper.includes('PCMU') || stream.payloadType === 0) {
      normalizedCodec = 'PCMU';
    } else if (upper.includes('PCMA') || stream.payloadType === 8) {
      normalizedCodec = 'PCMA';
    } else if (upper.includes('G722') || stream.payloadType === 9) {
      normalizedCodec = 'G722';
    } else if (upper.includes('AMR-WB') || upper.includes('AMRWB') || stream.payloadType === 101) {
      normalizedCodec = 'AMR-WB';
    } else if (upper.includes('AMR') || stream.payloadType === 100) {
      normalizedCodec = 'AMR';
    } else if (upper.includes('OPUS') || stream.payloadType === 111) {
      normalizedCodec = 'OPUS';
    } else if (upper.includes('EVS')) {
      if (isHeaderFull || upper.includes('EVS-HF') || upper.includes('-HF')) {
        normalizedCodec = 'EVS-HF';
      } else {
        normalizedCodec = 'EVS';
      }
      if (bandwidth === 'SWB') {
        clockRate = 32000;
      } else if (bandwidth === 'WB') {
        clockRate = 16000;
      } else if (bandwidth === 'NB') {
        clockRate = 8000;
      } else if (bandwidth === 'FB') {
        clockRate = 48000;
      } else {
        clockRate = 32000;
      }
    } else if (upper.includes('264') || upper.includes('H264')) {
      normalizedCodec = 'H264';
      if (!clockRate) clockRate = 90000;
    } else if (upper.includes('VP8')) {
      normalizedCodec = 'VP8';
      if (!clockRate) clockRate = 90000;
    }

    return {
      name: rawName,
      normalizedCodec,
      clockRate,
      octetAligned,
      bandwidth,
      isHeaderFull,
    };
  }

  /**
   * Decodes an RTP stream into 16-bit linear PCM and nominal playback sample rate.
   * If fillSilenceGaps is true (default), compensates for silence suppression (VAD/DTX)
   * by padding timestamp/packet gaps with silence (zeros)
   * so playback and WAV export span the full real-time duration of the clip.
   */
  public static async decodeStream(
    stream: RtpStream,
    dialogs: SipDialog[] = [],
    fillSilenceGaps: boolean = true
  ): Promise<DecodedAudio> {
    const info = StreamAudioDecoder.resolveCodec(stream, dialogs);

    if (stream.packets.length === 0) {
      return { pcm: new Int16Array(0), sampleRate: info.clockRate || 8000, codec: info.name };
    }

    // For EVS streams, generate standard 3GPP TS 26.445 bitstream for export/download
    let bitstream: Uint8Array | undefined;
    let bitstreamExt: 'evs' | 'evs_hf' | undefined;
    if (info.normalizedCodec === 'EVS' || info.normalizedCodec === 'EVS-HF') {
      const isHeaderFull = info.normalizedCodec === 'EVS-HF';
      bitstream = EvsDepacketizer.depacketize(
        stream.packets.map(p => p.payload),
        isHeaderFull
      );
      bitstreamExt = isHeaderFull ? 'evs_hf' : 'evs';
    }

    let decodedAudio: DecodedAudio;
    if (!fillSilenceGaps || stream.packets.length <= 1) {
      decodedAudio = await StreamAudioDecoder.decodePacketsRaw(stream.packets, info);
    } else {
      decodedAudio = await StreamAudioDecoder.decodeStreamWithSilencePadding(stream, info);
    }

    if (bitstream && bitstreamExt) {
      decodedAudio.bitstream = bitstream;
      decodedAudio.bitstreamExt = bitstreamExt;
    }

    return decodedAudio;
  }

  private static async decodeStreamWithSilencePadding(
    stream: RtpStream,
    info: CodecInfo
  ): Promise<DecodedAudio> {
    const sampleRate =
      info.normalizedCodec === 'G722' || info.normalizedCodec === 'AMR-WB'
        ? 16000
        : info.normalizedCodec === 'OPUS'
        ? 48000
        : info.normalizedCodec === 'EVS' || info.normalizedCodec === 'EVS-HF'
        ? (info.clockRate || (info.bandwidth === 'NB' ? 8000 : info.bandwidth === 'WB' ? 16000 : 32000))
        : 8000;
    const totalDuration = stream.endTime - stream.startTime;

    // Detect bursts separated by silence gap > 40ms
    const bursts: Array<{ startTime: number; packets: typeof stream.packets }> = [];
    let currentBurst: typeof stream.packets = [stream.packets[0]];
    let burstStart = stream.packets[0].pktTime;

    for (let i = 1; i < stream.packets.length; i++) {
      const prev = stream.packets[i - 1];
      const curr = stream.packets[i];
      const gapSec = curr.pktTime - prev.pktTime;
      if (gapSec > 0.04) {
        bursts.push({ startTime: burstStart, packets: currentBurst });
        currentBurst = [curr];
        burstStart = curr.pktTime;
      } else {
        currentBurst.push(curr);
      }
    }
    if (currentBurst.length > 0) {
      bursts.push({ startTime: burstStart, packets: currentBurst });
    }

    const totalExpectedSamples = Math.ceil(totalDuration * sampleRate) + 640;
    let paddedPcm = new Int16Array(totalExpectedSamples);
    let maxEnd = 0;

    for (const burst of bursts) {
      const targetOffset = Math.round((burst.startTime - stream.startTime) * sampleRate);
      const decodedBurst = await StreamAudioDecoder.decodePacketsRaw(burst.packets, info);
      const burstPcm = decodedBurst.pcm;

      if (targetOffset + burstPcm.length > paddedPcm.length) {
        const extended = new Int16Array(targetOffset + burstPcm.length + 640);
        extended.set(paddedPcm.subarray(0, maxEnd));
        paddedPcm = extended;
      }

      paddedPcm.set(burstPcm, targetOffset);
      maxEnd = Math.max(maxEnd, targetOffset + burstPcm.length);
    }

    return {
      pcm: paddedPcm.subarray(0, maxEnd),
      sampleRate,
      codec:
        info.normalizedCodec === 'AMR'
          ? 'AMR-NB'
          : info.normalizedCodec === 'EVS' || info.normalizedCodec === 'EVS-HF'
          ? `${info.normalizedCodec} (${info.bandwidth || 'SWB'})`
          : info.name,
    };
  }

  private static async decodePacketsRaw(
    packets: Array<{ payload: Uint8Array; timestamp?: number }>,
    info: CodecInfo
  ): Promise<DecodedAudio> {
    switch (info.normalizedCodec) {
      case 'PCMU': {
        const raw = StreamAudioDecoder.concatPackets(packets);
        const pcm = G711Decoder.decodeUlaw(raw);
        return { pcm, sampleRate: 8000, codec: 'PCMU' };
      }

      case 'PCMA': {
        const raw = StreamAudioDecoder.concatPackets(packets);
        const pcm = G711Decoder.decodeAlaw(raw);
        return { pcm, sampleRate: 8000, codec: 'PCMA' };
      }

      case 'G722': {
        const raw = StreamAudioDecoder.concatPackets(packets);
        const pcm = G722Decoder.decodeG722(raw);
        return { pcm, sampleRate: 16000, codec: 'G722' };
      }

      case 'AMR': {
        const payloads = packets.map(p => p.payload);
        const res = await AmrDecoder.decodeRtpPayloads(payloads, false, info.octetAligned);
        const bitstream = AmrDepacketizer.depacketize(payloads, false, info.octetAligned);
        return { pcm: res.pcm, sampleRate: res.sampleRate || 8000, codec: 'AMR-NB', bitstream, bitstreamExt: 'amr' };
      }

      case 'AMR-WB': {
        const payloads = packets.map(p => p.payload);
        const res = await AmrDecoder.decodeRtpPayloads(payloads, true, info.octetAligned);
        const bitstream = AmrDepacketizer.depacketize(payloads, true, info.octetAligned);
        return { pcm: res.pcm, sampleRate: res.sampleRate || 16000, codec: 'AMR-WB', bitstream, bitstreamExt: 'amrwb' };
      }

      case 'EVS':
      case 'EVS-HF': {
        const isHeaderFull = info.normalizedCodec === 'EVS-HF';
        const payloads = packets.map(p => p.payload);
        const bitstream = EvsDepacketizer.depacketize(payloads, isHeaderFull);
        const sampleRate =
          info.bandwidth === 'NB'
            ? 8000
            : info.bandwidth === 'WB'
            ? 16000
            : info.bandwidth === 'FB'
            ? 48000
            : 32000;
        try {
          const { pcm } = await EvsDecoder.decodePayloads(payloads, isHeaderFull, sampleRate);
          return {
            pcm,
            sampleRate,
            codec: `${info.normalizedCodec} (${info.bandwidth || 'SWB'})`,
            bitstream,
            bitstreamExt: isHeaderFull ? 'evs_hf' : 'evs',
          };
        } catch (err) {
          console.warn('WASM EVS decoder failed, falling back to envelope synthesis:', err);
          const fakePackets = packets.map((p, idx) => ({
            pktTime: idx * 0.02,
            payload: p.payload,
          }));
          const pcm = EvsDepacketizer.generateEnvelopePcm(
            fakePackets,
            sampleRate,
            0,
            packets.length * 0.02,
            isHeaderFull
          );
          return {
            pcm,
            sampleRate,
            codec: `${info.normalizedCodec} (${info.bandwidth || 'SWB'})`,
            bitstream,
            bitstreamExt: isHeaderFull ? 'evs_hf' : 'evs',
          };
        }
      }

      case 'OPUS': {
        if (!OpusDecoder.isSupported()) {
          throw new Error('WebCodecs Opus decoding is not supported in this browser environment.');
        }
        const floatPcm = await OpusDecoder.decodePackets(
          packets.map(p => ({ timestamp: p.timestamp || 0, payload: p.payload })),
          48000,
          1
        );
        const pcm = new Int16Array(floatPcm.length);
        for (let i = 0; i < floatPcm.length; i++) {
          pcm[i] = Math.max(-32768, Math.min(32767, Math.round(floatPcm[i] * 32768)));
        }
        return { pcm, sampleRate: 48000, codec: 'Opus' };
      }

      default:
        return { pcm: new Int16Array(0), sampleRate: info.clockRate || 8000, codec: info.name };
    }
  }

  public static concatPackets(packets: Array<{ payload: Uint8Array }>): Uint8Array {
    const total = packets.reduce((a, p) => a + p.payload.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of packets) {
      out.set(p.payload, off);
      off += p.payload.length;
    }
    return out;
  }
}
