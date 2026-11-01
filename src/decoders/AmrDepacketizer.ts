/**
 * RFC 4867 RTP Payload Format Depacketizer for AMR and AMR-WB.
 * Unpacks both bandwidth-efficient and octet-aligned RTP streams into
 * standard 3GPP TS 26.101 (AMR-NB) and TS 26.201 (AMR-WB) file format streams.
 */

// Speech bit lengths for AMR-NB modes 0..8
const AMR_NB_SPEECH_BITS = [95, 103, 118, 134, 148, 159, 204, 244, 39];

// Speech bit lengths for AMR-WB modes 0..9
const AMR_WB_SPEECH_BITS = [132, 177, 253, 285, 317, 365, 397, 461, 477, 40];

// Frame body lengths in bytes for octet-aligned mode
const AMR_NB_OCTET_BODY_SIZES = [12, 13, 15, 17, 19, 20, 26, 31, 5, 0, 0, 0, 0, 0, 0, 0];
const AMR_WB_OCTET_BODY_SIZES = [17, 23, 32, 36, 40, 46, 50, 58, 60, 5, 0, 0, 0, 0, 0, 0];

export class AmrDepacketizer {
  /**
   * Depacketize an array of raw RTP AMR payloads into a 3GPP AMR file buffer.
   */
  public static depacketize(
    payloads: Uint8Array[],
    isWideband: boolean,
    octetAligned: boolean = false
  ): Uint8Array {
    const magic = isWideband
      ? new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a]) // #!AMR-WB\n
      : new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a]); // #!AMR\n

    const chunks: Uint8Array[] = [magic];
    let totalLen = magic.length;

    for (const pkt of payloads) {
      if (!pkt || pkt.length < 2) continue;

      if (octetAligned) {
        // Octet-aligned mode:
        // Byte 0: CMR (4 bits) + Reserved (4 bits)
        // Byte 1: F (1 bit), FT (4 bits), Q (1 bit), P (2 bits)
        let tocIdx = 1;
        while (tocIdx < pkt.length) {
          const toc = pkt[tocIdx];
          const ft = (toc >> 3) & 0x0f;
          const q = (toc >> 2) & 1;
          const frameSize = isWideband
            ? AMR_WB_OCTET_BODY_SIZES[ft]
            : AMR_NB_OCTET_BODY_SIZES[ft];

          // 3GPP File ToC header: (FT << 3) | (Q << 2) | 0x04
          const fileHeader = (ft << 3) | (q << 2) | 0x04;
          const frameBuf = new Uint8Array(1 + frameSize);
          frameBuf[0] = fileHeader;

          // Copy speech bytes starting at offset 2 for single-frame packet
          const speechBytes = pkt.subarray(2, 2 + frameSize);
          frameBuf.set(speechBytes, 1);

          chunks.push(frameBuf);
          totalLen += frameBuf.length;
          break; // Single frame per packet
        }
      } else {
        // Bandwidth-efficient mode:
        // Bit 0..3: CMR (4 bits)
        // Bit 4: F (1 bit)
        // Bit 5..8: FT (4 bits)
        // Bit 9: Q (1 bit)
        // Bit 10+: Speech bits
        let bitPos = 4;
        function readBit(): number {
          const b = pkt[bitPos >> 3];
          const bit = (b >> (7 - (bitPos & 7))) & 1;
          bitPos++;
          return bit;
        }
        function readBits(n: number): number {
          let v = 0;
          for (let i = 0; i < n; i++) {
            v = (v << 1) | readBit();
          }
          return v;
        }

        readBit(); // F bit
        const ft = readBits(4);
        const q = readBit();
        const speechBitCount = isWideband
          ? AMR_WB_SPEECH_BITS[ft] ?? 0
          : AMR_NB_SPEECH_BITS[ft] ?? 0;
        const speechBytesCount = Math.ceil(speechBitCount / 8);

        const fileHeader = (ft << 3) | (q << 2) | 0x04;
        const frameBuf = new Uint8Array(1 + speechBytesCount);
        frameBuf[0] = fileHeader;

        for (let b = 0; b < speechBitCount; b++) {
          const bit = readBit();
          if (bit) {
            const byteIdx = 1 + (b >> 3);
            const bitInByte = 7 - (b & 7);
            frameBuf[byteIdx] |= 1 << bitInByte;
          }
        }

        chunks.push(frameBuf);
        totalLen += frameBuf.length;
      }
    }

    const output = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  }
}
