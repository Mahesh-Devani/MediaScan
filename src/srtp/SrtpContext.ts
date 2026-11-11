/**
 * SrtpContext.ts
 * RFC 3711 Secure Real-time Transport Protocol (SRTP) & Secure RTCP (SRTCP) unprotect engine.
 * Handles:
 * - Session key derivation (k_e, k_a, k_s for SRTP; k_e_rtcp, k_a_rtcp, k_s_rtcp for SRTCP)
 * - RFC 3711 Appendix A Rollover Counter (ROC) tracking
 * - Auth-tag-based ROC search for mid-call captures
 * - Payload decryption via AES-CTR (Aes.ts)
 * - HMAC-SHA1 tag verification and pass-rate statistics
 * - Padding removal post-decryption
 * - Zero replay dropping (analysis mode)
 */

import { Aes } from '../crypto/Aes.ts';
import { HmacSha1 } from '../crypto/HmacSha1.ts';
import { SdesParser } from './SdesParser.ts';
import type { SdesCrypto, SrtpCryptoSuite, SrtpStreamState, SrtpDecryptionResult } from './SrtpTypes.ts';

export class SrtpContext {
  private crypto: SdesCrypto;
  private cipherKe: Aes;
  private ka: Uint8Array;
  private ks: Uint8Array;

  // SRTCP keys
  private cipherKeRtcp: Aes;
  private kaRtcp: Uint8Array;
  private ksRtcp: Uint8Array;

  private tagLength: number;
  private streamStates = new Map<number, SrtpStreamState>();

