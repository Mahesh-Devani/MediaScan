import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import { SrtpKeyRegistry } from '../src/srtp/SrtpKeyRegistry.ts';
import { SdesParser } from '../src/srtp/SdesParser.ts';
import { Aes } from '../src/crypto/Aes.ts';
import { HmacSha1 } from '../src/crypto/HmacSha1.ts';
import { LadderSvgRenderer } from '../src/ladder/LadderSvgRenderer.ts';
import type { SdesCrypto } from '../src/srtp/SrtpTypes.ts';

function encryptRtp(
  header12: Uint8Array,
  plaintextPayload: Uint8Array,
  seq: number,
  ssrc: number,
  crypto: SdesCrypto,
  roc: number = 0
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

  const index48 = (BigInt(roc) << 16n) | BigInt(seq);
  iv[8] ^= Number((index48 >> 40n) & 0xffn);
  iv[9] ^= Number((index48 >> 32n) & 0xffn);
  iv[10] ^= Number((index48 >> 24n) & 0xffn);
  iv[11] ^= Number((index48 >> 16n) & 0xffn);
  iv[12] ^= Number((index48 >> 8n) & 0xffn);
  iv[13] ^= Number(index48 & 0xffn);

  const cipher = new Aes(ke);
  const ciphertext = new Uint8Array(plaintextPayload);
  cipher.processCtr(iv, ciphertext);

  const srtpPacket = new Uint8Array(12 + ciphertext.length + 10);
  srtpPacket.set(header12, 0);
  srtpPacket.set(ciphertext, 12);

  const authData = new Uint8Array(12 + ciphertext.length + 4);
  authData.set(srtpPacket.subarray(0, 12 + ciphertext.length), 0);
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  view.setUint32(12 + ciphertext.length, roc, false);

  const tag = HmacSha1.computeTag(ka, authData, 10);
  srtpPacket.set(tag, 12 + ciphertext.length);

  return srtpPacket;
}

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
  fv.setUint8(ipOffset + 1, 0);
  fv.setUint16(ipOffset + 2, totalIpLen, false);
  fv.setUint16(ipOffset + 4, 0x1234, false);
  fv.setUint8(ipOffset + 8, 64);
  fv.setUint8(ipOffset + 9, 17);

  frame.set(srcIp.split('.').map(Number), ipOffset + 12);
  frame.set(dstIp.split('.').map(Number), ipOffset + 16);

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

function buildPcapFile(records: Uint8Array[]): Uint8Array {
  const globalHeader = new Uint8Array(24);
  const gv = new DataView(globalHeader.buffer);
  gv.setUint32(0, 0xa1b2c3d4, true);
  gv.setUint16(4, 2, true);
  gv.setUint16(6, 4, true);
  gv.setUint32(16, 65535, true);
  gv.setUint32(20, 1, true);

  const totalLen = 24 + records.reduce((sum, r) => sum + r.length, 0);
  const pcap = new Uint8Array(totalLen);
  pcap.set(globalHeader, 0);

  let offset = 24;
  for (const r of records) {
    pcap.set(r, offset);
    offset += r.length;
  }
  return pcap;
}

