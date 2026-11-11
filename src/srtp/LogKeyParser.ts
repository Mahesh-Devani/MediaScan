/**
 * LogKeyParser.ts
 * Extracts SRTP/SRTCP encryption keys, salts, and DTLS client secrets from
 * telecommunication system logs, WebRTC dumps, and NSS SSLKEYLOGFILE formats.
 */

import { SdesParser } from './SdesParser.ts';
import type { SdesCrypto, SrtpCryptoSuite } from './SrtpTypes.ts';

export interface ExtractedLogKey {
  source: 'log' | 'manual';
  format: 'sdes-base64' | 'hex' | 'nss-sslkeylog';
  cryptoSuite: SrtpCryptoSuite;
  masterKey: Uint8Array;
  masterSalt: Uint8Array;
  rawKeyBase64?: string;
  ssrc?: number;
  endpoint?: string; // "ip:port"
  direction?: 'inbound' | 'outbound';
  contextHint?: string; // log line or system hint (e.g., FreeSWITCH, Asterisk, WebRTC)
  clientRandomHex?: string; // For NSS key log
  masterSecretHex?: string; // For NSS key log
}

export interface RegexPatternDef {
  name: string;
  description: string;
  regex: RegExp;
  extract: (match: RegExpExecArray) => Partial<ExtractedLogKey> | null;
}

export class LogKeyParser {
  public static readonly PATTERNS: RegexPatternDef[] = [
    // 1. Standard RFC 4568 a=crypto line (SIP/SDP in logs)
    {
      name: 'SDP a=crypto',
      description: 'Standard RFC 4568 a=crypto: attribute found in SIP logs',
      regex: /a=crypto:\s*(\d+)\s+([A-Za-z0-9_]+)\s+inline:([A-Za-z0-9+/=]+)/gi,
      extract: (m) => {
        const parsed = SdesParser.parseCryptoLine(m[0]);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: parsed.rawInline,
          format: 'sdes-base64',
          contextHint: `SDES Tag ${parsed.tag}`,
        };
      },
    },

