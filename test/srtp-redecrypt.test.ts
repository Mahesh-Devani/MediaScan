import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { StreamDecryptor } from '../src/srtp/StreamDecryptor.ts';
import { SrtpContext } from '../src/srtp/SrtpContext.ts';
import { SdesParser } from '../src/srtp/SdesParser.ts';
import { Aes } from '../src/crypto/Aes.ts';
import { HmacSha1 } from '../src/crypto/HmacSha1.ts';
import { StreamAudioDecoder } from '../src/decoders/StreamAudioDecoder.ts';
import { LinkType } from '../src/pcap/PacketTypes.ts';
import type { RtpStream, RtpPacket } from '../src/rtp/RtpDemuxer.ts';
import type { SdesCrypto } from '../src/srtp/SrtpTypes.ts';

// Encrypt helper
function encryptRtp(
  header12: Uint8Array,
  plaintextPayload: Uint8Array,
  seq: number,
  ssrc: number,
  crypto: SdesCrypto
): Uint8Array {
  const masterCipher = new Aes(crypto.masterKey);
  const ke = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x00, 0, 16);
  const ka = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x01, 0, 20);
  const ks = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x02, 0, 14);

  const iv = new Uint8Array(16);
  iv.set(ks, 0);
  iv[4] ^= ((ssrc >>> 24) & 0xff);
  iv[5] ^= ((ssrc >>> 16) & 0xff);
  iv[6] ^= ((ssrc >>> 8) & 0xff);
  iv[7] ^= (ssrc & 0xff);
  iv[12] ^= ((seq >>> 8) & 0xff);
  iv[13] ^= (seq & 0xff);

  const cipher = new Aes(ke);
  const ciphertext = new Uint8Array(plaintextPayload);
  cipher.processCtr(iv, ciphertext);

  const srtpPacket = new Uint8Array(12 + ciphertext.length + 10);
  srtpPacket.set(header12, 0);
  srtpPacket.set(ciphertext, 12);

  const authData = new Uint8Array(12 + ciphertext.length + 4);
  authData.set(srtpPacket.subarray(0, 12 + ciphertext.length), 0);
  const tag = HmacSha1.computeTag(ka, authData, 10);
  srtpPacket.set(tag, 12 + ciphertext.length);

  return srtpPacket;
}

// Builds an Ethernet/IPv4/UDP packet wrapped in classic PCAP record
function buildPcapPacket(
  srcIp: string,
  dstIp: string,
  srcPort: number,
  dstPort: number,
  payload: Uint8Array,
  timestampSec: number
): Uint8Array {
  const ethHeaderLen = 14;
  const ipHeaderLen = 20;
  const udpHeaderLen = 8;
  const totalIpLen = ipHeaderLen + udpHeaderLen + payload.length;
  const frameLen = ethHeaderLen + totalIpLen;

  const frame = new Uint8Array(frameLen);
  const fv = new DataView(frame.buffer);
  fv.setUint16(12, 0x0800, false);

  const ipOffset = ethHeaderLen;
  fv.setUint8(ipOffset, 0x45);
  fv.setUint16(ipOffset + 2, totalIpLen, false);
  fv.setUint8(ipOffset + 8, 64);
  fv.setUint8(ipOffset + 9, 17); // UDP
  const srcParts = srcIp.split('.').map(Number);
  const dstParts = dstIp.split('.').map(Number);
  frame.set(srcParts, ipOffset + 12);
  frame.set(dstParts, ipOffset + 16);

  const udpOffset = ipOffset + ipHeaderLen;
  fv.setUint16(udpOffset, srcPort, false);
  fv.setUint16(udpOffset + 2, dstPort, false);
  fv.setUint16(udpOffset + 4, udpHeaderLen + payload.length, false);
  frame.set(payload, udpOffset + udpHeaderLen);

  const record = new Uint8Array(16 + frameLen);
  const rv = new DataView(record.buffer);
  const sec = Math.floor(timestampSec);
  const usec = Math.floor((timestampSec - sec) * 1_000_000);
  rv.setUint32(0, sec, true);
  rv.setUint32(4, usec, true);
  rv.setUint32(8, frameLen, true);
  rv.setUint32(12, frameLen, true);
  record.set(frame, 16);

  return record;
}

