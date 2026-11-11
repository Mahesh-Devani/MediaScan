/**
 * SdesParser.ts
 * Parser for RFC 4568 Session Description Protocol (SDP) Security Descriptions for Media Streams (SDES).
 * Parses:
 * a=crypto:<tag> <crypto-suite> inline:<key_material>[|<lifetime>][|<mki_value>:<mki_length>][ <session_params>]
 */

import type { SdesCrypto, SrtpCryptoSuite } from './SrtpTypes.ts';

function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/=]/g, '');
  if (typeof Buffer !== 'undefined') {
    return new Uint8Array(Buffer.from(clean, 'base64'));
  }
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export class SdesParser {
  /**
   * Encodes bytes into standard Base64 string.
   */
  public static base64Encode(bytes: Uint8Array): string {
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
    }
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Decodes Base64 string into bytes.
   */
  public static base64Decode(b64: string): Uint8Array {
    return base64ToBytes(b64);
  }

  /**
   * Returns expected master key length and salt length in bytes for a given crypto suite.
   */
  public static getKeyLengths(suite: SrtpCryptoSuite): { keyLen: number; saltLen: number; tagLen: number } {
    switch (suite) {
      case 'AES_CM_128_HMAC_SHA1_80':
        return { keyLen: 16, saltLen: 14, tagLen: 10 };
      case 'AES_CM_128_HMAC_SHA1_32':
        return { keyLen: 16, saltLen: 14, tagLen: 4 };
      case 'AES_192_CM_HMAC_SHA1_80':
        return { keyLen: 24, saltLen: 14, tagLen: 10 };
      case 'AES_192_CM_HMAC_SHA1_32':
        return { keyLen: 24, saltLen: 14, tagLen: 4 };
      case 'AES_256_CM_HMAC_SHA1_80':
        return { keyLen: 32, saltLen: 14, tagLen: 10 };
      case 'AES_256_CM_HMAC_SHA1_32':
        return { keyLen: 32, saltLen: 14, tagLen: 4 };
      case 'AEAD_AES_128_GCM':
        return { keyLen: 16, saltLen: 12, tagLen: 16 };
      case 'AEAD_AES_256_GCM':
        return { keyLen: 32, saltLen: 12, tagLen: 16 };
      case 'NULL_HMAC_SHA1_80':
        return { keyLen: 0, saltLen: 14, tagLen: 10 };
      case 'NULL_HMAC_SHA1_32':
        return { keyLen: 0, saltLen: 14, tagLen: 4 };
      default:
        // Default to AES-128 lengths
        return { keyLen: 16, saltLen: 14, tagLen: 10 };
    }
  }

  /**
   * Parses an `a=crypto:` line.
   */
  public static parseCryptoLine(line: string): SdesCrypto | null {
    const trimmed = line.trim();
    const prefix = 'a=crypto:';
    let content = trimmed;
    if (content.toLowerCase().startsWith(prefix)) {
      content = content.substring(prefix.length).trim();
    } else if (content.toLowerCase().startsWith('crypto:')) {
      content = content.substring('crypto:'.length).trim();
    }

    // Grammar: <tag> <crypto-suite> <key-params> [<session-params>]
    const tokens = content.split(/\s+/);
    if (tokens.length < 3) {
      return null;
    }

    const tag = parseInt(tokens[0], 10);
    if (isNaN(tag)) return null;

    const cryptoSuite = tokens[1] as SrtpCryptoSuite;
    const keyParam = tokens[2];

    if (!keyParam.startsWith('inline:')) {
      return null;
    }

    const inlineContent = keyParam.substring('inline:'.length);
    // Format: <b64key>[|<lifetime>][|<mki_val>:<mki_len>]
    const parts = inlineContent.split('|');
    const rawB64 = parts[0];

    const rawKeyMaterial = base64ToBytes(rawB64);
    const { keyLen, saltLen } = SdesParser.getKeyLengths(cryptoSuite);

    if (rawKeyMaterial.length < keyLen + saltLen) {
      console.warn(`[SdesParser] Warning: key material length ${rawKeyMaterial.length} < expected ${keyLen + saltLen} for suite ${cryptoSuite}`);
    }

    const masterKey = rawKeyMaterial.slice(0, keyLen);
    const masterSalt = rawKeyMaterial.slice(keyLen, keyLen + saltLen);

    let lifetime: number | undefined;
    let mkiValue: number | undefined;
    let mkiLength: number | undefined;

    for (let i = 1; i < parts.length; i++) {
      const part = parts[i];
      if (part.includes(':')) {
        const [valStr, lenStr] = part.split(':');
        mkiValue = parseInt(valStr, 10);
        mkiLength = parseInt(lenStr, 10);
      } else if (part.includes('^')) {
        // e.g., 2^20
        const [baseStr, expStr] = part.split('^');
        lifetime = Math.pow(parseInt(baseStr, 10), parseInt(expStr, 10));
      } else if (!isNaN(parseInt(part, 10))) {
        lifetime = parseInt(part, 10);
      }
    }

    // Parse optional session parameters
    let unencryptedSrtp = false;
    let unencryptedSrtcp = false;
    let unauthenticatedSrtp = false;
    let kdr = 0;

    for (let i = 3; i < tokens.length; i++) {
      const param = tokens[i].toUpperCase();
      if (param === 'UNENCRYPTED_SRTP') {
        unencryptedSrtp = true;
      } else if (param === 'UNENCRYPTED_SRTCP') {
        unencryptedSrtcp = true;
      } else if (param === 'UNAUTHENTICATED_SRTP') {
        unauthenticatedSrtp = true;
      } else if (param.startsWith('KDR=')) {
        kdr = parseInt(param.substring(4), 10) || 0;
      }
    }

    return {
      tag,
      cryptoSuite,
      masterKey,
      masterSalt,
      lifetime,
      mkiValue,
      mkiLength,
      unencryptedSrtp,
      unencryptedSrtcp,
      unauthenticatedSrtp,
      kdr,
      rawInline: rawB64,
    };
  }
}
