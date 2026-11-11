import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HmacSha256 } from '../src/crypto/HmacSha256.ts';
import { DtlsParser } from '../src/dtls/DtlsParser.ts';
import { DtlsExporter, prfTls12 } from '../src/dtls/DtlsExporter.ts';
import { SrtpKeyRegistry } from '../src/srtp/SrtpKeyRegistry.ts';
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
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
}

describe('Phase 3: DTLS 1.2 Handshake, RFC 5705 Exporter & DTLS-SRTP Integration', () => {

  describe('1. Cryptographic Primitives: SHA-256 and HMAC-SHA256 (RFC 4231)', () => {
    it('computes exact SHA-256 hash', () => {
      // Test vector: SHA-256("abc") = ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad
      const input = new TextEncoder().encode('abc');
      const hash = HmacSha256.sha256(input);
      assert.equal(bytesToHex(hash), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    });

    it('computes exact HMAC-SHA256 matching RFC 4231 Test Case 1', () => {
      // Key: 20 bytes 0x0b
      const key = new Uint8Array(20);
      key.fill(0x0b);
      // Data: "Hi There"
      const data = new TextEncoder().encode('Hi There');
      const hmac = HmacSha256.compute(key, data);
      assert.equal(bytesToHex(hmac), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
    });
  });

  describe('2. RFC 7983 Demuxing (STUN vs DTLS vs RTP)', () => {
    it('correctly classifies first-byte ranges', () => {
      // STUN: 0..19
      assert.equal(DtlsParser.isStun(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])), true);
      assert.equal(DtlsParser.isDtls(new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19])), false);

      // DTLS: 20..63 (ContentType 20=ChangeCipherSpec, 21=Alert, 22=Handshake, 23=AppData)
      for (const ct of [20, 21, 22, 23]) {
        const dtlsPacket = new Uint8Array(13);
        dtlsPacket[0] = ct;
        assert.equal(DtlsParser.isDtls(dtlsPacket), true);
        assert.equal(DtlsParser.isStun(dtlsPacket), false);
      }

      // RTP: 128..191 (Version 2)
      const rtpPacket = new Uint8Array([0x80, 0x00, 0x00, 0x01]);
      assert.equal(DtlsParser.isDtls(rtpPacket), false);
      assert.equal(DtlsParser.isStun(rtpPacket), false);
    });
  });

  describe('3. DTLS 1.2 Handshake Parser (ClientHello & ServerHello use_srtp)', () => {
    it('parses ClientHello random and ServerHello use_srtp extension', () => {
      const clientRandom = new Uint8Array(32);
      clientRandom.fill(0xaa);

      const serverRandom = new Uint8Array(32);
      serverRandom.fill(0xbb);

      // Build synthetic DTLS 1.2 ClientHello record
      // Record header (13B) + Handshake header (12B) + ClientHello body
      const chBodyLen = 2 + 32 + 1 + 1 + 2 + 1 + 2; // version(2) + random(32) + sessIdLen(1) + cookieLen(1) + ciphers(2) + comp(1) + exts(2)
      const chRecord = new Uint8Array(13 + 12 + chBodyLen);
      const chv = new DataView(chRecord.buffer);
      chv.setUint8(0, 22); // Handshake
      chv.setUint16(1, 0xfefd, false); // DTLS 1.2
      chv.setUint16(11, 12 + chBodyLen, false); // Record Length
      // Handshake header
      chv.setUint8(13, 1); // ClientHello
      chv.setUint8(14, (chBodyLen >> 16) & 0xff);
      chv.setUint16(15, chBodyLen & 0xffff, false);
      chv.setUint16(17, 0, false); // message_seq
      chv.setUint16(23, chBodyLen, false); // fragment_length
      // ClientHello body
      chv.setUint16(25, 0xfefd, false); // client_version
      chRecord.set(clientRandom, 27); // random (32 bytes)

      // Build synthetic DTLS 1.2 ServerHello record with use_srtp extension (0x000E)
      // ServerHello body: version(2) + random(32) + sessIdLen(0)(1) + cipher(2) + comp(1) + extsLen(2) + extType(2) + extLen(2) + srtpProfilesLen(2) + profile(2) + mki(1)
      const extDataLen = 2 + 2 + 1; // 2B profiles len + 2B profile + 1B mki
      const extsLen = 4 + extDataLen; // 2B type + 2B len + extData
      const shBodyLen = 2 + 32 + 1 + 2 + 1 + 2 + extsLen;

      const shRecord = new Uint8Array(13 + 12 + shBodyLen);
      const shv = new DataView(shRecord.buffer);
      shv.setUint8(0, 22);
      shv.setUint16(1, 0xfefd, false);
      shv.setUint16(11, 12 + shBodyLen, false);
      // Handshake header
      shv.setUint8(13, 2); // ServerHello
      shv.setUint16(15, shBodyLen, false);
      shv.setUint16(23, shBodyLen, false);
      // ServerHello body
      shv.setUint16(25, 0xfefd, false);
      shRecord.set(serverRandom, 27);
      shv.setUint8(59, 0); // session_id len = 0
      shv.setUint16(60, 0xc02b, false); // cipher suite
      shv.setUint8(62, 0); // compression method 0
      shv.setUint16(63, extsLen, false); // extensions length
      // use_srtp extension (0x000E)
      shv.setUint16(65, 0x000e, false); // extension type = 14
      shv.setUint16(67, extDataLen, false); // extension length
      shv.setUint16(69, 2, false); // profiles length = 2
      shv.setUint16(71, 0x0001, false); // SRTP_AES128_CM_HMAC_SHA1_80
      shv.setUint8(73, 0); // mki length = 0

      const state: any = {};
      DtlsParser.parseHandshake(chRecord, '192.168.1.50:5000', '192.168.1.100:5000', state);
      assert.ok(state.clientRandom);
      assert.equal(bytesToHex(state.clientRandom), bytesToHex(clientRandom));
      assert.equal(state.clientEndpoint, '192.168.1.50:5000');

      DtlsParser.parseHandshake(shRecord, '192.168.1.100:5000', '192.168.1.50:5000', state);
      assert.ok(state.serverRandom);
      assert.equal(bytesToHex(state.serverRandom), bytesToHex(serverRandom));
      assert.equal(state.negotiatedProfile, 'AES_CM_128_HMAC_SHA1_80');
    });
  });

  describe('4. RFC 5705 Key Material Exporter & KeyRegistry Derivation', () => {
    it('derives client and server SRTP keys from NSS master secret', () => {
      const clientRandom = hexToBytes('2049e6d0a7f185799a6cfd774a3b10b00c3bca1ef23d6a9a791a8e3100df3f95');
      const serverRandom = hexToBytes('77112233445566778899aabbccddeeff00112233445566778899aabbccddeeff');
      const masterSecret = hexToBytes('44b36055d784a0d92233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899');

      const keys = DtlsExporter.exportKeys(
        masterSecret,
        clientRandom,
        serverRandom,
        'AES_CM_128_HMAC_SHA1_80'
      );

      assert.equal(keys.clientKey.length, 16);
      assert.equal(keys.serverKey.length, 16);
      assert.equal(keys.clientSalt.length, 14);
      assert.equal(keys.serverSalt.length, 14);

      // Verify keys are deterministic and distinct for client vs server
      assert.notEqual(bytesToHex(keys.clientKey), bytesToHex(keys.serverKey));
      assert.notEqual(bytesToHex(keys.clientSalt), bytesToHex(keys.serverSalt));

      // Register into KeyRegistry via NSS key log
      const registry = new SrtpKeyRegistry();
      const crHex = bytesToHex(clientRandom);
      const msHex = bytesToHex(masterSecret);
      registry.registerNssKeyLog(crHex, msHex);

      const dtlsInfo = {
        clientRandom,
        serverRandom,
        negotiatedProfile: 'AES_CM_128_HMAC_SHA1_80' as const,
        clientEndpoint: '10.0.0.1:10000',
        serverEndpoint: '10.0.0.2:20000',
      };

      const success = registry.registerDtlsHandshake(dtlsInfo);
      assert.equal(success, true);

      // Client endpoint should resolve client's context
      const clientCtx = registry.getContextForPacket(0, '10.0.0.1', 10000, '10.0.0.2', 20000);
      assert.ok(clientCtx);

      // Server endpoint should resolve server's context
      const serverCtx = registry.getContextForPacket(0, '10.0.0.2', 20000, '10.0.0.1', 10000);
      assert.ok(serverCtx);
    });
  });
});
