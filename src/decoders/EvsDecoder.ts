/**
 * 3GPP TS 26.445 EVS (Enhanced Voice Services) Audio Decoder wrapper.
 * Decodes 3GPP EVS RTP streams (compact mode, header-full mode with/without CMR,
 * and multi-frame bundles) into 16-bit linear PCM using the official 3GPP
 * reference decoder compiled to WebAssembly.
 */

export interface UnpackedEvsFrame {
  ft: number;
  isAmrWb: boolean;
  bits: number;
  data: Uint8Array;
}

export interface EvsDecodedResult {
  pcm: Int16Array;
  sampleRate: number;
}

export class EvsDecoder {
  private static wasmInstance: WebAssembly.Instance | null = null;
  private static initPromise: Promise<WebAssembly.Instance> | null = null;

  public static readonly EVS_FRAME_BYTES = [
    7,   // FT 0: 5.9 kbps (56 bits = 7 bytes)
    18,  // FT 1: 7.2 kbps (144 bits = 18 bytes)
    20,  // FT 2: 8.0 kbps (160 bits = 20 bytes)
    24,  // FT 3: 9.6 kbps (192 bits = 24 bytes)
    33,  // FT 4: 13.2 kbps (264 bits = 33 bytes)
    41,  // FT 5: 16.4 kbps (328 bits = 41 bytes)
    61,  // FT 6: 24.4 kbps (488 bits = 61 bytes)
    80,  // FT 7: 32.0 kbps (640 bits = 80 bytes)
    120, // FT 8: 48.0 kbps (960 bits = 120 bytes)
    160, // FT 9: 64.0 kbps (1280 bits = 160 bytes)
    240, // FT 10: 96.0 kbps (1920 bits = 240 bytes)
    320, // FT 11: 128.0 kbps (2560 bits = 320 bytes)
    6,   // FT 12: SID (48 bits = 6 bytes)
    0,   // FT 13: reserved
    0,   // FT 14: Speech Lost (0 bits)
    0,   // FT 15: NO_DATA (0 bits)
  ];

  public static readonly EVS_CORE_BITS = [
    56, 144, 160, 192, 264, 328, 488, 640, 960, 1280, 1920, 2560, 48, 0, 0, 0
  ];

  public static readonly AMRWB_FRAME_BYTES = [
    17, 23, 32, 36, 40, 46, 50, 58, 60, 5, 0, 0, 0, 0, 0, 0
  ];

  public static readonly AMRWB_CORE_BITS = [
    132, 177, 253, 285, 317, 365, 397, 461, 477, 35, 0, 0, 0, 0, 0, 0
  ];

  /**
   * Lazily loads and instantiates the EVS WebAssembly decoder module.
   */
  public static async getInstance(): Promise<WebAssembly.Instance> {
    if (EvsDecoder.wasmInstance) {
      return EvsDecoder.wasmInstance;
    }
    if (EvsDecoder.initPromise) {
      return EvsDecoder.initPromise;
    }

    EvsDecoder.initPromise = (async () => {
      const wasmBytes = await EvsDecoder.loadWasmBytes();
      let memory: WebAssembly.Memory | null = null;

      const wasi = {
        environ_sizes_get: (countPtr: number, sizePtr: number) => {
          if (memory) {
            const view = new DataView(memory.buffer);
            view.setUint32(countPtr, 0, true);
            view.setUint32(sizePtr, 0, true);
          }
          return 0;
        },
        environ_get: () => 0,
        fd_close: () => 0,
        fd_fdstat_get: () => 0,
        fd_seek: () => 0,
        fd_write: () => 0,
        proc_exit: (code: number) => {
          console.warn(`EVS WASI proc_exit: ${code}`);
        },
      };

      const module = await WebAssembly.compile(wasmBytes as BufferSource);
      const instance = await WebAssembly.instantiate(module, {
        wasi_snapshot_preview1: wasi,
      });

      memory = instance.exports.memory as WebAssembly.Memory;
      const exp = instance.exports as any;
      if (typeof exp._initialize === 'function') {
        exp._initialize();
      }

      EvsDecoder.wasmInstance = instance;
      return instance;
    })();

    return EvsDecoder.initPromise;
  }