describe('StreamDecryptor: Selective In-Memory & File.slice() Re-decryption', () => {
  it('selectively re-decrypts an encrypted stream using packet offsets', async () => {
    const b64 = 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY';
    const crypto = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`)!;
    assert.ok(crypto);

    const ssrc = 0x99887766;
    const records: Uint8Array[] = [];
    const packetIndices: Array<{ offset: number; length: number; timestampSec: number }> = [];
    const rtpPackets: RtpPacket[] = [];

    // Global PCAP header = 24 bytes
    let curOffset = 24;

    // 160 bytes G.711 silence (0xFF)
    const silence = new Uint8Array(160);
    silence.fill(0xff);

    for (let i = 0; i < 5; i++) {
      const seq = 500 + i;
      const ts = 16000 + i * 160;
      const header = new Uint8Array(12);
      const hv = new DataView(header.buffer);
      hv.setUint8(0, 0x80);
      hv.setUint8(1, 0); // PCMU
      hv.setUint16(2, seq, false);
      hv.setUint32(4, ts, false);
      hv.setUint32(8, ssrc, false);

      const srtp = encryptRtp(header, silence, seq, ssrc, crypto);
      const time = 10.0 + i * 0.02;
      const rec = buildPcapPacket('10.0.0.1', '10.0.0.2', 12345, 54321, srtp, time);

      // In PCAP record, the frame data is at offset 16 within the record
      const frameOffset = curOffset + 16;
      const frameLen = rec.length - 16;

      packetIndices.push({
        offset: frameOffset,
        length: frameLen,
        timestampSec: time,
      });

      // Initial unresolved stream packet holds ciphertext payload
      rtpPackets.push({
        version: 2,
        padding: false,
        extension: false,
        csrcCount: 0,
        marker: false,
        payloadType: 0,
        sequenceNumber: seq,
        timestamp: ts,
        ssrc,
        payload: srtp.subarray(12), // Ciphertext + tag
        pktTime: time,
      });

      records.push(rec);
      curOffset += rec.length;
    }

    // Assemble pcap buffer
    const globalHeader = new Uint8Array(24);
    const gv = new DataView(globalHeader.buffer);
    gv.setUint32(0, 0xa1b2c3d4, true);
    gv.setUint16(4, 2, true);
    gv.setUint16(6, 4, true);
    gv.setUint32(16, 65535, true);
    gv.setUint32(20, 1, true); // ETHERNET

    const totalLen = curOffset;
    const pcapBytes = new Uint8Array(totalLen);
    pcapBytes.set(globalHeader, 0);
    let o = 24;
    for (const r of records) {
      pcapBytes.set(r, o);
      o += r.length;
    }

    const stream: RtpStream = {
      id: 's-test',
      ssrc,
      payloadType: 0,
      srcIp: '10.0.0.1',
      srcPort: 12345,
      dstIp: '10.0.0.2',
      dstPort: 54321,
      startTime: 10.0,
      endTime: 10.08,
      firstSeq: 500,
      lastSeq: 504,
      packetCount: 5,
      octetCount: 5 * 160,
      lossCount: 0,
      lossPercent: 0,
      jitterUs: 100,
      clockRate: 8000,
      packets: rtpPackets,
      isEncrypted: true,
      isDecrypted: false,
      encryptedPacketIndex: packetIndices,
    };

    // Verify initially undecrypted
    assert.equal(stream.isDecrypted, false);

    // Perform selective re-decryption
    const srtpCtx = new SrtpContext(crypto);
    const success = await StreamDecryptor.redecryptStream({
      stream,
      source: pcapBytes,
      linkType: LinkType.ETHERNET,
      context: srtpCtx,
    });

    assert.equal(success, true);
    assert.equal(stream.isDecrypted, true);
    assert.equal(stream.authPassRate, 100);

    // Check decoded audio is restored
    const decoded = await StreamAudioDecoder.decodeStream(stream);
    assert.equal(decoded.pcm.length, 5 * 160);
    for (let j = 0; j < decoded.pcm.length; j++) {
      assert.equal(decoded.pcm[j], 0, `Sample ${j} must decode to exact silence (0)`);
    }

    // Also verify with Blob / File simulation
    const blobSource = new Blob([pcapBytes]);
    const successBlob = await StreamDecryptor.redecryptStream({
      stream,
      source: blobSource,
      linkType: LinkType.ETHERNET,
      context: srtpCtx,
    });
    assert.equal(successBlob, true);
  });
});
