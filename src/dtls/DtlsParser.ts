/**
 * DtlsParser.ts
 * RFC 7983 Demuxing and DTLS 1.2 Handshake Parser for DTLS-SRTP.
 */

import type { SrtpCryptoSuite } from '../srtp/SrtpTypes.ts';

export interface DtlsHandshakeInfo {
  clientRandom?: Uint8Array;
  serverRandom?: Uint8Array;
  negotiatedProfile?: SrtpCryptoSuite;
  clientEndpoint?: string; // "ip:port"
  serverEndpoint?: string; // "ip:port"
}

export class DtlsParser {
  /**
   * RFC 7983 Section 7: First byte range 20..63 indicates DTLS.
   */
  public static isDtls(payload: Uint8Array): boolean {
    if (payload.length < 13) return false;
    const b0 = payload[0];
    return b0 >= 20 && b0 <= 63;
  }

  /**
   * RFC 7983 Section 7: First byte range 0..19 indicates STUN.
   */
  public static isStun(payload: Uint8Array): boolean {
    if (payload.length < 20) return false;
    const b0 = payload[0];
    return b0 <= 19;
  }

  /**
   * Maps RFC 5764 SRTP Protection Profile IDs to standard crypto suite names.
   */
  public static mapProfileId(id: number): SrtpCryptoSuite | null {
    switch (id) {
      case 0x0001:
        return 'AES_CM_128_HMAC_SHA1_80';
      case 0x0002:
        return 'AES_CM_128_HMAC_SHA1_32';
      case 0x0007:
        return 'AEAD_AES_128_GCM';
      case 0x0008:
        return 'AEAD_AES_256_GCM';
      default:
        return null;
    }
  }

  /**
   * Parses DTLS records from a packet payload.
   */
  public static parseHandshake(
    payload: Uint8Array,
    srcEp: string,
    dstEp: string,
    state: DtlsHandshakeInfo
  ): void {
    let offset = 0;
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);

    while (offset + 13 <= payload.length) {
      const contentType = payload[offset];
      const version = view.getUint16(offset + 1, false);
      const recordLen = view.getUint16(offset + 11, false);
      const recordEnd = offset + 13 + recordLen;

      if (recordEnd > payload.length) break;

      // We only inspect Handshake records (ContentType 22)
      if (contentType === 22) {
        let hsOffset = offset + 13;
        while (hsOffset + 12 <= recordEnd) {
          const msgType = payload[hsOffset];
          const hsLen = (payload[hsOffset + 1] << 16) | (payload[hsOffset + 2] << 8) | payload[hsOffset + 3];
          const fragOffset = (payload[hsOffset + 6] << 16) | (payload[hsOffset + 7] << 8) | payload[hsOffset + 8];
          const fragLen = (payload[hsOffset + 9] << 16) | (payload[hsOffset + 10] << 8) | payload[hsOffset + 11];

          const bodyOffset = hsOffset + 12;
          const bodyEnd = bodyOffset + fragLen;
          if (bodyEnd > recordEnd) break;

          if (msgType === 1 && fragOffset === 0 && fragLen >= 34) {
            // ClientHello: extract 32-byte client_random
            state.clientRandom = new Uint8Array(payload.subarray(bodyOffset + 2, bodyOffset + 34));
            state.clientEndpoint = srcEp;
            state.serverEndpoint = dstEp;
          } else if (msgType === 2 && fragOffset === 0 && fragLen >= 34) {
            // ServerHello: extract 32-byte server_random and extensions
            state.serverRandom = new Uint8Array(payload.subarray(bodyOffset + 2, bodyOffset + 34));
            state.serverEndpoint = srcEp;
            state.clientEndpoint = dstEp;

            // Parse extensions to find use_srtp (type 14 = 0x000E)
            let extCursor = bodyOffset + 34;
            // Skip session_id
            if (extCursor < bodyEnd) {
              const sessIdLen = payload[extCursor];
              extCursor += 1 + sessIdLen;
            }
            // Skip cipher_suite (2 bytes) + compression_method (1 byte)
            extCursor += 3;

            // Check extensions length
            if (extCursor + 2 <= bodyEnd) {
              const extsLen = view.getUint16(extCursor, false);
              extCursor += 2;
              const extsEnd = extCursor + extsLen;

              while (extCursor + 4 <= extsEnd && extCursor + 4 <= bodyEnd) {
                const extType = view.getUint16(extCursor, false);
                const extDataLen = view.getUint16(extCursor + 2, false);
                extCursor += 4;

                if (extType === 14 && extDataLen >= 2) {
                  // use_srtp extension: 2 bytes profiles length + profile IDs
                  const profilesLen = view.getUint16(extCursor, false);
                  if (profilesLen >= 2 && extCursor + 2 + 2 <= bodyEnd) {
                    const profileId = view.getUint16(extCursor + 2, false);
                    const mapped = DtlsParser.mapProfileId(profileId);
                    if (mapped) {
                      state.negotiatedProfile = mapped;
                    }
                  }
                }

                extCursor += extDataLen;
              }
            }
          }

          hsOffset = bodyEnd;
        }
      }

      offset = recordEnd;
    }
  }
}