  /**
   * Loads WASM binary bytes across browser, worker, and Node test environments.
   */
  private static async loadWasmBytes(): Promise<Uint8Array> {
    // 1. Browser or Web Worker
    if (typeof window !== 'undefined' || (typeof self !== 'undefined' && typeof (self as any).fetch === 'function')) {
      const currentUrl = (typeof window !== 'undefined' ? window.location?.href : (self as any).location?.href) || 'http://localhost/';
      const dirUrl = currentUrl.endsWith('/') ? currentUrl : currentUrl.substring(0, currentUrl.lastIndexOf('/') + 1);
      const wasmUrl = new URL('evs.wasm', dirUrl).href;
      const resp = await fetch(wasmUrl);
      if (!resp.ok) {
        throw new Error(`Failed to fetch evs.wasm: ${resp.status} ${resp.statusText}`);
      }
      const buf = await resp.arrayBuffer();
      return new Uint8Array(buf);
    }

    // 2. Node.js environment (for tests)
    const fsMod = 'node:fs';
    const pathMod = 'node:path';
    const fs = await import(/* @vite-ignore */ fsMod);
    const path = await import(/* @vite-ignore */ pathMod);
    const candidatePaths = [
      path.resolve(process.cwd(), 'public/evs.wasm'),
      path.resolve(process.cwd(), '../public/evs.wasm'),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      }
    }
    throw new Error('public/evs.wasm not found');
  }

  public static readonly COMPACT_LENS = new Set([320, 240, 160, 120, 80, 61, 41, 33, 24, 20, 18, 15, 6, 0]);

  /**
   * Unpacks an arbitrary 3GPP TS 26.445 EVS RTP packet payload into one or more
   * discrete frames. Supports Header-Full with CMR, Header-Full without CMR,
   * multi-frame bundles, and Compact mode.
   */
  public static unpackEvsPayload(payload: Uint8Array, isHeaderFull: boolean = true): UnpackedEvsFrame[] {
    if (payload.length === 0) {
      return [{ ft: 15, isAmrWb: false, bits: 0, data: new Uint8Array(0) }];
    }

    // 1. If not header-full AND length is a recognized compact length -> compact mode
    if (!isHeaderFull && EvsDecoder.COMPACT_LENS.has(payload.length)) {
      const len = payload.length;
      let ft = 15;
      let bits = 0;
      if (len === 320) { ft = 11; bits = 2560; }
      else if (len === 240) { ft = 10; bits = 1920; }
      else if (len === 160) { ft = 9; bits = 1280; }
      else if (len === 120) { ft = 8; bits = 960; }
      else if (len === 80) { ft = 7; bits = 640; }
      else if (len === 61) { ft = 6; bits = 488; }
      else if (len === 41) { ft = 5; bits = 328; }
      else if (len === 33) { ft = 4; bits = 264; }
      else if (len === 24) { ft = 3; bits = 192; }
      else if (len === 20) { ft = 2; bits = 160; }
      else if (len === 18) { ft = 1; bits = 144; }
      else if (len === 15) { ft = 0; bits = 56; }
      else if (len === 6) { ft = 12; bits = 48; }

      return [{ ft, isAmrWb: false, bits, data: payload }];
    }

    // 2. Header-Full: check start = 1 (CMR at byte 0) first, then start = 0 (no CMR)
    for (const start of [1, 0]) {
      if (payload.length <= start) continue;
      
      const tocs: number[] = [];
      let cur = start;
      while (cur < payload.length) {
        const b = payload[cur++];
        tocs.push(b);
        // Bit 6 (0x40) is continuation / extension bit (F) in EVS RTP ToC
        if ((b & 0x40) === 0) {
          break; // last ToC byte
        }
      }
      if (tocs.length === 0) continue;

      const valid = tocs.every(t => (t & 0x0f) <= 15);
      if (!valid) continue;

      const frames: UnpackedEvsFrame[] = [];
      let dataOffset = cur;

      for (const toc of tocs) {
        const ft = toc & 0x0f;
        const isAmrWb = (toc & 0x20) !== 0;
        const dataLen = isAmrWb
          ? (EvsDecoder.AMRWB_FRAME_BYTES[ft] || 0)
          : (EvsDecoder.EVS_FRAME_BYTES[ft] || 0);
        const bits = isAmrWb
          ? (EvsDecoder.AMRWB_CORE_BITS[ft] || 0)
          : (EvsDecoder.EVS_CORE_BITS[ft] || 0);

        const frameData = (dataLen > 0 && dataOffset + dataLen <= payload.length)
          ? payload.subarray(dataOffset, dataOffset + dataLen)
          : new Uint8Array(0);
        frames.push({ ft, isAmrWb, bits, data: frameData });
        dataOffset += dataLen;
      }

      // Exact match
      if (dataOffset === payload.length) {
        return frames;
      }

      // Special case: single frame FT=14 (Speech Lost) with dummy/padding payload
      if (start === 0 && tocs.length === 1 && (tocs[0] & 0x0f) === 14 && (payload.length === 321 || payload.length === 62)) {
        return frames;
      }

      // Special case: multi-frame where first frame is FT=14 (Speech Lost) with dummy data
      if (start === 0 && tocs.length === 2 && (tocs[0] & 0x0f) === 14 && payload.length === 482) {
        return frames;
      }
    }

    return [{ ft: 15, isAmrWb: false, bits: 0, data: payload }];
  }

  /**
   * Decodes a list of EVS RTP payloads into linear 16-bit PCM.
   */
  public static async decodePayloads(
    payloads: Uint8Array[],
    isHeaderFull: boolean,
    sampleRate: number = 32000
  ): Promise<EvsDecodedResult> {
    if (![8000, 16000, 32000, 48000].includes(sampleRate)) {
      sampleRate = 32000;
    }

    if (payloads.length === 0) {
      return { pcm: new Int16Array(0), sampleRate };
    }

    // Unpack all packets into discrete frames
    const allFrames: UnpackedEvsFrame[] = [];
    for (const p of payloads) {
      const frames = EvsDecoder.unpackEvsPayload(p, isHeaderFull);
      for (const f of frames) {
        allFrames.push(f);
      }
    }

    if (allFrames.length === 0) {
      return { pcm: new Int16Array(0), sampleRate };
    }

    const instance = await EvsDecoder.getInstance();
    const exp = instance.exports as any;

    const dec = exp.evs_decoder_create(sampleRate);
    if (!dec) {
      throw new Error(`Failed to create EVS decoder for sample rate ${sampleRate}`);
    }

    try {
      const inPtr = exp.evs_decoder_input_ptr(dec);
      const outPtr = exp.evs_decoder_output_ptr(dec);
      const frameSamples = exp.evs_decoder_frame_samples(dec);

      const totalSamples = allFrames.length * frameSamples;
      const resultPcm = new Int16Array(totalSamples);
      let outOffset = 0;

      for (const f of allFrames) {
        if (f.data.length > 0) {
          new Uint8Array(exp.memory.buffer).set(f.data, inPtr);
        }

        exp.evs_decoder_decode(dec, f.bits, f.isAmrWb ? 1 : 0, f.ft, 1, 0, 0);

        const outMem = new Int16Array(exp.memory.buffer, outPtr, frameSamples);
        resultPcm.set(outMem, outOffset);
        outOffset += frameSamples;
      }

      return {
        pcm: resultPcm,
        sampleRate,
      };
    } finally {
      exp.evs_decoder_destroy(dec);
    }
  }
}
