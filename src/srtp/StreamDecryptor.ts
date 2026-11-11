/**
 * StreamDecryptor.ts
 * Performs selective re-decryption of encrypted RTP streams using
 * per-packet file offsets (File.slice() or Uint8Array.subarray()) without
 * re-parsing the entire pcap capture.
 */

import { PcapParser } from '../pcap/PcapParser.ts';
import { RtpDemuxer } from '../rtp/RtpDemuxer.ts';
import { SrtpContext } from './SrtpContext.ts';
import type { RtpStream } from '../rtp/RtpDemuxer.ts';
import type { LinkType } from '../pcap/PacketTypes.ts';

export interface DecryptStreamOptions {
  stream: RtpStream;
  source: File | Blob | Uint8Array;
  linkType: LinkType;
  context: SrtpContext;
}

export class StreamDecryptor {
  /**
   * Selectively re-decrypts packets for a given stream using file offsets.
   */
  public static async redecryptStream(options: DecryptStreamOptions): Promise<boolean> {
    const { stream, source, linkType, context } = options;
    if (!stream.encryptedPacketIndex || stream.encryptedPacketIndex.length === 0) {
      return false;
    }

    const isBlob = typeof Blob !== 'undefined' && source instanceof Blob;
    const isUint8 = source instanceof Uint8Array;

    let decryptedCount = 0;
    const total = stream.encryptedPacketIndex.length;

    for (let i = 0; i < total; i++) {
      const idx = stream.encryptedPacketIndex[i];
      let packetBytes: Uint8Array;

      if (isBlob) {
        const slice = (source as Blob).slice(idx.offset, idx.offset + idx.length);
        const buf = await slice.arrayBuffer();
        packetBytes = new Uint8Array(buf);
      } else if (isUint8) {
        packetBytes = (source as Uint8Array).subarray(idx.offset, idx.offset + idx.length);
      } else {
        return false;
      }

      // Dissect the raw frame
      const pkt = {
        frameNumber: i + 1,
        timestampSec: idx.timestampSec,
        capturedLength: packetBytes.length,
        originalLength: packetBytes.length,
        data: packetBytes,
      };

      const dissected = PcapParser.dissectPacket(pkt, linkType);
      if (!dissected.payload || dissected.payload.length < 12) continue;

      try {
        const unprotectRes = context.unprotectRtp(dissected.payload);
        const parsedDecrypted = RtpDemuxer.parseRtp(unprotectRes.decryptedPacket);
        if (parsedDecrypted) {
          if (stream.packets[i]) {
            stream.packets[i].payload = parsedDecrypted.payload;
            decryptedCount++;
          }
        }
      } catch {
        // Individual packet auth/decrypt failure
      }
    }

    if (decryptedCount > 0) {
      stream.isEncrypted = true;
      stream.isDecrypted = true;
      stream.cryptoSuite = (context as any).crypto?.cryptoSuite;
      stream.authPassRate = context.getAuthPassRate(stream.ssrc);
      return true;
    }

    return false;
  }
}