  constructor(crypto: SdesCrypto) {
    this.crypto = crypto;
    const { keyLen, tagLen } = SdesParser.getKeyLengths(crypto.cryptoSuite);
    this.tagLength = tagLen;

    // 1. Derive SRTP session keys
    const masterCipher = new Aes(crypto.masterKey);
    const ke = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x00, 0, keyLen);
    this.cipherKe = new Aes(ke);
    this.ka = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x01, 0, 20); // 160-bit auth key
    this.ks = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x02, 0, 14); // 112-bit salt

    // 2. Derive SRTCP session keys (labels 0x03, 0x04, 0x05)
    const keRtcp = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x03, 0, keyLen);
    this.cipherKeRtcp = new Aes(keRtcp);
    this.kaRtcp = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x04, 0, 20);
    this.ksRtcp = masterCipher.deriveSrtpKey(crypto.masterSalt, 0x05, 0, 14);
  }

  /**
   * Retrieves or initializes per-SSRC state.
   */
  public getStreamState(ssrc: number): SrtpStreamState {
    let state = this.streamStates.get(ssrc);
    if (!state) {
      state = {
        ssrc,
        roc: 0,
        highestSeq: -1,
        initialized: false,
        authPassCount: 0,
        authFailCount: 0,
        totalPackets: 0,
      };
      this.streamStates.set(ssrc, state);
    }
    return state;
  }

  /**
   * Estimates packet index and updates ROC per RFC 3711 Appendix A.
   */
  public estimateIndex(state: SrtpStreamState, seq: number): { roc: number; packetIndex: number } {
    if (!state.initialized) {
      state.initialized = true;
      state.highestSeq = seq;
      return { roc: state.roc, packetIndex: state.roc * 65536 + seq };
    }

    const s_l = state.highestSeq;
    let v = state.roc;
    let vPrime = v;

    if (s_l < 32768) {
      if (seq - s_l > 32768) {
        vPrime = (v - 1) >>> 0;
      } else {
        vPrime = v;
      }
    } else {
      if (s_l - seq > 32768) {
        vPrime = (v + 1) >>> 0;
      } else {
        vPrime = v;
      }
    }

    if (vPrime > v || (vPrime === v && seq > s_l)) {
      state.highestSeq = seq;
      state.roc = vPrime;
    }

    return { roc: vPrime, packetIndex: vPrime * 65536 + seq };
  }

  /**
   * Builds the 16-byte keystream IV for SRTP (RFC 3711 Section 4.1.1).
   */
  private buildSrtpIv(ssrc: number, index: number): Uint8Array {
    const iv = new Uint8Array(16);
    // Bytes 0..3: ks[0..3]
    iv[0] = this.ks[0];
    iv[1] = this.ks[1];
    iv[2] = this.ks[2];
    iv[3] = this.ks[3];

    // Bytes 4..7: ks[4..7] ^ SSRC (32-bit big-endian)
    iv[4] = this.ks[4] ^ ((ssrc >>> 24) & 0xff);
    iv[5] = this.ks[5] ^ ((ssrc >>> 16) & 0xff);
    iv[6] = this.ks[6] ^ ((ssrc >>> 8) & 0xff);
    iv[7] = this.ks[7] ^ (ssrc & 0xff);

    // Bytes 8..13: ks[8..13] ^ 48-bit index
    const idxHigh = Math.floor(index / 0x100000000) & 0xffff;
    const idxLow = index >>> 0;

    iv[8] = this.ks[8] ^ ((idxHigh >>> 8) & 0xff);
    iv[9] = this.ks[9] ^ (idxHigh & 0xff);
    iv[10] = this.ks[10] ^ ((idxLow >>> 24) & 0xff);
    iv[11] = this.ks[11] ^ ((idxLow >>> 16) & 0xff);
    iv[12] = this.ks[12] ^ ((idxLow >>> 8) & 0xff);
    iv[13] = this.ks[13] ^ (idxLow & 0xff);

    // Bytes 14..15: 0x00, 0x00
    iv[14] = 0;
    iv[15] = 0;

    return iv;
  }

  /**
   * Verifies HMAC-SHA1 authentication tag over (Authenticated Portion || ROC).
   */
  private verifyAuthTag(
    packet: Uint8Array,
    authPortionLength: number,
    tagOffset: number,
    roc: number,
    isRtcp: boolean = false
  ): boolean {
    const ka = isRtcp ? this.kaRtcp : this.ka;
    const tagLen = isRtcp ? 10 : this.tagLength; // SRTCP is ALWAYS 10 bytes (RFC 3711 Section 4.3.3.2)

    if (packet.length < tagOffset + tagLen) {
      return false;
    }

    // Authenticated data: packet[0..authPortionLength] || 4-byte ROC (big-endian)
    let authData: Uint8Array;
    if (isRtcp) {
      // For SRTCP: authenticated portion includes the 4-byte SRTCP index/E-flag, but NO appended ROC
      authData = packet.subarray(0, authPortionLength);
    } else {
      authData = new Uint8Array(authPortionLength + 4);
      authData.set(packet.subarray(0, authPortionLength), 0);
      const rocView = new DataView(authData.buffer, authData.byteOffset + authPortionLength, 4);
      rocView.setUint32(0, roc, false);
    }

    const expectedTag = HmacSha1.computeTag(ka, authData, tagLen);
    const packetTag = packet.subarray(tagOffset, tagOffset + tagLen);

    for (let i = 0; i < tagLen; i++) {
      if (expectedTag[i] !== packetTag[i]) {
        return false;
      }
    }
    return true;
  }

  /**
   * Unprotects an SRTP packet.
   * Decrypts the payload, verifies auth tag, and strips auth tag + MKI + padding.
   */
  public unprotectRtp(packetBytes: Uint8Array): {
    decryptedPacket: Uint8Array;
    authValid: boolean;
    roc: number;
    packetIndex: number;
  } {
    if (packetBytes.length < 12) {
      throw new Error(`Packet too short for SRTP: ${packetBytes.length} bytes`);
    }

    const view = new DataView(packetBytes.buffer, packetBytes.byteOffset, packetBytes.byteLength);
    const firstByte = packetBytes[0];
    const cc = firstByte & 0x0f;
    const hasExtension = (firstByte & 0x10) !== 0;
    const hasPadding = (firstByte & 0x20) !== 0;

    let headerLen = 12 + cc * 4;
    if (hasExtension && packetBytes.length >= headerLen + 4) {
      const extLenWords = view.getUint16(headerLen + 2, false);
      headerLen += 4 + extLenWords * 4;
    }

    const seq = view.getUint16(2, false);
    const ssrc = view.getUint32(8, false);

    const mkiLen = this.crypto.mkiLength || 0;
    const tagLen = this.crypto.unauthenticatedSrtp ? 0 : this.tagLength;
    const trailerLen = mkiLen + tagLen;

    if (packetBytes.length < headerLen + trailerLen) {
      throw new Error(`Packet shorter than header + SRTP trailer: ${packetBytes.length} < ${headerLen + trailerLen}`);
    }

    const state = this.getStreamState(ssrc);
    state.totalPackets++;

    // Mid-call ROC search on initial packet if seq is non-zero
    if (!state.initialized && seq > 1000 && tagLen > 0) {
      const authPortionLen = packetBytes.length - trailerLen;
      const tagOffset = packetBytes.length - tagLen;
      for (let probeRoc = 0; probeRoc <= 16; probeRoc++) {
        if (this.verifyAuthTag(packetBytes, authPortionLen, tagOffset, probeRoc, false)) {
          state.roc = probeRoc;
          break;
        }
      }
    }

    const { roc, packetIndex } = this.estimateIndex(state, seq);
    const authPortionLen = packetBytes.length - trailerLen;
    const tagOffset = packetBytes.length - tagLen;

    const authValid = tagLen > 0
      ? this.verifyAuthTag(packetBytes, authPortionLen, tagOffset, roc, false)
      : true;

    if (authValid) {
      state.authPassCount++;
    } else {
      state.authFailCount++;
    }

    // Decrypt payload in-place or copy
    const payloadLen = packetBytes.length - headerLen - trailerLen;
    const outPacket = new Uint8Array(headerLen + payloadLen);
    // Copy header
    outPacket.set(packetBytes.subarray(0, headerLen), 0);
    // Copy encrypted payload
    outPacket.set(packetBytes.subarray(headerLen, headerLen + payloadLen), headerLen);

    if (!this.crypto.unencryptedSrtp && payloadLen > 0) {
      const iv = this.buildSrtpIv(ssrc, packetIndex);
      this.cipherKe.processCtr(iv, outPacket, headerLen, payloadLen);
    }

    // Post-decryption: strip padding if padding bit was set
    let finalPacket = outPacket;
    if (hasPadding && payloadLen > 0) {
      const padCount = outPacket[outPacket.length - 1];
      if (padCount > 0 && padCount <= payloadLen) {
        finalPacket = outPacket.subarray(0, outPacket.length - padCount);
      }
    }

    return {
      decryptedPacket: finalPacket,
      authValid,
      roc,
      packetIndex,
    };
  }

  /**
   * Unprotects an SRTCP packet.
   * Format: [RTCP Header (8 bytes)][Payload][E(1-bit) || SRTCP Index (31-bit)][Auth Tag (10 bytes)]
   */
  public unprotectRtcp(packetBytes: Uint8Array): {
    decryptedPacket: Uint8Array;
    authValid: boolean;
    srtcpIndex: number;
  } {
    const tagLen = 10; // Mandatory 80-bit tag for SRTCP (RFC 3711 Section 4.3.3.2)
    const minLen = 8 + 4 + tagLen; // Header (8) + Index/E (4) + Tag (10)
    if (packetBytes.length < minLen) {
      throw new Error(`Packet too short for SRTCP: ${packetBytes.length} < ${minLen}`);
    }

    const view = new DataView(packetBytes.buffer, packetBytes.byteOffset, packetBytes.byteLength);
    const ssrc = view.getUint32(4, false);

    const indexOffset = packetBytes.length - tagLen - 4;
    const tagOffset = packetBytes.length - tagLen;

    const indexWord = view.getUint32(indexOffset, false);
    const isEncrypted = (indexWord & 0x80000000) !== 0;
    const srtcpIndex = indexWord & 0x7fffffff;

    // Verify auth tag over packet[0..indexOffset + 4]
    const authValid = this.verifyAuthTag(packetBytes, indexOffset + 4, tagOffset, 0, true);

    const payloadLen = indexOffset - 8;
    const outPacket = new Uint8Array(8 + payloadLen);
    outPacket.set(packetBytes.subarray(0, 8), 0);
    outPacket.set(packetBytes.subarray(8, indexOffset), 8);

    if (isEncrypted && !this.crypto.unencryptedSrtcp && payloadLen > 0) {
      // Build SRTCP IV
      const iv = new Uint8Array(16);
      iv[0] = this.ksRtcp[0];
      iv[1] = this.ksRtcp[1];
      iv[2] = this.ksRtcp[2];
      iv[3] = this.ksRtcp[3];

      iv[4] = this.ksRtcp[4] ^ ((ssrc >>> 24) & 0xff);
      iv[5] = this.ksRtcp[5] ^ ((ssrc >>> 16) & 0xff);
      iv[6] = this.ksRtcp[6] ^ ((ssrc >>> 8) & 0xff);
      iv[7] = this.ksRtcp[7] ^ (ssrc & 0xff);

      iv[8] = this.ksRtcp[8];
      iv[9] = this.ksRtcp[9];
      iv[10] = this.ksRtcp[10] ^ ((srtcpIndex >>> 24) & 0xff);
      iv[11] = this.ksRtcp[11] ^ ((srtcpIndex >>> 16) & 0xff);
      iv[12] = this.ksRtcp[12] ^ ((srtcpIndex >>> 8) & 0xff);
      iv[13] = this.ksRtcp[13] ^ (srtcpIndex & 0xff);

      iv[14] = 0;
      iv[15] = 0;

      this.cipherKeRtcp.processCtr(iv, outPacket, 8, payloadLen);
    }

    return {
      decryptedPacket: outPacket,
      authValid,
      srtcpIndex,
    };
  }

  /**
   * Computes stream authentication pass rate percentage.
   */
  public getAuthPassRate(ssrc: number): number {
    const state = this.streamStates.get(ssrc);
    if (!state || state.totalPackets === 0) return 0;
    return (state.authPassCount / state.totalPackets) * 100;
  }
}
