import type { RtpStream, StoredRtpPacket } from '../rtp/RtpDemuxer.ts';

export interface H264NalUnit {
  nalType: number;       // 1=Slice, 5=IDR, 7=SPS, 8=PPS, 6=SEI
  nalTypeName: string;
  isKeyframe: boolean;
  data: Uint8Array;      // Raw NAL unit bytes (including 1-byte NAL header, without start code)
  timestamp: number;     // RTP 90kHz timestamp
  timeSec: number;       // Arrival time in seconds
}

export interface H264VideoMetadata {
  codec: 'H264';
  profileLevelId?: string;
  profileName?: string;
  width: number;
  height: number;
  fps: number;
  sps?: Uint8Array;
  pps?: Uint8Array;
  bitstream: Uint8Array; // Annex B byte stream
  nalUnits: H264NalUnit[];
  keyframesCount: number;
  totalNalCount: number;
}

export class H264Depacketizer {
  private static readonly ANNEX_B_START = new Uint8Array([0x00, 0x00, 0x00, 0x01]);

  /**
   * Depacketizes an H.264 RTP stream according to RFC 6184.
   * Handles:
   * - Single NAL Unit Packets (types 1-23)
   * - Aggregation Packets (STAP-A type 24)
   * - Fragmentation Units (FU-A type 28)
   */
  public static depacketize(stream: RtpStream): H264VideoMetadata {
    const packets = stream.packets || [];
    const nalUnits: H264NalUnit[] = [];

    let fuBuffer: Uint8Array[] = [];
    let fuOriginalHeader = 0;
    let fuTimestamp = 0;
    let fuTimeSec = 0;
    let inFu = false;

    let spsBytes: Uint8Array | undefined;
    let ppsBytes: Uint8Array | undefined;
    let parsedWidth = 0;
    let parsedHeight = 0;
    let profileLevelId = '';
    let profileName = '';

    for (const pkt of packets) {
      const payload = pkt.payload;
      if (!payload || payload.length === 0) continue;

      const nalHeader = payload[0];
      const nalType = nalHeader & 0x1f;

      // 1. Single NAL Unit Packet (types 1-23)
      if (nalType >= 1 && nalType <= 23) {
        if (inFu) {
          // Flush uncompleted FU
          inFu = false;
          fuBuffer = [];
        }

        const nalData = payload; // includes nalHeader
        const isKey = nalType === 5 || nalType === 7;
        const nal: H264NalUnit = {
          nalType,
          nalTypeName: H264Depacketizer.getNalTypeName(nalType),
          isKeyframe: isKey,
          data: nalData,
          timestamp: pkt.timestamp,
          timeSec: pkt.pktTime,
        };
        nalUnits.push(nal);

        if (nalType === 7 && !spsBytes) {
          spsBytes = nalData;
          const spsInfo = H264Depacketizer.parseSps(nalData);
          if (spsInfo) {
            parsedWidth = spsInfo.width;
            parsedHeight = spsInfo.height;
            profileLevelId = spsInfo.profileLevelId;
            profileName = spsInfo.profileName;
          }
        } else if (nalType === 8 && !ppsBytes) {
          ppsBytes = nalData;
        }
      }
      // 2. STAP-A: Single-Time Aggregation Packet (type 24)
      else if (nalType === 24) {
        if (inFu) {
          inFu = false;
          fuBuffer = [];
        }

        let offset = 1;
        while (offset + 2 <= payload.length) {
          const nSize = (payload[offset] << 8) | payload[offset + 1];
          offset += 2;
          if (offset + nSize > payload.length) break;

          const nData = payload.subarray(offset, offset + nSize);
          offset += nSize;

          if (nData.length === 0) continue;
          const subType = nData[0] & 0x1f;
          const isKey = subType === 5 || subType === 7;

          const nal: H264NalUnit = {
            nalType: subType,
            nalTypeName: H264Depacketizer.getNalTypeName(subType),
            isKeyframe: isKey,
            data: nData,
            timestamp: pkt.timestamp,
            timeSec: pkt.pktTime,
          };
          nalUnits.push(nal);

          if (subType === 7 && !spsBytes) {
            spsBytes = nData;
            const spsInfo = H264Depacketizer.parseSps(nData);
            if (spsInfo) {
              parsedWidth = spsInfo.width;
              parsedHeight = spsInfo.height;
              profileLevelId = spsInfo.profileLevelId;
              profileName = spsInfo.profileName;
            }
          } else if (subType === 8 && !ppsBytes) {
            ppsBytes = nData;
          }
        }
      }
      // 3. FU-A: Fragmentation Unit (type 28)
      else if (nalType === 28) {
        if (payload.length < 2) continue;

        const fuIndicator = payload[0];
        const fuHeader = payload[1];
        const isStart = (fuHeader & 0x80) !== 0;
        const isEnd = (fuHeader & 0x40) !== 0;
        const reconstructedType = fuHeader & 0x1f;

        if (isStart) {
          inFu = true;
          fuTimestamp = pkt.timestamp;
          fuTimeSec = pkt.pktTime;
          // Reconstruct original NAL header: (F, NRI from indicator) | (Type from FU header)
          fuOriginalHeader = (fuIndicator & 0xe0) | reconstructedType;
          fuBuffer = [new Uint8Array([fuOriginalHeader]), payload.subarray(2)];
        } else if (inFu) {
          fuBuffer.push(payload.subarray(2));
        }

        if (isEnd && inFu) {
          inFu = false;
          // Assemble complete NAL unit
          const totalLen = fuBuffer.reduce((acc, b) => acc + b.length, 0);
          const fullNal = new Uint8Array(totalLen);
          let writePos = 0;
          for (const b of fuBuffer) {
            fullNal.set(b, writePos);
            writePos += b.length;
          }
          fuBuffer = [];

          const isKey = reconstructedType === 5;
          nalUnits.push({
            nalType: reconstructedType,
            nalTypeName: H264Depacketizer.getNalTypeName(reconstructedType),
            isKeyframe: isKey,
            data: fullNal,
            timestamp: fuTimestamp,
            timeSec: fuTimeSec,
          });

          if (reconstructedType === 7 && !spsBytes) {
            spsBytes = fullNal;
            const spsInfo = H264Depacketizer.parseSps(fullNal);
            if (spsInfo) {
              parsedWidth = spsInfo.width;
              parsedHeight = spsInfo.height;
              profileLevelId = spsInfo.profileLevelId;
              profileName = spsInfo.profileName;
            }
          }
        }
      }
    }

    // Assemble Annex B Byte Stream: prefix each NAL unit with 0x00000001
    let totalAnnexBLen = 0;
    for (const nal of nalUnits) {
      totalAnnexBLen += H264Depacketizer.ANNEX_B_START.length + nal.data.length;
    }

    const bitstream = new Uint8Array(totalAnnexBLen);
    let offset = 0;
    for (const nal of nalUnits) {
      bitstream.set(H264Depacketizer.ANNEX_B_START, offset);
      offset += H264Depacketizer.ANNEX_B_START.length;
      bitstream.set(nal.data, offset);
      offset += nal.data.length;
    }

    const keyframesCount = nalUnits.filter(n => n.isKeyframe).length;
    const duration = Math.max(0.1, stream.endTime - stream.startTime);
    const fps = nalUnits.length > 0 ? Math.round((nalUnits.length / duration) * 10) / 10 : 30;

    return {
      codec: 'H264',
      profileLevelId: profileLevelId || '42e01e',
      profileName: profileName || 'Baseline',
      width: parsedWidth || 640,
      height: parsedHeight || 480,
      fps: fps > 0 && fps <= 120 ? fps : 30,
      sps: spsBytes,
      pps: ppsBytes,
      bitstream,
      nalUnits,
      keyframesCount,
      totalNalCount: nalUnits.length,
    };
  }

