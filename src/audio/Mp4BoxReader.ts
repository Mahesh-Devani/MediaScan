/**
 * Lightweight ISO Base Media File Format (ISO-BMFF / 3GP / MP4) box parser.
 * Specifically extracts AMR-NB ('samr'), AMR-WB ('sawb'), and audio sample streams
 * directly from 3GP containers without transcoding.
 * 
 * Compliant with 3GPP TS 26.244 and ISO/IEC 14496-12.
 */

export interface Mp4AudioTrack {
  trackId: number;
  codec: 'samr' | 'sawb' | 'mp4a' | string;
  sampleRate: number;
  channelCount: number;
  samples: Uint8Array[];
  durationsMs: number[];
  totalDurationMs: number;
}

export interface Mp4ParseResult {
  brands: string[];
  audioTracks: Mp4AudioTrack[];
}

export class Mp4BoxReader {
  /**
   * Check if a buffer starts with an ISO BMFF / 3GP ftyp box.
   */
  public static isMp4Or3gp(bytes: Uint8Array): boolean {
    if (bytes.length < 8) return false;
    const type = String.fromCharCode(...bytes.subarray(4, 8));
    return type === 'ftyp';
  }

  /**
   * Parse an ISO BMFF / 3GP container and extract audio sample streams.
   */
  public static parse(buffer: Uint8Array): Mp4ParseResult {
    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    let offset = 0;
    const brands: string[] = [];
    const audioTracks: Mp4AudioTrack[] = [];

    while (offset + 8 <= buffer.length) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(...buffer.subarray(offset + 4, offset + 8));
      let headerLen = 8;

      if (size === 1) {
        // 64-bit large box
        if (offset + 16 > buffer.length) break;
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 4294967296 + low;
        headerLen = 16;
      } else if (size === 0) {
        // Box extends to EOF
        size = buffer.length - offset;
      }

      if (size < headerLen || offset + size > buffer.length) {
        break; // Corrupted or truncated box
      }

      const boxData = buffer.subarray(offset + headerLen, offset + size);

      if (type === 'ftyp') {
        const majorBrand = String.fromCharCode(...boxData.subarray(0, 4));
        brands.push(majorBrand);
        // Compatible brands follow after minor_version (4 bytes)
        for (let b = 8; b + 4 <= boxData.length; b += 4) {
          brands.push(String.fromCharCode(...boxData.subarray(b, b + 4)));
        }
      } else if (type === 'moov') {
        this.parseMoov(boxData, buffer, audioTracks);
      }

      offset += size;
    }

