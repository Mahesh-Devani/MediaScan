/**
 * SrtpTypes.ts
 * Type definitions for SRTP, SRTCP, and SDES key negotiation.
 */

export type SrtpCryptoSuite =
  | 'AES_CM_128_HMAC_SHA1_80'
  | 'AES_CM_128_HMAC_SHA1_32'
  | 'AES_192_CM_HMAC_SHA1_80'
  | 'AES_192_CM_HMAC_SHA1_32'
  | 'AES_256_CM_HMAC_SHA1_80'
  | 'AES_256_CM_HMAC_SHA1_32'
  | 'AEAD_AES_128_GCM'
  | 'AEAD_AES_256_GCM'
  | 'NULL_HMAC_SHA1_80'
  | 'NULL_HMAC_SHA1_32'
  | string;

export interface SdesCrypto {
  tag: number;
  cryptoSuite: SrtpCryptoSuite;
  masterKey: Uint8Array;
  masterSalt: Uint8Array;
  lifetime?: number;
  mkiValue?: number;
  mkiLength?: number;
  unencryptedSrtp: boolean;
  unencryptedSrtcp: boolean;
  unauthenticatedSrtp: boolean;
  kdr: number;
  rawInline: string;
}

export interface SrtpStreamState {
  ssrc: number;
  roc: number;
  highestSeq: number;
  initialized: boolean;
  authPassCount: number;
  authFailCount: number;
  totalPackets: number;
}

export interface SrtpDecryptionResult {
  decryptedPayload: Uint8Array;
  authValid: boolean;
  roc: number;
  packetIndex: number;
}