describe('Phase 4: Non-Regression, Failure Containment & Kill Switch Verification', () => {
  beforeEach(() => {
    SrtpKeyRegistry.setKillSwitch(false);
  });

  afterEach(() => {
    SrtpKeyRegistry.setKillSwitch(false);
  });

  it('Rule 3: never flags plain RTP as encrypted even with high-entropy Opus/AMR-like payload', () => {
    const records: Uint8Array[] = [];
    const ssrc = 0x55556666;
    let time = 1.0;

    for (let i = 0; i < 10; i++) {
      time += 0.02;
      const header = new Uint8Array(12);
      const hv = new DataView(header.buffer);
      hv.setUint8(0, 0x80); // V=2
      hv.setUint8(1, 96);   // Dynamic PT (e.g. Opus)
      hv.setUint16(2, 2000 + i, false);
      hv.setUint32(4, 160000 + i * 960, false);
      hv.setUint32(8, ssrc, false);

      // High entropy pseudorandom bytes (looks random)
      const randomPayload = new Uint8Array(120);
      for (let b = 0; b < randomPayload.length; b++) {
        randomPayload[b] = (b * 37 + i * 19 + 73) & 0xff;
      }

      const packet = new Uint8Array(12 + randomPayload.length);
      packet.set(header, 0);
      packet.set(randomPayload, 12);

      records.push(buildPcapPacket('10.0.0.1', '10.0.0.2', 15000, 25000, packet, time));
    }

    const pcapBytes = buildPcapFile(records);
    const result = CapturePipeline.process(pcapBytes);

    assert.equal(result.streams.length, 1);
    const stream = result.streams[0];
    assert.equal(Boolean(stream.isEncrypted), false, 'Plain RTP stream must NOT be flagged as encrypted');
    assert.equal(Boolean(stream.isDecrypted), false, 'Plain RTP stream must NOT be flagged as decrypted');
    assert.equal(stream.encryptedPacketIndex, undefined, 'Plain RTP must have no encrypted packet index');
  });

  it('Rule 5: gracefully contains bad keys and corrupted auth tags without throwing or breaking pipeline', async () => {
    const aliceIp = '10.1.1.1';
    const bobIp = '10.1.1.2';
    const ssrc = 0x77778888;
    const keyB64 = 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY';
    const wrongKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const crypto = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${keyB64}`)!;

    const inviteSdp = [
      'v=0',
      `o=alice 100 100 IN IP4 ${aliceIp}`,
      's=Call',
      `c=IN IP4 ${aliceIp}`,
      't=0 0',
      'm=audio 12000 RTP/SAVP 0',
      'a=rtpmap:0 PCMU/8000',
      // Intentionally wrong key in SDP to test authentication failure / bad key handling
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${wrongKeyB64}`,
      '',
    ].join('\r\n');

    const sipInvite = [
      'INVITE sip:bob@10.1.1.2 SIP/2.0',
      'Via: SIP/2.0/UDP 10.1.1.1:5060;branch=z9hG4bK-fail-1',
      'From: <sip:alice@10.1.1.1>;tag=a-fail',
      'To: <sip:bob@10.1.1.2>',
      'Call-ID: call-fail-test@10.1.1.1',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${inviteSdp.length}`,
      '',
      inviteSdp,
    ].join('\r\n');

    const okSdp = [
      'v=0',
      `o=bob 200 200 IN IP4 ${bobIp}`,
      's=Call',
      `c=IN IP4 ${bobIp}`,
      't=0 0',
      'm=audio 22000 RTP/SAVP 0',
      'a=rtpmap:0 PCMU/8000',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${wrongKeyB64}`,
      '',
    ].join('\r\n');

    const sip200Ok = [
      'SIP/2.0 200 OK',
      'Via: SIP/2.0/UDP 10.1.1.1:5060;branch=z9hG4bK-fail-1',
      'From: <sip:alice@10.1.1.1>;tag=a-fail',
      'To: <sip:bob@10.1.1.2>;tag=b-fail',
      'Call-ID: call-fail-test@10.1.1.1',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${okSdp.length}`,
      '',
      okSdp,
    ].join('\r\n');

    const records: Uint8Array[] = [];
    records.push(buildPcapPacket(aliceIp, bobIp, 5060, 5060, new TextEncoder().encode(sipInvite), 1.0));
    records.push(buildPcapPacket(bobIp, aliceIp, 5060, 5060, new TextEncoder().encode(sip200Ok), 1.05));

    // Valid audio encrypted with the original key (not the wrong key)
    const audioPayload = new Uint8Array(160);
    audioPayload.fill(0xff);

    for (let i = 0; i < 5; i++) {
      const header = new Uint8Array(12);
      const hv = new DataView(header.buffer);
      hv.setUint8(0, 0x80);
      hv.setUint8(1, 0);
      hv.setUint16(2, 500 + i, false);
      hv.setUint32(4, 8000 + i * 160, false);
      hv.setUint32(8, ssrc, false);

      const srtpPkt = encryptRtp(header, audioPayload, 500 + i, ssrc, crypto, 0);
      records.push(buildPcapPacket(aliceIp, bobIp, 12000, 22000, srtpPkt, 1.1 + i * 0.02));
    }

    const pcapBytes = buildPcapFile(records);

    // Pipeline must complete without throwing
    const result = CapturePipeline.process(pcapBytes);
    assert.equal(result.streams.length, 1);
    const stream = result.streams[0];

    assert.equal(stream.isEncrypted, true);
    // Since tag verification failed with mismatched key, authPassRate is 0%
    assert.equal(stream.authPassRate, 0);

    // Verify the ladder displays the '🔒 Key Invalid' error badge
    assert.ok(result.conversations.length > 0);
    const svg = LadderSvgRenderer.render(result.conversations[0], {
      mediaServerIp: result.mediaServer?.ip || '10.1.1.2',
    });
    assert.ok(svg.includes('🔒 Key Invalid'), 'Ladder must render 🔒 Key Invalid badge when auth fails');
    assert.ok(svg.includes('SRTP Auth Failed: Key Invalid'), 'Tooltip must indicate key invalid');
  });

  it('Rule 9: Emergency Kill Switch bypasses all SRTP decryption and restores raw capture behavior', () => {
    const aliceIp = '10.2.2.1';
    const bobIp = '10.2.2.2';
    const ssrc = 0x99990000;
    const keyB64 = 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY';
    const crypto = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${keyB64}`)!;

    const inviteSdp = [
      'v=0',
      `o=alice 200 200 IN IP4 ${aliceIp}`,
      's=Call',
      `c=IN IP4 ${aliceIp}`,
      't=0 0',
      'm=audio 14000 RTP/SAVP 0',
      'a=rtpmap:0 PCMU/8000',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${keyB64}`,
      '',
    ].join('\r\n');

    const sipInvite = [
      'INVITE sip:bob@10.2.2.2 SIP/2.0',
      'Via: SIP/2.0/UDP 10.2.2.1:5060;branch=z9hG4bK-kill-1',
      'From: <sip:alice@10.2.2.1>;tag=a-kill',
      'To: <sip:bob@10.2.2.2>',
      'Call-ID: call-kill-test@10.2.2.1',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${inviteSdp.length}`,
      '',
      inviteSdp,
    ].join('\r\n');

    const okSdp = [
      'v=0',
      `o=bob 300 300 IN IP4 ${bobIp}`,
      's=Call',
      `c=IN IP4 ${bobIp}`,
      't=0 0',
      'm=audio 24000 RTP/SAVP 0',
      'a=rtpmap:0 PCMU/8000',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${keyB64}`,
      '',
    ].join('\r\n');

    const sip200Ok = [
      'SIP/2.0 200 OK',
      'Via: SIP/2.0/UDP 10.2.2.1:5060;branch=z9hG4bK-kill-1',
      'From: <sip:alice@10.2.2.1>;tag=a-kill',
      'To: <sip:bob@10.2.2.2>;tag=b-kill',
      'Call-ID: call-kill-test@10.2.2.1',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${okSdp.length}`,
      '',
      okSdp,
    ].join('\r\n');

    const records: Uint8Array[] = [];
    records.push(buildPcapPacket(aliceIp, bobIp, 5060, 5060, new TextEncoder().encode(sipInvite), 1.0));
    records.push(buildPcapPacket(bobIp, aliceIp, 5060, 5060, new TextEncoder().encode(sip200Ok), 1.05));

    const audioPayload = new Uint8Array(160);
    audioPayload.fill(0xff);

    for (let i = 0; i < 5; i++) {
      const header = new Uint8Array(12);
      const hv = new DataView(header.buffer);
      hv.setUint8(0, 0x80);
      hv.setUint8(1, 0);
      hv.setUint16(2, 600 + i, false);
      hv.setUint32(4, 9000 + i * 160, false);
      hv.setUint32(8, ssrc, false);

      const srtpPkt = encryptRtp(header, audioPayload, 600 + i, ssrc, crypto, 0);
      records.push(buildPcapPacket(aliceIp, bobIp, 14000, 24000, srtpPkt, 1.1 + i * 0.02));
    }

    const pcapBytes = buildPcapFile(records);

    // 1. Normal execution: decrypted
    const normalResult = CapturePipeline.process(pcapBytes);
    assert.equal(normalResult.streams[0].isDecrypted, true);

    // 2. Kill switch active: decryption bypassed
    SrtpKeyRegistry.setKillSwitch(true);
    const killedResult = CapturePipeline.process(pcapBytes);
    assert.equal(killedResult.streams[0].isDecrypted, false);

    // 3. Toggle back off
    SrtpKeyRegistry.setKillSwitch(false);
    const restoredResult = CapturePipeline.process(pcapBytes);
    assert.equal(restoredResult.streams[0].isDecrypted, true);
  });
});
