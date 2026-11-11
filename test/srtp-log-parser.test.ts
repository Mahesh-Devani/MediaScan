import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LogKeyParser } from '../src/srtp/LogKeyParser.ts';

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

describe('LogKeyParser: Telecom and NSS Key Log Extraction', () => {
  it('extracts FreeSWITCH switch_rtp.c keys', () => {
    const log = `
2026-11-11 12:30:15.123 [NOTICE] switch_rtp.c:4521 Activating SRTP: [AES_CM_128_HMAC_SHA1_80] key: [W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY]
2026-11-11 12:30:15.125 [DEBUG] switch_rtp.c:4530 Setting local crypto key: AES_CM_128_HMAC_SHA1_80 inline:d0Rmdm5BiRhEgNOtPu5/XajcdtUmPlhErWBnDUqa
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.ok(keys.length >= 2, `Expected at least 2 keys, got ${keys.length}`);

    const k1 = keys.find(k => k.rawKeyBase64 === 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY');
    assert.ok(k1);
    assert.equal(k1.cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
    assert.equal(k1.masterKey.length, 16);
    assert.equal(k1.masterSalt.length, 14);

    const k2 = keys.find(k => k.rawKeyBase64 === 'd0Rmdm5BiRhEgNOtPu5/XajcdtUmPlhErWBnDUqa');
    assert.ok(k2);
    assert.equal(k2.direction, 'outbound');
  });

  it('extracts Asterisk res_srtp.c and res_pjsip policies', () => {
    const log = `
[Nov 11 12:35:00] VERBOSE[1234] res_srtp.c: SRTP policy: crypto:1 AES_CM_128_HMAC_SHA1_80 inline:W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY
[Nov 11 12:35:01] DEBUG[1234] res_srtp.c: srtp_create (suite: AES_CM_128_HMAC_SHA1_80, key: d0Rmdm5BiRhEgNOtPu5/XajcdtUmPlhErWBnDUqa)
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.ok(keys.length >= 2);
    assert.equal(keys[0].cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
  });

  it('extracts Kamailio and RTPEngine logs', () => {
    const log = `
rtpengine[5678]: [call-id-999] Setting crypto suite AES_CM_128_HMAC_SHA1_80 key W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY
rtpengine[5678]: [call-id-999] SDES key: d0Rmdm5BiRhEgNOtPu5/XajcdtUmPlhErWBnDUqa
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.ok(keys.length >= 2);
    assert.equal(keys[0].cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
  });

  it('extracts Cisco CUCM MediaManager traces', () => {
    const log = `
09:12:34.567 |CCM|MediaManager::setSrtpInfo crypto:1 AES_CM_128_HMAC_SHA1_80 inline:W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY|
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].cryptoSuite, 'AES_CM_128_HMAC_SHA1_80');
    assert.equal(keys[0].contextHint, 'Cisco CUCM');
  });

  it('extracts WebRTC Internals dump JSON entries', () => {
    const log = `
{
  "StandardizedRTCStatsReport": {
    "RTCIceCandidatePair_0": {
      "cryptoKey": "W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY"
    }
  }
}
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].rawKeyBase64, 'W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY');
    assert.equal(keys[0].contextHint, 'WebRTC Internals');
  });

  it('extracts NSS SSLKEYLOGFILE CLIENT_RANDOM entries', () => {
    const log = `
# SSL/TLS secrets log file
CLIENT_RANDOM 2049e6d0a7f185799a6cfd774a3b10b00c3bca1ef23d6a9a791a8e3100df3f95 44b36055d784a0d92233445566778899aabbccddeeff00112233445566778899aabbccddeeff00112233445566778899
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].format, 'nss-sslkeylog');
    assert.equal(keys[0].clientRandomHex, '2049e6d0a7f185799a6cfd774a3b10b00c3bca1ef23d6a9a791a8e3100df3f95');
    assert.ok(keys[0].masterSecretHex?.startsWith('44b36055'));
  });

  it('extracts hexadecimal key and salt pairs', () => {
    const log = `
Master Key: E1F97A0D3E018BE0D64FA32C06DE4139
Master Salt: 0EC675AD498AFEEBB6960B3AABE6
    `;

    const keys = LogKeyParser.parseLogText(log);
    assert.equal(keys.length, 1);
    assert.equal(keys[0].format, 'hex');
    assert.equal(bytesToHex(keys[0].masterKey), 'E1F97A0D3E018BE0D64FA32C06DE4139');
    assert.equal(bytesToHex(keys[0].masterSalt), '0EC675AD498AFEEBB6960B3AABE6');
  });

  it('supports custom user-defined regexes', () => {
    const log = `
MyCustomPBX [KEY=W3UZKtgTF/VDvmFOzg+6CStYWTrZaLFgYfafwhqY, SSRC=0x12345678]
    `;

    const customPattern = {
      name: 'MyCustomPBX',
      description: 'Custom PBX test',
      regex: /MyCustomPBX\s+\[KEY=([A-Za-z0-9+/=]{40}),\s*SSRC=(0x[0-9a-fA-F]+|\d+)\]/gi,
      extract: (m: RegExpExecArray) => {
        const b64 = m[1];
        const ssrc = parseInt(m[2], m[2].startsWith('0x') ? 16 : 10);
        const parsed = LogKeyParser.PATTERNS[0].extract([`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`] as any);
        if (!parsed) return null;
        return {
          ...parsed,
          ssrc,
          contextHint: 'MyCustomPBX',
        };
      },
    };

    const keys = LogKeyParser.parseLogText(log, [customPattern]);
    assert.ok(keys.length >= 1);
    const customKey = keys.find(k => k.contextHint === 'MyCustomPBX');
    assert.ok(customKey);
    assert.equal(customKey.ssrc, 0x12345678);
  });
});