    return { brands, audioTracks };
  }

  private static parseMoov(
    moovData: Uint8Array,
    fullBuffer: Uint8Array,
    audioTracks: Mp4AudioTrack[]
  ): void {
    const view = new DataView(moovData.buffer, moovData.byteOffset, moovData.byteLength);
    let offset = 0;

    while (offset + 8 <= moovData.length) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(...moovData.subarray(offset + 4, offset + 8));
      let headerLen = 8;

      if (size === 1) {
        if (offset + 16 > moovData.length) break;
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 4294967296 + low;
        headerLen = 16;
      } else if (size === 0) {
        size = moovData.length - offset;
      }

      if (size < headerLen || offset + size > moovData.length) break;

      const boxData = moovData.subarray(offset + headerLen, offset + size);
      if (type === 'trak') {
        const track = this.parseTrak(boxData, fullBuffer);
        if (track) {
          audioTracks.push(track);
        }
      }

      offset += size;
    }
  }

  private static parseTrak(
    trakData: Uint8Array,
    fullBuffer: Uint8Array
  ): Mp4AudioTrack | null {
    // Find mdia
    const mdia = this.findChildBox(trakData, 'mdia');
    if (!mdia) return null;

    // Check hdlr (Handler Reference Box) to ensure it's an audio ('soun') track
    const hdlr = this.findChildBox(mdia, 'hdlr');
    if (hdlr && hdlr.length >= 12) {
      const handlerType = String.fromCharCode(...hdlr.subarray(8, 12));
      if (handlerType !== 'soun') {
        return null; // Not an audio track
      }
    }

    // Find minf -> stbl
    const minf = this.findChildBox(mdia, 'minf');
    if (!minf) return null;

    const stbl = this.findChildBox(minf, 'stbl');
    if (!stbl) return null;

    // Parse stsd (Sample Description)
    const stsd = this.findChildBox(stbl, 'stsd');
    if (!stsd || stsd.length < 8) return null;

    const stsdView = new DataView(stsd.buffer, stsd.byteOffset, stsd.byteLength);
    const entryCount = stsdView.getUint32(4);
    if (entryCount === 0) return null;

    // First audio entry
    let stsdOffset = 8;
    if (stsdOffset + 8 > stsd.length) return null;
    const entrySize = stsdView.getUint32(stsdOffset);
    const codec = String.fromCharCode(...stsd.subarray(stsdOffset + 4, stsdOffset + 8));

    // AudioSampleEntry starts at stsdOffset + 8:
    // 6 reserved bytes, 2 data_ref_index, 2 version, 2 revision, 4 vendor,
    // 2 channel_count, 2 sample_size, 2 comp_id, 2 packet_size, 4 sample_rate (16.16 fixed point)
    let channelCount = 1;
    let sampleRate = 8000;

    if (entrySize >= 28 && stsdOffset + 36 <= stsd.length) {
      channelCount = stsdView.getUint16(stsdOffset + 24);
      sampleRate = stsdView.getUint32(stsdOffset + 32) >>> 16;
      if (sampleRate === 0) {
        sampleRate = codec === 'sawb' ? 16000 : 8000;
      }
    }

    // Parse stsz (Sample Sizes)
    const stsz = this.findChildBox(stbl, 'stsz');
    if (!stsz || stsz.length < 12) return null;
    const stszView = new DataView(stsz.buffer, stsz.byteOffset, stsz.byteLength);
    const uniformSize = stszView.getUint32(4);
    const sampleCount = stszView.getUint32(8);

    const sampleSizes: number[] = new Array(sampleCount);
    if (uniformSize > 0) {
      sampleSizes.fill(uniformSize);
    } else {
      let sOffset = 12;
      for (let i = 0; i < sampleCount; i++) {
        if (sOffset + 4 > stsz.length) break;
        sampleSizes[i] = stszView.getUint32(sOffset);
        sOffset += 4;
      }
    }

    // Parse stco / co64 (Chunk Offsets)
    const chunkOffsets: number[] = [];
    const stco = this.findChildBox(stbl, 'stco');
    if (stco && stco.length >= 8) {
      const stcoView = new DataView(stco.buffer, stco.byteOffset, stco.byteLength);
      const count = stcoView.getUint32(4);
      let cOffset = 8;
      for (let i = 0; i < count; i++) {
        if (cOffset + 4 > stco.length) break;
        chunkOffsets.push(stcoView.getUint32(cOffset));
        cOffset += 4;
      }
    } else {
      const co64 = this.findChildBox(stbl, 'co64');
      if (co64 && co64.length >= 8) {
        const co64View = new DataView(co64.buffer, co64.byteOffset, co64.byteLength);
        const count = co64View.getUint32(4);
        let cOffset = 8;
        for (let i = 0; i < count; i++) {
          if (cOffset + 8 > co64.length) break;
          const high = co64View.getUint32(cOffset);
          const low = co64View.getUint32(cOffset + 4);
          chunkOffsets.push(high * 4294967296 + low);
          cOffset += 8;
        }
      }
    }

    // Parse stsc (Sample to Chunk)
    const stsc = this.findChildBox(stbl, 'stsc');
    const samplesPerChunk: number[] = [];
    if (stsc && stsc.length >= 8) {
      const stscView = new DataView(stsc.buffer, stsc.byteOffset, stsc.byteLength);
      const entryCount = stscView.getUint32(4);
      const table: { firstChunk: number; samplesPerChunk: number; descIndex: number }[] = [];
      let tOffset = 8;
      for (let i = 0; i < entryCount; i++) {
        if (tOffset + 12 > stsc.length) break;
        table.push({
          firstChunk: stscView.getUint32(tOffset),
          samplesPerChunk: stscView.getUint32(tOffset + 4),
          descIndex: stscView.getUint32(tOffset + 8),
        });
        tOffset += 12;
      }

      // Expand to chunkOffsets length
      let tableIdx = 0;
      for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
        const chunkNum = chunkIdx + 1; // 1-based
        if (tableIdx + 1 < table.length && chunkNum >= table[tableIdx + 1].firstChunk) {
          tableIdx++;
        }
        samplesPerChunk.push(table[tableIdx] ? table[tableIdx].samplesPerChunk : 1);
      }
    } else {
      // Default 1 sample per chunk
      samplesPerChunk.fill(1, 0, chunkOffsets.length);
    }

    // Parse stts (Time-to-Sample) to calculate duration
    let totalDurationMs = 0;
    const durationsMs: number[] = [];
    const stts = this.findChildBox(stbl, 'stts');
    if (stts && stts.length >= 8) {
      const sttsView = new DataView(stts.buffer, stts.byteOffset, stts.byteLength);
      const entryCount = sttsView.getUint32(4);
      let sOffset = 8;
      for (let i = 0; i < entryCount; i++) {
        if (sOffset + 8 > stts.length) break;
        const count = sttsView.getUint32(sOffset);
        const delta = sttsView.getUint32(sOffset + 4);
        const durMs = (delta / (sampleRate || 8000)) * 1000;
        for (let j = 0; j < count; j++) {
          durationsMs.push(durMs);
          totalDurationMs += durMs;
        }
        sOffset += 8;
      }
    } else {
      // Default 20 ms per frame for telecom audio
      for (let i = 0; i < sampleCount; i++) {
        durationsMs.push(20);
        totalDurationMs += 20;
      }
    }

    // Extract actual sample buffers from fullBuffer using chunkOffsets + sampleSizes
    const samples: Uint8Array[] = [];
    let sampleIdx = 0;

    for (let chunkIdx = 0; chunkIdx < chunkOffsets.length; chunkIdx++) {
      let filePos = chunkOffsets[chunkIdx];
      const countInChunk = samplesPerChunk[chunkIdx] || 1;

      for (let s = 0; s < countInChunk && sampleIdx < sampleSizes.length; s++) {
        const size = sampleSizes[sampleIdx++];
        if (filePos + size <= fullBuffer.length) {
          samples.push(fullBuffer.subarray(filePos, filePos + size));
        }
        filePos += size;
      }
    }

    return {
      trackId: 1,
      codec,
      sampleRate,
      channelCount,
      samples,
      durationsMs,
      totalDurationMs,
    };
  }

  private static findChildBox(container: Uint8Array, targetType: string): Uint8Array | null {
    const view = new DataView(container.buffer, container.byteOffset, container.byteLength);
    let offset = 0;

    while (offset + 8 <= container.length) {
      let size = view.getUint32(offset);
      const type = String.fromCharCode(...container.subarray(offset + 4, offset + 8));
      let headerLen = 8;

      if (size === 1) {
        if (offset + 16 > container.length) break;
        const high = view.getUint32(offset + 8);
        const low = view.getUint32(offset + 12);
        size = high * 4294967296 + low;
        headerLen = 16;
      } else if (size === 0) {
        size = container.length - offset;
      }

      if (size < headerLen || offset + size > container.length) break;

      if (type === targetType) {
        return container.subarray(offset + headerLen, offset + size);
      }

      offset += size;
    }

    return null;
  }
}
