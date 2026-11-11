/**
 * HmacSha1.ts
 * Pure TypeScript implementation of SHA-1 and HMAC-SHA1 per FIPS-180-4 and RFC 2104.
 * Computes full 160-bit (20-byte) digests and truncated authentication tags
 * (80-bit for SRTP/SRTCP _80 suites and 32-bit for _32 suites).
 */

function rol(n: number, s: number): number {
  return ((n << s) | (n >>> (32 - s))) >>> 0;
}

export class HmacSha1 {
  /**
   * Computes 160-bit (20-byte) SHA-1 hash of data.
   */
  public static sha1(data: Uint8Array): Uint8Array {
    let h0 = 0x67452301;
    let h1 = 0xefcdab89;
    let h2 = 0x98badcfe;
    let h3 = 0x10325476;
    let h4 = 0xc3d2e1f0;

    const dataLen = data.length;
    // Padding: append 0x80, then k zero bytes, then 64-bit big-endian bit length
    // Total length must be multiple of 64 bytes (512 bits)
    const bitLen = dataLen * 8;
    const padLen = (dataLen + 9 + 63) & ~63;
    const padded = new Uint8Array(padLen);
    padded.set(data);
    padded[dataLen] = 0x80;

    // Append 64-bit length (big-endian)
    const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);
    // JavaScript bitwise is 32-bit, handle high and low 32 bits
    const highBits = Math.floor(bitLen / 0x100000000) >>> 0;
    const lowBits = bitLen >>> 0;
    view.setUint32(padLen - 8, highBits, false);
    view.setUint32(padLen - 4, lowBits, false);

    const w = new Uint32Array(80);

    for (let chunk = 0; chunk < padLen; chunk += 64) {
      for (let i = 0; i < 16; i++) {
        w[i] = view.getUint32(chunk + i * 4, false);
      }
      for (let i = 16; i < 80; i++) {
        w[i] = rol(w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16], 1);
      }

      let a = h0;
      let b = h1;
      let c = h2;
      let d = h3;
      let e = h4;

      for (let i = 0; i < 80; i++) {
        let f: number;
        let k: number;
        if (i < 20) {
          f = (b & c) | (~b & d);
          k = 0x5a827999;
        } else if (i < 40) {
          f = b ^ c ^ d;
          k = 0x6ed9eba1;
        } else if (i < 60) {
          f = (b & c) | (b & d) | (c & d);
          k = 0x8f1bbcdc;
        } else {
          f = b ^ c ^ d;
          k = 0xca62c1d6;
        }

        const temp = (rol(a, 5) + f + e + k + w[i]) >>> 0;
        e = d;
        d = c;
        c = rol(b, 30);
        b = a;
        a = temp;
      }

      h0 = (h0 + a) >>> 0;
      h1 = (h1 + b) >>> 0;
      h2 = (h2 + c) >>> 0;
      h3 = (h3 + d) >>> 0;
      h4 = (h4 + e) >>> 0;
    }

    const out = new Uint8Array(20);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, h0, false);
    outView.setUint32(4, h1, false);
    outView.setUint32(8, h2, false);
    outView.setUint32(12, h3, false);
    outView.setUint32(16, h4, false);
    return out;
  }

  /**
   * Computes full 20-byte HMAC-SHA1 digest.
   */
  public static compute(key: Uint8Array, data: Uint8Array): Uint8Array {
    let keyBlock = new Uint8Array(64);
    if (key.length > 64) {
      const hashedKey = HmacSha1.sha1(key);
      keyBlock.set(hashedKey);
    } else {
      keyBlock.set(key);
    }

    const ipad = new Uint8Array(64);
    const opad = new Uint8Array(64);
    for (let i = 0; i < 64; i++) {
      ipad[i] = keyBlock[i] ^ 0x36;
      opad[i] = keyBlock[i] ^ 0x5c;
    }

    // Inner hash: SHA-1(ipad || data)
    const innerBuf = new Uint8Array(64 + data.length);
    innerBuf.set(ipad, 0);
    innerBuf.set(data, 64);
    const innerHash = HmacSha1.sha1(innerBuf);

    // Outer hash: SHA-1(opad || innerHash)
    const outerBuf = new Uint8Array(64 + 20);
    outerBuf.set(opad, 0);
    outerBuf.set(innerHash, 64);
    return HmacSha1.sha1(outerBuf);
  }

  /**
   * Computes HMAC-SHA1 and truncates to the specified tag length.
   * Typically 10 bytes for 80-bit tag (SRTP/SRTCP _80) or 4 bytes for 32-bit tag.
   */
  public static computeTag(
    key: Uint8Array,
    data: Uint8Array,
    tagLength: number = 10
  ): Uint8Array {
    const full = HmacSha1.compute(key, data);
    return full.subarray(0, tagLength);
  }
}
