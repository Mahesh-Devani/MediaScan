import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Aes } from '../src/crypto/Aes.ts';
import { SrtpContext } from '../src/srtp/SrtpContext.ts';
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

describe('Phase 2: RFC 7714 AEAD_AES_128_GCM and AEAD_AES_256_GCM Engines', () => {

  describe('1. RFC 7714 Section 16.1 — AEAD_AES_128_GCM Test Vectors', () => {
    // 12-octet RTP header (AAD)
    const aad = hexToBytes('8040f17b 8041f8d3 5501a0b2');
    // 38-octet plaintext payload ("Gallia est omnis divisa in partes tres")
    const plaintext = hexToBytes('47616c6c 69612065 7374206f 6d6e6973 20646976 69736120 696e2070 61727465 73207472 6573');
    // Master Key (16 octets)
    const masterKey = hexToBytes('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f');
    // Master Salt (12 octets: "Quid pro quo")
    const masterSalt = hexToBytes('51 75 69 64 20 70 72 6f 20 71 75 6f');
    // Expected Derived IV
    const expectedIv = hexToBytes('51 75 3c 65 80 c2 72 6f 20 71 84 14');
    // Expected Ciphertext (38 octets)
    const expectedCt = hexToBytes('f24de3a3 fb34de6c acba861c 9d7e4bca be633bd5 0d294e6f 42a5f47a 51c7d19b 36de3adf 8833');
    // Expected 16-octet GMAC Tag
    const expectedTag = hexToBytes('899d7f27 beb16a91 52cf765e e4390cce');

    it('derives exact RFC 7714 12-octet IV from SSRC, ROC, SEQ and salt', () => {
      const ssrc = 0x5501a0b2;
      const roc = 0;
      const seq = 0xf17b;

      const iv = new Uint8Array(12);
      iv.set(masterSalt, 0);
      iv[2] ^= ((ssrc >>> 24) & 0xff);
      iv[3] ^= ((ssrc >>> 16) & 0xff);
      iv[4] ^= ((ssrc >>> 8) & 0xff);
      iv[5] ^= (ssrc & 0xff);
      iv[6] ^= ((roc >>> 24) & 0xff);
      iv[7] ^= ((roc >>> 16) & 0xff);
      iv[8] ^= ((roc >>> 8) & 0xff);
      iv[9] ^= (roc & 0xff);
      iv[10] ^= ((seq >>> 8) & 0xff);
      iv[11] ^= (seq & 0xff);

      assert.equal(bytesToHex(iv), bytesToHex(expectedIv));
    });

    it('encrypts and authenticates matching RFC 7714 Section 16.1.1 vector byte-for-byte', () => {
      const cipher = new Aes(masterKey);
      const res = cipher.encryptGcm(expectedIv, plaintext, aad, 16);

      assert.equal(bytesToHex(res.ciphertext), bytesToHex(expectedCt));
      assert.equal(bytesToHex(res.tag), bytesToHex(expectedTag));
    });

    it('decrypts and verifies matching RFC 7714 Section 16.1.2 & 16.1.4 vector byte-for-byte', () => {
      const cipher = new Aes(masterKey);
      const res = cipher.decryptGcm(expectedIv, expectedCt, expectedTag, aad);

      assert.equal(res.authValid, true);
      assert.equal(bytesToHex(res.plaintext), bytesToHex(plaintext));
    });

    it('rejects tampered AAD or ciphertext in AES-GCM', () => {
      const cipher = new Aes(masterKey);
      // Tampered AAD
      const badAad = new Uint8Array(aad);
      badAad[0] ^= 0x01;
      const res1 = cipher.decryptGcm(expectedIv, expectedCt, expectedTag, badAad);
      assert.equal(res1.authValid, false);

      // Tampered Ciphertext
      const badCt = new Uint8Array(expectedCt);
      badCt[0] ^= 0x01;
      const res2 = cipher.decryptGcm(expectedIv, badCt, expectedTag, aad);
      assert.equal(res2.authValid, false);
    });
  });

  describe('2. RFC 7714 Section 16.2 — AEAD_AES_256_GCM Test Vectors', () => {
    const aad = hexToBytes('8040f17b 8041f8d3 5501a0b2');
    const plaintext = hexToBytes('47616c6c 69612065 7374206f 6d6e6973 20646976 69736120 696e2070 61727465 73207472 6573');
    // 32-octet (256-bit) Master Key
    const masterKey256 = hexToBytes('000102030405060708090a0b0c0d0e0f 101112131415161718191a1b1c1d1e1f');
    const masterSalt = hexToBytes('51 75 69 64 20 70 72 6f 20 71 75 6f');
    const expectedIv = hexToBytes('51 75 3c 65 80 c2 72 6f 20 71 84 14');

    it('encrypts, tags, and decrypts with 256-bit key via AES-GCM', () => {
      const cipher = new Aes(masterKey256);
      const enc = cipher.encryptGcm(expectedIv, plaintext, aad, 16);

      assert.equal(enc.ciphertext.length, plaintext.length);
      assert.equal(enc.tag.length, 16);

      const dec = cipher.decryptGcm(expectedIv, enc.ciphertext, enc.tag, aad);
      assert.equal(dec.authValid, true);
      assert.equal(bytesToHex(dec.plaintext), bytesToHex(plaintext));
    });
  });

  describe('3. SrtpContext Round-Trip with AEAD_AES_128_GCM and AEAD_AES_256_GCM', () => {
    it('unprotects SRTP packet with AEAD_AES_128_GCM', () => {
      const masterKey = hexToBytes('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f');
      const masterSalt = hexToBytes('51 75 69 64 20 70 72 6f 20 71 75 6f');
      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AEAD_AES_128_GCM',
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);

      // Create full packet matching RFC 7714: 12 bytes header + 38 bytes CT + 16 bytes Tag = 66 bytes
      const header = hexToBytes('8040f17b 8041f8d3 5501a0b2');
      const ct = hexToBytes('f24de3a3 fb34de6c acba861c 9d7e4bca be633bd5 0d294e6f 42a5f47a 51c7d19b 36de3adf 8833');
      const tag = hexToBytes('899d7f27 beb16a91 52cf765e e4390cce');

      const packet = new Uint8Array(12 + ct.length + tag.length);
      packet.set(header, 0);
      packet.set(ct, 12);
      packet.set(tag, 12 + ct.length);

      const res = ctx.unprotectRtp(packet);
      assert.equal(res.authValid, true);
      assert.equal(res.decryptedPacket.length, 12 + 38);
      // Decrypted payload should be Latin text
      const expectedPt = hexToBytes('47616c6c 69612065 7374206f 6d6e6973 20646976 69736120 696e2070 61727465 73207472 6573');
      assert.equal(bytesToHex(res.decryptedPacket.subarray(12)), bytesToHex(expectedPt));
    });

    it('unprotects SRTCP packet with AEAD_AES_128_GCM', () => {
      const masterKey = hexToBytes('00 01 02 03 04 05 06 07 08 09 0a 0b 0c 0d 0e 0f');
      const masterSalt = hexToBytes('51 75 69 64 20 70 72 6f 20 71 75 6f');
      const crypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: 'AEAD_AES_128_GCM',
        masterKey,
        masterSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };

      const ctx = new SrtpContext(crypto);

      const ssrc = 0x5501a0b2;
      const srtcpIndex = 1;

      // 8 bytes RTCP header + 20 bytes payload + 4 bytes index/E + 16 bytes tag
      const rtcpHeader = new Uint8Array(8);
      const hv = new DataView(rtcpHeader.buffer);
      hv.setUint8(0, 0x80);
      hv.setUint8(1, 200); // SR
      hv.setUint16(2, 6, false);
      hv.setUint32(4, ssrc, false);

      const plaintextPayload = new TextEncoder().encode('RTCP_GCM_SAMPLE_DATA'); // 20 bytes

      // Build IV per Section 9.1
      const iv = new Uint8Array(12);
      iv.set(masterSalt, 0);
      iv[2] ^= ((ssrc >>> 24) & 0xff);
      iv[3] ^= ((ssrc >>> 16) & 0xff);
      iv[4] ^= ((ssrc >>> 8) & 0xff);
      iv[5] ^= (ssrc & 0xff);
      iv[8] ^= ((srtcpIndex >>> 24) & 0xff);
      iv[9] ^= ((srtcpIndex >>> 16) & 0xff);
      iv[10] ^= ((srtcpIndex >>> 8) & 0xff);
      iv[11] ^= (srtcpIndex & 0xff);

      const aad = new Uint8Array(12);
      aad.set(rtcpHeader, 0);
      const indexWord = 0x80000000 | srtcpIndex; // E=1
      const av = new DataView(aad.buffer);
      av.setUint32(8, indexWord, false);

      const cipher = new Aes(masterKey);
      const enc = cipher.encryptGcm(iv, plaintextPayload, aad, 16);

      const srtcpPkt = new Uint8Array(8 + plaintextPayload.length + 4 + 16);
      srtcpPkt.set(rtcpHeader, 0);
      srtcpPkt.set(enc.ciphertext, 8);
      const pv = new DataView(srtcpPkt.buffer);
      pv.setUint32(8 + plaintextPayload.length, indexWord, false);
      srtcpPkt.set(enc.tag, 8 + plaintextPayload.length + 4);

      const res = ctx.unprotectRtcp(srtcpPkt);
      assert.equal(res.authValid, true);
      assert.equal(res.srtcpIndex, srtcpIndex);
      assert.equal(new TextDecoder().decode(res.decryptedPacket.subarray(8)), 'RTCP_GCM_SAMPLE_DATA');
    });
  });
});
