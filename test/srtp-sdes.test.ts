import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SdesParser } from '../src/srtp/SdesParser.ts';
import { SrtpContext } from '../src/srtp/SrtpContext.ts';
import { Aes } from '../src/crypto/Aes.ts';
import { HmacSha1 } from '../src/crypto/HmacSha1.ts';
import type { SdesCrypto } from '../src/srtp/SrtpTypes.ts';

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/\s+/g, '');
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('SDES Parser & SRTP/SRTCP Unprotect Engine (SdesParser.ts & SrtpContext.ts)', () => {

  describe('1. RFC 4568 SDES Line Parsing', () => {
    it('parses standard AES_CM_128_HMAC_SHA1_80 with inline master key and salt', () => {
      // 30 bytes raw (16B key + 14B salt) encoded in base64
      // Key:  0102030405060708090a0b0c0d0e0f10
      // Salt: 1112131415161718191a1b1c1d1e
      const b64 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e';
      const line = `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`;

      const res = SdesParser.parseCryptoLine(line);
      assert.ok(res, 'Must successfully parse crypto line');
      assert.equal(res.tag, 1);
      assert.equal(res.cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
      assert.equal(res.masterKey.length, 16);
      assert.equal(res.masterSalt.length, 14);
      assert.equal(bytesToHex(res.masterKey), '0102030405060708090A0B0C0D0E0F10');
      assert.equal(bytesToHex(res.masterSalt), '1112131415161718191A1B1C1D1E');
    });

    it('parses crypto line with lifetime and MKI parameter', () => {
      const b64 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e';
      const line = `a=crypto:2 AES_CM_128_HMAC_SHA1_32 inline:${b64}|2^20|1:4`;

      const res = SdesParser.parseCryptoLine(line);
      assert.ok(res);
      assert.equal(res.tag, 2);
      assert.equal(res.cryptoSuite, 'AES_CM_128_HMAC_SHA1_32');
      assert.equal(res.lifetime, 1048576); // 2^20
      assert.equal(res.mkiValue, 1);
      assert.equal(res.mkiLength, 4);
    });

    it('parses optional session parameters (UNENCRYPTED_SRTP, KDR)', () => {
      const b64 = 'AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0e';
      const line = `a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64} UNENCRYPTED_SRTP KDR=1024`;

      const res = SdesParser.parseCryptoLine(line);
      assert.ok(res);
      assert.equal(res.unencryptedSrtp, true);
      assert.equal(res.kdr, 1024);
    });
  });

  describe('2. SRTP Packet Decryption & Authentication', () => {
    it('decrypts an authenticated SRTP packet and restores exact plaintext payload', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);

      // Create a synthetic RTP packet: 12 bytes header + 16 bytes plaintext payload
      const ssrc = 0x12345678;
      const seq = 100;
      const ts = 960;
      const pt = 0; // PCMU
      const plaintextPayload = new TextEncoder().encode('SRTP_TEST_DATA16'); // exactly 16 bytes

      const rtpPacket = new Uint8Array(12 + plaintextPayload.length);
      const view = new DataView(rtpPacket.buffer);
      view.setUint8(0, 0x80); // V=2, P=0, X=0, CC=0
      view.setUint8(1, pt);
      view.setUint16(2, seq, false);
      view.setUint32(4, ts, false);
      view.setUint32(8, ssrc, false);
      rtpPacket.set(plaintextPayload, 12);

      // Encrypt packet to create test SRTP ciphertext
      const masterCipher = new Aes(masterKey);
      const ke = masterCipher.deriveSrtpKey(masterSalt, 0x00, 0, 16);
      const ka = masterCipher.deriveSrtpKey(masterSalt, 0x01, 0, 20);
      const ks = masterCipher.deriveSrtpKey(masterSalt, 0x02, 0, 14);

      // Build IV for seq 100, roc 0
      const iv = new Uint8Array(16);
      iv.set(ks, 0); // Copy full 14-byte ks
      iv[4] ^= ((ssrc >>> 24) & 0xff);
      iv[5] ^= ((ssrc >>> 16) & 0xff);
      iv[6] ^= ((ssrc >>> 8) & 0xff);
      iv[7] ^= (ssrc & 0xff);
      iv[12] ^= ((seq >>> 8) & 0xff);
      iv[13] ^= (seq & 0xff);
      iv[14] = 0;
      iv[15] = 0;

      const encCipher = new Aes(ke);
      const encryptedPacket = new Uint8Array(12 + plaintextPayload.length + 10);
      encryptedPacket.set(rtpPacket.subarray(0, 12), 0);
      encryptedPacket.set(plaintextPayload, 12);

      // Process CTR in place on payload
      encCipher.processCtr(iv, encryptedPacket, 12, plaintextPayload.length);

      // Compute HMAC-SHA1 tag over (Header || Ciphertext || ROC=0)
      const authData = new Uint8Array(12 + plaintextPayload.length + 4);
      authData.set(encryptedPacket.subarray(0, 12 + plaintextPayload.length), 0);
      const rocView = new DataView(authData.buffer, 12 + plaintextPayload.length, 4);
      rocView.setUint32(0, 0, false);

      const tag = HmacSha1.computeTag(ka, authData, 10);
      encryptedPacket.set(tag, 12 + plaintextPayload.length);

      // Now unprotect via SrtpContext
      const res = ctx.unprotectRtp(encryptedPacket);

      assert.equal(res.authValid, true, 'Auth tag must be valid');
      assert.equal(res.roc, 0);
      assert.equal(res.packetIndex, 100);
      assert.equal(res.decryptedPacket.length, 12 + plaintextPayload.length);

      const decryptedPayload = res.decryptedPacket.subarray(12);
      assert.equal(new TextDecoder().decode(decryptedPayload), 'SRTP_TEST_DATA16');
      assert.equal(ctx.getAuthPassRate(ssrc), 100);
    });

    it('handles 16-bit sequence number wrap-around and increments ROC', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);
      const ssrc = 0x99887766;

      const state = ctx.getStreamState(ssrc);
      // Simulate arriving at sequence 65535
      ctx.estimateIndex(state, 65535);
      assert.equal(state.roc, 0);

      // Next packet wraps to sequence 0
      const nextIndex = ctx.estimateIndex(state, 0);
      assert.equal(nextIndex.roc, 1, 'ROC must increment on sequence wrap');
      assert.equal(nextIndex.packetIndex, 65536);
    });

    it('probes and discovers non-zero ROC for mid-call captures', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_80',
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);
      const ssrc = 0x55443322;
      const seq = 12345;
      const targetRoc = 3; // Stream started before capture and is already on ROC=3

      const packet = new Uint8Array(12 + 8 + 10);
      const view = new DataView(packet.buffer);
      view.setUint8(0, 0x80);
      view.setUint16(2, seq, false);
      view.setUint32(8, ssrc, false);

      const ka = new Aes(masterKey).deriveSrtpKey(masterSalt, 0x01, 0, 20);
      const authData = new Uint8Array(20 + 4);
      authData.set(packet.subarray(0, 20), 0);
      new DataView(authData.buffer, 20, 4).setUint32(0, targetRoc, false);
      const tag = HmacSha1.computeTag(ka, authData, 10);
      packet.set(tag, 20);

      const res = ctx.unprotectRtp(packet);
      assert.equal(res.authValid, true, 'Must successfully probe and authenticate ROC=3');
      assert.equal(res.roc, targetRoc);
    });
  });

  describe('3. SRTCP Unprotect Engine', () => {
    it('decrypts encrypted SRTCP packet with mandatory 10-byte tag and verifies auth', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AES_CM_128_HMAC_SHA1_32', // Even with _32 suite, SRTCP tag is 80-bit (10B)!
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);
      const ssrc = 0x11223344;
      const srtcpIndex = 5;

      // RTCP Sender Report header: 8 bytes
      // Payload: 20 bytes
      // Trailer: 4 bytes (E=1 || index=5)
      // Auth Tag: 10 bytes
      const totalLen = 8 + 20 + 4 + 10;
      const packet = new Uint8Array(totalLen);
      const view = new DataView(packet.buffer);
      view.setUint8(0, 0x80); // V=2, RC=0
      view.setUint8(1, 200);  // PT=200 (SR)
      view.setUint16(2, 6, false); // length in words - 1
      view.setUint32(4, ssrc, false);

      // Trailing word: E=1 (bit 31), index=5
      view.setUint32(8 + 20, 0x80000000 | srtcpIndex, false);

      // Derive SRTCP keys
      const masterCipher = new Aes(masterKey);
      const keRtcp = masterCipher.deriveSrtpKey(masterSalt, 0x03, 0, 16);
      const kaRtcp = masterCipher.deriveSrtpKey(masterSalt, 0x04, 0, 20);
      const ksRtcp = masterCipher.deriveSrtpKey(masterSalt, 0x05, 0, 14);

      // IV for index 5
      const iv = new Uint8Array(16);
      iv.set(ksRtcp, 0); // Copy full 14-byte ksRtcp
      iv[4] ^= ((ssrc >>> 24) & 0xff);
      iv[5] ^= ((ssrc >>> 16) & 0xff);
      iv[6] ^= ((ssrc >>> 8) & 0xff);
      iv[7] ^= (ssrc & 0xff);
      iv[13] ^= srtcpIndex;
      iv[14] = 0;
      iv[15] = 0;

      const plainPayload = new TextEncoder().encode('RTCP_ENCRYPTED_PAYLD');
      packet.set(plainPayload, 8);

      // Encrypt in-place
      new Aes(keRtcp).processCtr(iv, packet, 8, 20);

      // Compute 10-byte auth tag over packet[0..32]
      const tag = HmacSha1.computeTag(kaRtcp, packet.subarray(0, 8 + 20 + 4), 10);
      packet.set(tag, 8 + 20 + 4);

      // Unprotect
      const res = ctx.unprotectRtcp(packet);
      assert.equal(res.authValid, true, 'SRTCP auth must be valid');
      assert.equal(res.srtcpIndex, 5);
      assert.equal(res.decryptedPacket.length, 28); // Header (8) + decrypted payload (20)

      const decryptedPayload = res.decryptedPacket.subarray(8);
      assert.equal(new TextDecoder().decode(decryptedPayload), 'RTCP_ENCRYPTED_PAYLD');
    });
  });
});
