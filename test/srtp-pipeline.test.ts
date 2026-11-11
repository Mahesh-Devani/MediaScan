import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import { SrtpKeyRegistry } from '../src/srtp/SrtpKeyRegistry.ts';
import { SdesParser } from '../src/srtp/SdesParser.ts';
import { Aes } from '../src/crypto/Aes.ts';
import { HmacSha1 } from '../src/crypto/HmacSha1.ts';
import { StreamAudioDecoder } from '../src/decoders/StreamAudioDecoder.ts';
import { LadderSvgRenderer } from '../src/ladder/LadderSvgRenderer.ts';
import type { SdesCrypto } from '../src/srtp/SrtpTypes.ts';

// Helper to encrypt an RTP packet into SRTP (AES-CM-128 + HMAC-SHA1-80)
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

  // Compute IV: ks XOR (ssrc << 64 | index << 16)
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

  // Auth tag over header + ciphertext + ROC (4 bytes BE)
  const authData = new Uint8Array(12 + ciphertext.length + 4);
  authData.set(srtpPacket.subarray(0, 12 + ciphertext.length), 0);
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  view.setUint32(12 + ciphertext.length, roc, false);

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

  // Ethernet header (0x0800 = IPv4)
  fv.setUint16(12, 0x0800, false);

  // IPv4 header
  const ipOffset = ethHeaderLen;
  fv.setUint8(ipOffset, 0x45); // Version 4, IHL 5
  fv.setUint8(ipOffset + 1, 0); // DSCP
  fv.setUint16(ipOffset + 2, totalIpLen, false);
  fv.setUint16(ipOffset + 4, 0x1234, false); // ID
  fv.setUint16(ipOffset + 6, 0x0000, false); // Flags/Offset
  fv.setUint8(ipOffset + 8, 64); // TTL
  fv.setUint8(ipOffset + 9, 17); // UDP (17)
  fv.setUint16(ipOffset + 10, 0, false); // Checksum (0)

  const srcParts = srcIp.split('.').map(Number);
  const dstParts = dstIp.split('.').map(Number);
  frame.set(srcParts, ipOffset + 12);
  frame.set(dstParts, ipOffset + 16);

  // UDP header
  const udpOffset = ipOffset + ipHeaderLen;
  fv.setUint16(udpOffset, srcPort, false);
  fv.setUint16(udpOffset + 2, dstPort, false);
  fv.setUint16(udpOffset + 4, udpHeaderLen + payload.length, false);
  fv.setUint16(udpOffset + 6, 0, false); // UDP Checksum (0)

  // Payload
  frame.set(payload, udpOffset + udpHeaderLen);

  // Wrap in classic PCAP record header (16 bytes)
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