    // 2. FreeSWITCH switch_rtp.c logs
    // e.g. "Activating SRTP: [AES_CM_128_HMAC_SHA1_80] key: [W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY]"
    // or "Setting local crypto key: AES_CM_128_HMAC_SHA1_80 inline:..."
    {
      name: 'FreeSWITCH SRTP Log',
      description: 'FreeSWITCH switch_rtp.c crypto key activation log',
      regex: /(?:Activating SRTP:\s*\[([A-Za-z0-9_]+)\]\s*key:\s*\[([A-Za-z0-9+/=]+)\]|Setting (?:local|remote) crypto key:\s*([A-Za-z0-9_]+)\s*(?:inline:)?([A-Za-z0-9+/=]+))/gi,
      extract: (m) => {
        const suite = (m[1] || m[3] || 'AES_CM_128_HMAC_SHA1_80') as SrtpCryptoSuite;
        const b64 = m[2] || m[4];
        if (!b64) return null;
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 ${suite} inline:${b64}`);
        if (!parsed) return null;
        const isLocal = m[0].toLowerCase().includes('local');
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          direction: isLocal ? 'outbound' : undefined,
          format: 'sdes-base64',
          contextHint: 'FreeSWITCH switch_rtp',
        };
      },
    },

    // 3. Asterisk res_srtp.c / res_pjsip logs
    // e.g. "SRTP policy: crypto:1 AES_CM_128_HMAC_SHA1_80 inline:W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY"
    // or "srtp_create (suite: AES_CM_128_HMAC_SHA1_80, key: W3UZ...)"
    {
      name: 'Asterisk SRTP Log',
      description: 'Asterisk res_srtp / res_pjsip crypto policies',
      regex: /(?:SRTP policy:\s*crypto:\d+\s+([A-Za-z0-9_]+)\s+inline:([A-Za-z0-9+/=]+)|srtp_create\s*\(suite:\s*([A-Za-z0-9_]+),\s*key:\s*([A-Za-z0-9+/=]+)\))/gi,
      extract: (m) => {
        const suite = (m[1] || m[3] || 'AES_CM_128_HMAC_SHA1_80') as SrtpCryptoSuite;
        const b64 = m[2] || m[4];
        if (!b64) return null;
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 ${suite} inline:${b64}`);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          format: 'sdes-base64',
          contextHint: 'Asterisk res_srtp',
        };
      },
    },

    // 4. Kamailio / RTPEngine logs
    // e.g. "Setting crypto suite AES_CM_128_HMAC_SHA1_80 key W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY"
    // or "rtpengine: [call-id] SDES key: W3UZKtgTF..."
    {
      name: 'RTPEngine / Kamailio',
      description: 'RTPEngine daemon SDES crypto negotiation log',
      regex: /(?:Setting crypto suite\s+([A-Za-z0-9_]+)\s+key\s+([A-Za-z0-9+/=]+)|SDES key:\s*([A-Za-z0-9+/=]{40}))/gi,
      extract: (m) => {
        const suite = (m[1] || 'AES_CM_128_HMAC_SHA1_80') as SrtpCryptoSuite;
        const b64 = m[2] || m[3];
        if (!b64) return null;
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 ${suite} inline:${b64}`);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          format: 'sdes-base64',
          contextHint: 'RTPEngine',
        };
      },
    },

    // 5. Cisco CUCM logs
    // e.g. "MediaManager::setSrtpInfo crypto:1 AES_CM_128_HMAC_SHA1_80 inline:..."
    {
      name: 'Cisco CUCM Log',
      description: 'Cisco Unified Communications Manager MediaManager traces',
      regex: /(?:MediaManager::setSrtpInfo|CCM_SIP).*?(?:crypto:\d+\s+([A-Za-z0-9_]+)\s+inline:([A-Za-z0-9+/=]+))/gi,
      extract: (m) => {
        const suite = (m[1] || 'AES_CM_128_HMAC_SHA1_80') as SrtpCryptoSuite;
        const b64 = m[2];
        if (!b64) return null;
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 ${suite} inline:${b64}`);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          format: 'sdes-base64',
          contextHint: 'Cisco CUCM',
        };
      },
    },

    // 6. WebRTC Internals dump
    // e.g. '"cryptoKey": "W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY"'
    // or '"srtpCipher": "AES_CM_128_HMAC_SHA1_80"'
    {
      name: 'WebRTC Internals Dump',
      description: 'Chrome / Edge webrtc_internals_dump.txt JSON properties',
      regex: /"cryptoKey"\s*:\s*"([A-Za-z0-9+/=]{40})"/gi,
      extract: (m) => {
        const b64 = m[1];
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          format: 'sdes-base64',
          contextHint: 'WebRTC Internals',
        };
      },
    },

    // 7. NSS SSLKEYLOGFILE for DTLS
    // e.g. "CLIENT_RANDOM <32-byte-hex> <48-byte-hex>"
    {
      name: 'NSS SSLKEYLOGFILE (CLIENT_RANDOM)',
      description: 'Standard NSS TLS / DTLS 1.2 key log entry',
      regex: /^CLIENT_RANDOM\s+([0-9a-fA-F]{64})\s+([0-9a-fA-F]{96})/gim,
      extract: (m) => {
        const clientRandomHex = m[1].toLowerCase();
        const masterSecretHex = m[2].toLowerCase();
        return {
          format: 'nss-sslkeylog',
          cryptoSuite: 'AES_CM_128_HMAC_SHA1_80', // default fallback until DTLS handshake parses use_srtp
          masterKey: new Uint8Array(16),
          masterSalt: new Uint8Array(14),
          clientRandomHex,
          masterSecretHex,
          contextHint: `NSS Key Log (${clientRandomHex.substring(0, 8)}...)`,
        };
      },
    },

    // 8. Key / Salt in Hex representation
    // e.g. "master_key: E1F97A0D3E018BE0D64FA32C06DE4139 salt: 0EC675AD498AFEEBB6960B3AABE6"
    {
      name: 'Hex Key & Salt',
      description: 'Separated hexadecimal master key (32/64 hex) and salt (28 hex)',
      regex: /(?:master[_-]?key|key)[\s:=]+([0-9a-fA-F]{32}|[0-9a-fA-F]{64})[\s\S]*?(?:master[_-]?salt|salt)[\s:=]+([0-9a-fA-F]{28})/gi,
      extract: (m) => {
        const keyHex = m[1].replace(/\s+/g, '');
        const saltHex = m[2].replace(/\s+/g, '');
        const keyBytes = new Uint8Array(keyHex.length / 2);
        for (let i = 0; i < keyBytes.length; i++) {
          keyBytes[i] = parseInt(keyHex.substring(i * 2, i * 2 + 2), 16);
        }
        const saltBytes = new Uint8Array(saltHex.length / 2);
        for (let i = 0; i < saltBytes.length; i++) {
          saltBytes[i] = parseInt(saltHex.substring(i * 2, i * 2 + 2), 16);
        }
        const suite: SrtpCryptoSuite = keyBytes.length === 32 ? 'AEAD_AES_256_GCM' : 'AES_CM_128_HMAC_SHA1_80';
        return {
          format: 'hex',
          cryptoSuite: suite,
          masterKey: keyBytes,
          masterSalt: saltBytes,
          contextHint: 'Hex Key+Salt',
        };
      },
    },

    // 9. Raw 40-character Base64 inline key string
    // e.g. "inline:W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY"
    {
      name: 'Generic Base64 Key String',
      description: '40-character Base64 encoded 30-byte SDES inline key',
      regex: /(?:inline:\s*|\b)([A-Za-z0-9+/]{40}(?:={1,2})?)\b/gi,
      extract: (m) => {
        const fullMatch = m[0];
        const b64 = m[1];
        if (b64.length < 40) return null;
        // Skip if pure hex string unless explicitly prefixed with inline:
        if (/^[0-9a-fA-F]+$/.test(b64) && !fullMatch.includes('inline:')) return null;
        const parsed = SdesParser.parseCryptoLine(`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`);
        if (!parsed) return null;
        return {
          cryptoSuite: parsed.cryptoSuite,
          masterKey: parsed.masterKey,
          masterSalt: parsed.masterSalt,
          rawKeyBase64: b64,
          format: 'sdes-base64',
          contextHint: 'Raw Base64 Key',
        };
      },
    },
  ];

  /**
   * Scans arbitrary text using built-in or custom regex patterns to extract keys.
   */
  public static parseLogText(
    text: string,
    customPatterns?: RegexPatternDef[]
  ): ExtractedLogKey[] {
    const results: ExtractedLogKey[] = [];
    const seenSignatures = new Set<string>();

    const patterns = customPatterns && customPatterns.length > 0
      ? [...customPatterns, ...LogKeyParser.PATTERNS]
      : LogKeyParser.PATTERNS;

    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(text)) !== null) {
        try {
          const partial = pattern.extract(match);
          if (!partial || !partial.cryptoSuite) continue;

          // Deduplicate by signature
          const sig = partial.format === 'nss-sslkeylog'
            ? `nss:${partial.clientRandomHex}`
            : `${partial.cryptoSuite}:${Array.from(partial.masterKey || []).join(',')}:${Array.from(partial.masterSalt || []).join(',')}`;

          if (seenSignatures.has(sig)) continue;
          seenSignatures.add(sig);

          results.push({
            source: 'log',
            format: partial.format || 'sdes-base64',
            cryptoSuite: partial.cryptoSuite,
            masterKey: partial.masterKey || new Uint8Array(16),
            masterSalt: partial.masterSalt || new Uint8Array(14),
            rawKeyBase64: partial.rawKeyBase64,
            ssrc: partial.ssrc,
            endpoint: partial.endpoint,
            direction: partial.direction,
            contextHint: partial.contextHint || pattern.name,
            clientRandomHex: partial.clientRandomHex,
            masterSecretHex: partial.masterSecretHex,
          });
        } catch {
          // Continue scanning next matches
        }
      }
    }

    return results;
  }
}
