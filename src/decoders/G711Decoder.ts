/**
 * High-performance, byte-exact ITU-T G.711 u-law (PCMU) and a-law (PCMA) decoders.
 */
export class G711Decoder {
  private static ULAW_TABLE: Int16Array = G711Decoder.initUlawTable();
  private static ALAW_TABLE: Int16Array = G711Decoder.initAlawTable();

  private static initUlawTable(): Int16Array {
    const tbl = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      const inv = ~i & 0xff;
      const sign = i & 0x80;
      const exp = (inv >> 4) & 0x07;
      const man = inv & 0x0f;
      let smp = ((man << 3) + 0x84) << exp;
      smp -= 0x84;
      tbl[i] = sign ? smp : -smp;
    }
    return tbl;
  }

  private static initAlawTable(): Int16Array {
    const tbl = new Int16Array(256);
    for (let i = 0; i < 256; i++) {
      const inv = i ^ 0x55;
      const sign = i & 0x80;
      const exp = (inv >> 4) & 0x07;
      const man = inv & 0x0f;
      let smp = exp === 0 ? (man << 4) + 8 : ((man << 4) + 0x108) << (exp - 1);
      tbl[i] = sign ? smp : -smp;
    }
    return tbl;
  }

  /**
   * Decode G.711 u-law bytes to 16-bit linear PCM (8000 Hz).
   */
  public static decodeUlaw(input: Uint8Array): Int16Array {
    const output = new Int16Array(input.length);
    const table = G711Decoder.ULAW_TABLE;
    for (let i = 0; i < input.length; i++) {
      output[i] = table[input[i]];
    }
    return output;
  }

  /**
   * Decode G.711 a-law bytes to 16-bit linear PCM (8000 Hz).
   */
  public static decodeAlaw(input: Uint8Array): Int16Array {
    const output = new Int16Array(input.length);
    const table = G711Decoder.ALAW_TABLE;
    for (let i = 0; i < input.length; i++) {
      output[i] = table[input[i]];
    }
    return output;
  }
}