// Builds full PCAP file buffer from packet records
function buildPcapFile(records: Uint8Array[]): Uint8Array {
  const globalHeader = new Uint8Array(24);
  const gv = new DataView(globalHeader.buffer);
  gv.setUint32(0, 0xa1b2c3d4, true); // Little endian magic
  gv.setUint16(4, 2, true); // Major 2
  gv.setUint16(6, 4, true); // Minor 4
  gv.setInt32(8, 0, true); // GMT to local
  gv.setUint32(12, 0, true); // Accuracy
  gv.setUint32(16, 65535, true); // Snaplen
  gv.setUint32(20, 1, true); // LINKTYPE_ETHERNET (1)

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

describe('SRTP End-to-End Pipeline & Media Flow Ladder Integration', () => {
  beforeEach(() => {
    SrtpKeyRegistry.setKillSwitch(false);
  });

  afterEach(() => {
    SrtpKeyRegistry.setKillSwitch(false);
  });

  it('end-to-end parses SIP offer/answer SDES keys, unprotects SRTP audio, and updates ladder', async () => {
    const aliceIp = '192.168.1.10';
    const alicePort = 10000;
    const bobIp = '192.168.1.20';
    const bobPort = 20000;

    // Keys in base64 (30 bytes: 16B key + 14B salt)
    const aliceB64 = 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY';
    const bobB64 = 'd0Rmdm5BiRhEgNOtPu5/XajcdtUmPlhErWBnDUqa';

    const aliceCrypto = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${aliceB64}`)!;
    const bobCrypto = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${bobB64}`)!;

    assert.ok(aliceCrypto);
    assert.ok(bobCrypto);

    // 1. SIP INVITE (Alice -> Bob)
    const inviteSdp = [
      'v=0',
      `o=alice 1000 1000 IN IP4 ${aliceIp}`,
      's=SRTP Call',
      `c=IN IP4 ${aliceIp}`,
      't=0 0',
      `m=audio ${alicePort} RTP/SAVP 0`,
      'a=rtpmap:0 PCMU/8000',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${aliceB64}`,
      '',
    ].join('\r\n');

    const sipInvite = [
      'INVITE sip:bob@192.168.1.20 SIP/2.0',
      'Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK-inv-1',
      'From: <sip:alice@192.168.1.10>;tag=alice-tag',
      'To: <sip:bob@192.168.1.20>',
      'Call-ID: srtp-call-1@192.168.1.10',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${inviteSdp.length}`,
      '',
      inviteSdp,
    ].join('\r\n');

    // 2. SIP 200 OK (Bob -> Alice)
    const okSdp = [
      'v=0',
      `o=bob 2000 2000 IN IP4 ${bobIp}`,
      's=SRTP Call',
      `c=IN IP4 ${bobIp}`,
      't=0 0',
      `m=audio ${bobPort} RTP/SAVP 0`,
      'a=rtpmap:0 PCMU/8000',
      `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${bobB64}`,
      '',
    ].join('\r\n');

    const sip200Ok = [
      'SIP/2.0 200 OK',
      'Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK-inv-1',
      'From: <sip:alice@192.168.1.10>;tag=alice-tag',
      'To: <sip:bob@192.168.1.20>;tag=bob-tag',
      'Call-ID: srtp-call-1@192.168.1.10',
      'CSeq: 1 INVITE',
      'Content-Type: application/sdp',
      `Content-Length: ${okSdp.length}`,
      '',
      okSdp,
    ].join('\r\n');

    // 3. SIP ACK (Alice -> Bob)
    const sipAck = [
      'ACK sip:bob@192.168.1.20 SIP/2.0',
      'Via: SIP/2.0/UDP 192.168.1.10:5060;branch=z9hG4bK-ack-1',
      'From: <sip:alice@192.168.1.10>;tag=alice-tag',
      'To: <sip:bob@192.168.1.20>;tag=bob-tag',
      'Call-ID: srtp-call-1@192.168.1.10',
      'CSeq: 1 ACK',
      'Content-Length: 0',
      '',
      '',
    ].join('\r\n');

    const encoder = new TextEncoder();
    const records: Uint8Array[] = [];

    let time = 1.0;
    records.push(buildPcapPacket(aliceIp, bobIp, 5060, 5060, encoder.encode(sipInvite), time));
    time += 0.05;
    records.push(buildPcapPacket(bobIp, aliceIp, 5060, 5060, encoder.encode(sip200Ok), time));
    time += 0.02;
    records.push(buildPcapPacket(aliceIp, bobIp, 5060, 5060, encoder.encode(sipAck), time));

    // 4. Generate 10 SRTP packets Alice -> Bob (SSRC 0x11112222)
    // 160 bytes of G.711 PCMU silence (0xFF decodes to exact 0 in PCMU)
    const audioPayload = new Uint8Array(160);
    audioPayload.fill(0xff);

    const aliceSsrc = 0x11112222;
    const bobSsrc = 0x33334444;

    for (let i = 0; i < 10; i++) {
      time += 0.02; // 20ms ptime
      const seq = 1000 + i;
      const ts = 80000 + i * 160;

      // Alice -> Bob RTP header
      const headerA = new Uint8Array(12);
      const hvA = new DataView(headerA.buffer);
      hvA.setUint8(0, 0x80); // V=2
      hvA.setUint8(1, 0);    // PT=0 (PCMU)
      hvA.setUint16(2, seq, false);
      hvA.setUint32(4, ts, false);
      hvA.setUint32(8, aliceSsrc, false);

      const srtpPktA = encryptRtp(headerA, audioPayload, seq, aliceSsrc, aliceCrypto, 0);
      records.push(buildPcapPacket(aliceIp, bobIp, alicePort, bobPort, srtpPktA, time));

      // Bob -> Alice RTP header
      const headerB = new Uint8Array(12);
      const hvB = new DataView(headerB.buffer);
      hvB.setUint8(0, 0x80);
      hvB.setUint8(1, 0);
      hvB.setUint16(2, seq, false);
      hvB.setUint32(4, ts, false);
      hvB.setUint32(8, bobSsrc, false);

      const srtpPktB = encryptRtp(headerB, audioPayload, seq, bobSsrc, bobCrypto, 0);
      records.push(buildPcapPacket(bobIp, aliceIp, bobPort, alicePort, srtpPktB, time));
    }

    const pcapBytes = buildPcapFile(records);

    // Process capture
    const result = CapturePipeline.process(pcapBytes);

    // Verify streams
    assert.equal(result.streams.length, 2, 'Must detect 2 media streams');
    for (const s of result.streams) {
      assert.equal(s.isEncrypted, true, `Stream ${s.ssrc} must be marked isEncrypted: true`);
      assert.equal(s.isDecrypted, true, `Stream ${s.ssrc} must be marked isDecrypted: true`);
      assert.equal(s.cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
      assert.equal(s.authPassRate, 100, 'All packets must authenticate with 100% pass rate');
      assert.ok(s.encryptedPacketIndex, 'Encrypted streams must build an encryptedPacketIndex');
      assert.equal(s.encryptedPacketIndex!.length, 10, 'Index must track all 10 packets');
      assert.equal(s.packetCount, 10);

      // Verify audio decoding restores valid audio from decrypted payload
      const decoded = await StreamAudioDecoder.decodeStream(s);
      assert.ok(decoded, `Stream ${s.ssrc} audio decoding must succeed`);
      assert.equal(decoded.sampleRate, 8000);
      assert.equal(decoded.pcm.length, 10 * 160, 'Decoded samples must match total RTP audio samples');

      // In PCMU, 0xD5 decodes to ~0 amplitude (silence, around 0 to 8).
      // If payload were still ciphertext, amplitude variance would be massive (~30,000).
      let maxAbs = 0;
      for (let j = 0; j < decoded.pcm.length; j++) {
        const absVal = Math.abs(decoded.pcm[j]);
        if (absVal > maxAbs) maxAbs = absVal;
      }
      assert.equal(maxAbs, 0, `Decoded silence must have exact 0 amplitude, got ${maxAbs}`);
    }

    // Verify Ladder SVG contains the 🔒 SRTP badge
    assert.ok(result.conversations.length > 0, 'Conversation must be formed');
    const svg = LadderSvgRenderer.render(result.conversations[0], {
      mediaServerIp: result.mediaServer?.ip || '192.168.1.20',
    });
    assert.ok(svg.includes('ladder-srtp-badge'), 'SVG must include ladder-srtp-badge');
    assert.ok(svg.includes('🔒 SRTP'), 'SVG must render 🔒 SRTP badge');

    // 5. Verify Kill Switch
    SrtpKeyRegistry.setKillSwitch(true);
    const resultKill = CapturePipeline.process(pcapBytes);
    assert.equal(resultKill.streams.length, 2);
    for (const s of resultKill.streams) {
      // With kill switch, no keys are retrieved so streams remain encrypted but NOT decrypted
      assert.equal(s.isDecrypted, false, 'Kill switch must prevent decryption');
    }
  });
});