  public static getNalTypeName(type: number): string {
    switch (type) {
      case 1: return 'Slice (Non-IDR)';
      case 2: return 'Data Partition A';
      case 3: return 'Data Partition B';
      case 4: return 'Data Partition C';
      case 5: return 'IDR (Keyframe)';
      case 6: return 'SEI (Supplemental Enhancement)';
      case 7: return 'SPS (Sequence Parameter Set)';
      case 8: return 'PPS (Picture Parameter Set)';
      case 9: return 'AUD (Access Unit Delimiter)';
      case 24: return 'STAP-A';
      case 28: return 'FU-A';
      default: return `NAL-${type}`;
    }
  }

  /**
   * Parses an H.264 Sequence Parameter Set (SPS) NAL unit.
   * Strips emulation prevention bytes (0x000003 -> 0x0000) and extracts:
   * - profile_idc, level_idc
   * - width and height in pixels
   */
  public static parseSps(spsNal: Uint8Array): {
    profileLevelId: string;
    profileName: string;
    width: number;
    height: number;
  } | null {
    try {
      // Remove NAL header byte if present
      const raw = spsNal.subarray(1);

      // Unescape emulation prevention bytes (0x000003 -> 0x0000)
      const rbsp: number[] = [];
      for (let i = 0; i < raw.length; i++) {
        if (i + 2 < raw.length && raw[i] === 0x00 && raw[i + 1] === 0x00 && raw[i + 2] === 0x03) {
          rbsp.push(raw[i]);
          rbsp.push(raw[i + 1]);
          i += 2; // skip 0x03
        } else {
          rbsp.push(raw[i]);
        }
      }

      const rbspU8 = new Uint8Array(rbsp);
      const reader = new BitReader(rbspU8);

      const profileIdc = reader.readBits(8);
      const profileIop = reader.readBits(8);
      const levelIdc = reader.readBits(8);
      const profileLevelId = [
        profileIdc.toString(16).padStart(2, '0'),
        profileIop.toString(16).padStart(2, '0'),
        levelIdc.toString(16).padStart(2, '0'),
      ].join('');

      let profileName = 'Baseline';
      if (profileIdc === 66) profileName = 'Baseline';
      else if (profileIdc === 77) profileName = 'Main';
      else if (profileIdc === 100) profileName = 'High';
      else if (profileIdc === 110) profileName = 'High 10';
      else if (profileIdc === 122) profileName = 'High 4:2:2';

      reader.readUe(); // seq_parameter_set_id

      if (
        profileIdc === 100 || profileIdc === 110 || profileIdc === 122 ||
        profileIdc === 244 || profileIdc === 44 || profileIdc === 83 ||
        profileIdc === 86 || profileIdc === 118 || profileIdc === 128
      ) {
        const chromaFormatIdc = reader.readUe();
        if (chromaFormatIdc === 3) {
          reader.readBits(1); // separate_colour_plane_flag
        }
        reader.readUe(); // bit_depth_luma_minus8
        reader.readUe(); // bit_depth_chroma_minus8
        reader.readBits(1); // qpprime_y_zero_transform_bypass_flag
        const seqScalingMatrixPresentFlag = reader.readBits(1);
        if (seqScalingMatrixPresentFlag) {
          const count = chromaFormatIdc !== 3 ? 8 : 12;
          for (let i = 0; i < count; i++) {
            const seqScalingListPresentFlag = reader.readBits(1);
            if (seqScalingListPresentFlag) {
              const size = i < 6 ? 16 : 64;
              let lastScale = 8;
              let nextScale = 8;
              for (let j = 0; j < size; j++) {
                if (nextScale !== 0) {
                  const deltaScale = reader.readSe();
                  nextScale = (lastScale + deltaScale + 256) % 256;
                }
                lastScale = nextScale === 0 ? lastScale : nextScale;
              }
            }
          }
        }
      }

      reader.readUe(); // log2_max_frame_num_minus4
      const picOrderCntType = reader.readUe();
      if (picOrderCntType === 0) {
        reader.readUe(); // log2_max_pic_order_cnt_lsb_minus4
      } else if (picOrderCntType === 1) {
        reader.readBits(1); // delta_pic_order_always_zero_flag
        reader.readSe(); // offset_for_non_ref_pic
        reader.readSe(); // offset_for_top_to_bottom_field
        const numRefFramesInCycle = reader.readUe();
        for (let i = 0; i < numRefFramesInCycle; i++) {
          reader.readSe();
        }
      }

      reader.readUe(); // max_num_ref_frames
      reader.readBits(1); // gaps_in_frame_num_value_allowed_flag
      const picWidthInMbsMinus1 = reader.readUe();
      const picHeightInMapUnitsMinus1 = reader.readUe();
      const frameMbsOnlyFlag = reader.readBits(1);
      if (!frameMbsOnlyFlag) {
        reader.readBits(1); // mb_adaptive_frame_field_flag
      }
      reader.readBits(1); // direct_8x8_inference_flag

      const frameCroppingFlag = reader.readBits(1);
      let cropLeft = 0;
      let cropRight = 0;
      let cropTop = 0;
      let cropBottom = 0;

      if (frameCroppingFlag) {
        cropLeft = reader.readUe();
        cropRight = reader.readUe();
        cropTop = reader.readUe();
        cropBottom = reader.readUe();
      }

      const width = (picWidthInMbsMinus1 + 1) * 16 - (cropLeft + cropRight) * 2;
      const height = (picHeightInMapUnitsMinus1 + 1) * 16 * (frameMbsOnlyFlag ? 1 : 2) - (cropTop + cropBottom) * 2;

      return {
        profileLevelId,
        profileName,
        width: Math.max(16, width),
        height: Math.max(16, height),
      };
    } catch {
      return null;
    }
  }
}

class BitReader {
  private data: Uint8Array;
  private bytePos = 0;
  private bitPos = 0;

  constructor(data: Uint8Array) {
    this.data = data;
  }

  public readBits(n: number): number {
    let result = 0;
    for (let i = 0; i < n; i++) {
      if (this.bytePos >= this.data.length) return 0;
      const bit = (this.data[this.bytePos] >> (7 - this.bitPos)) & 1;
      result = (result << 1) | bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.bytePos++;
      }
    }
    return result;
  }

  public readUe(): number {
    let zeros = 0;
    while (this.bytePos < this.data.length && this.readBits(1) === 0) {
      zeros++;
    }
    if (zeros === 0) return 0;
    return ((1 << zeros) - 1) + this.readBits(zeros);
  }

  public readSe(): number {
    const val = this.readUe();
    return val % 2 === 1 ? (val + 1) / 2 : -(val / 2);
  }
}
