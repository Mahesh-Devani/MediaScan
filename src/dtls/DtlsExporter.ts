/**
 * DtlsExporter.ts
 * Implements RFC 5246 TLS 1.2 PRF and RFC 5705 / RFC 5764 Key Material Exporter for DTLS-SRTP.
 */

import { HmacSha256 } from '../crypto/HmacSha256.ts';
import { SdesParser } from '../srtp/SdesParser.ts';
import type { SrtpCryptoSuite } from '../srtp/SrtpTypes.ts';

export function pHashSha256(secret: Uint8Array, seed: Uint8Array, length: number): Uint8Array {
  const result = new Uint8Array(length);
  let a = seed;
  let offset = 0;

  while (offset < length) {
    a = HmacSha256.compute(secret, a);
    const stepBuf = new Uint8Array(a.length + seed.length);
    stepBuf.set(a, 0);
    stepBuf.set(seed, a.length);
    const step = HmacSha256.compute(secret, stepBuf);

    const toCopy = Math.min(step.length, length - offset);
    result.set(step.subarray(0, toCopy), offset);
    offset += toCopy;
  }

  return result;
}

export function prfTls12(
  secret: Uint8Array,
  label: string,
  seed: Uint8Array,
  length: number
): Uint8Array {
  const labelBytes = new TextEncoder().encode(label);
  const combined = new Uint8Array(labelBytes.length + seed.length);
  combined.set(labelBytes, 0);
  combined.set(seed, labelBytes.length);
  return pHashSha256(secret, combined, length);
}

export interface DtlsSrtpKeys {
  clientKey: Uint8Array;
  serverKey: Uint8Array;
  clientSalt: Uint8Array;
  serverSalt: Uint8Array;
}

export class DtlsExporter {
  public static readonly DTLS_SRTP_LABEL = 'EXTRACTOR-dtls_srtp';

  public static exportKeys(
    masterSecret: Uint8Array,
    clientRandom: Uint8Array,
    serverRandom: Uint8Array,
    suite: SrtpCryptoSuite
  ): DtlsSrtpKeys {
    const { keyLen, saltLen } = SdesParser.getKeyLengths(suite);
    const totalLen = (keyLen + saltLen) * 2;

    const seed = new Uint8Array(clientRandom.length + serverRandom.length);
    seed.set(clientRandom, 0);
    seed.set(serverRandom, clientRandom.length);

    const material = prfTls12(masterSecret, DtlsExporter.DTLS_SRTP_LABEL, seed, totalLen);

    let offset = 0;
    const clientKey = material.subarray(offset, offset + keyLen);
    offset += keyLen;
    const serverKey = material.subarray(offset, offset + keyLen);
    offset += keyLen;
    const clientSalt = material.subarray(offset, offset + saltLen);
    offset += saltLen;
    const serverSalt = material.subarray(offset, offset + saltLen);

    return {
      clientKey: new Uint8Array(clientKey),
      serverKey: new Uint8Array(serverKey),
      clientSalt: new Uint8Array(clientSalt),
      serverSalt: new Uint8Array(serverSalt),
    };
  }
}
