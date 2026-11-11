import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Aes } from '../src/crypto/Aes.ts';
import { HmacSha1 } from '../src/crypto/HmacSha1.ts';

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

describe('Cryptographic Primitives Engine (Aes.ts & HmacSha1.ts)', () => {

  describe('1. FIPS-197 AES Block Cipher (ECB)', () => {
    it('encrypts AES-128 single block matching FIPS-197 Appendix B vector', () => {
      const key = hexToBytes('2b7e151628aed2a6abf7158809cf4f3c');
      const plaintext = hexToBytes('3243f6a8885a308d313198a2e0370734');
      const expectedCiphertext = '3925841D02DC09FBDC118597196A0B32';

      const cipher = new Aes(key);
      const out = new Uint8Array(16);
      cipher.encryptBlock(plaintext, 0, out, 0);

      assert.equal(bytesToHex(out), expectedCiphertext);
    });

    it('encrypts AES-192 single block matching FIPS-197 Appendix C.2 vector', () => {
      const key = hexToBytes('8e73b0f7da0e6452c810f32b809079e562f8ead2522c6b7b');
      const plaintext = hexToBytes('6bc1bee22e409f96e93d7e117393172a');
      const expectedCiphertext = 'BD334F1D6E45F25FF712A214571FA5CC';

      const cipher = new Aes(key);
      const out = new Uint8Array(16);
      cipher.encryptBlock(plaintext, 0, out, 0);

      assert.equal(bytesToHex(out), expectedCiphertext);
    });

    it('encrypts AES-256 single block matching FIPS-197 Appendix C.3 vector', () => {
      const key = hexToBytes('603deb1015ca71be2b73aef0857d77811f352c073b6108d72d9810a30914dff4');
      const plaintext = hexToBytes('6bc1bee22e409f96e93d7e117393172a');
      const expectedCiphertext = 'F3EED1BDB5D2A03C064B5A7E3DB181F8';

      const cipher = new Aes(key);
      const out = new Uint8Array(16);
      cipher.encryptBlock(plaintext, 0, out, 0);

      assert.equal(bytesToHex(out), expectedCiphertext);
    });
  });

  describe('2. RFC 3711 Appendix B.2 — AES-CM PRF Keystream Verification', () => {
    it('generates exact keystream blocks matching RFC 3711 App. B.2 test vector', () => {
      const key = hexToBytes('2B7E151628AED2A6ABF7158809CF4F3C');
      const iv = hexToBytes('F0F1F2F3F4F5F6F7F8F9FAFBFCFD0000');

      const expectedBlock0 = 'E03EAD0935C95E80E166B16DD92B4EB4';
      const expectedBlock1 = 'D23513162B02D0F72A43A2FE4A5F97AB';

      const cipher = new Aes(key);
      const keystream = cipher.ctrKeystream(iv, 32);

      assert.equal(bytesToHex(keystream.subarray(0, 16)), expectedBlock0, 'Block 0 mismatch');
      assert.equal(bytesToHex(keystream.subarray(16, 32)), expectedBlock1, 'Block 1 mismatch');
    });
  });

  describe('3. RFC 3711 Appendix B.3 — Key Derivation Function (KDF)', () => {
    it('derives exact session encryption, auth, and salt keys matching RFC 3711 App. B.3', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      // RFC 3711 App. B.3 official test vectors:
      const expectedKe = 'C61E7A93744F39EE10734AFE3FF7A087';
      const expectedKa = 'CEBE321F6FF7716B6FD4AB49AF256A156D38BAA4';
      const expectedKs = '30CBBC08863D8C85D49DB34A9AE1';

      const cipher = new Aes(masterKey);

      // Label 0x00: Session Encryption Key (16 bytes)
      const ke = cipher.deriveSrtpKey(masterSalt, 0x00, 0, 16);
      assert.equal(bytesToHex(ke), expectedKe, 'SRTP Encryption Key (k_e) mismatch');

      // Label 0x01: Session Authentication Key (20 bytes for HMAC-SHA1)
      const ka = cipher.deriveSrtpKey(masterSalt, 0x01, 0, 20);
      assert.equal(bytesToHex(ka), expectedKa, 'SRTP Authentication Key (k_a) mismatch');

      // Label 0x02: Session Salting Key (14 bytes)
      const ks = cipher.deriveSrtpKey(masterSalt, 0x02, 0, 14);
      assert.equal(bytesToHex(ks), expectedKs, 'SRTP Salting Key (k_s) mismatch');
    });

    it('derives SRTCP keys with labels 0x03, 0x04, and 0x05', () => {
      const masterKey = hexToBytes('E1F97A0D3E018BE0D64FA32C06DE4139');
      const masterSalt = hexToBytes('0EC675AD498AFEEBB6960B3AABE6');

      const cipher = new Aes(masterKey);
      const keRtcp = cipher.deriveSrtpKey(masterSalt, 0x03, 0, 16);
      const kaRtcp = cipher.deriveSrtpKey(masterSalt, 0x04, 0, 20);
      const ksRtcp = cipher.deriveSrtpKey(masterSalt, 0x05, 0, 14);

      assert.equal(keRtcp.length, 16, 'SRTCP k_e length must be 16 bytes');
      assert.equal(kaRtcp.length, 20, 'SRTCP k_a length must be 20 bytes');
      assert.equal(ksRtcp.length, 14, 'SRTCP k_s length must be 14 bytes');
      assert.notEqual(bytesToHex(keRtcp), bytesToHex(cipher.deriveSrtpKey(masterSalt, 0x00, 0, 16)), 'SRTCP k_e must differ from SRTP k_e');
    });
  });

  describe('4. HMAC-SHA1 RFC 2202 & RFC 3711 Auth Tag Computation', () => {
    it('computes exact HMAC-SHA1 matching RFC 2202 Test Case 1', () => {
      const key = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
      const data = new TextEncoder().encode('Hi There');
      const expectedDigest = 'B617318655057264E28BC0B6FB378C8EF146BE00';

      const digest = HmacSha1.compute(key, data);
      assert.equal(bytesToHex(digest), expectedDigest);
    });

    it('truncates HMAC-SHA1 to 80 bits (10 bytes) for _80 suites and SRTCP', () => {
      const key = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
      const data = new TextEncoder().encode('Hi There');

      const tag80 = HmacSha1.computeTag(key, data, 10);
      assert.equal(tag80.length, 10);
      assert.equal(bytesToHex(tag80), 'B617318655057264E28B');
    });

    it('truncates HMAC-SHA1 to 32 bits (4 bytes) for _32 suites', () => {
      const key = hexToBytes('0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b');
      const data = new TextEncoder().encode('Hi There');

      const tag32 = HmacSha1.computeTag(key, data, 4);
      assert.equal(tag32.length, 4);
      assert.equal(bytesToHex(tag32), 'B6173186');
    });
  });
});
