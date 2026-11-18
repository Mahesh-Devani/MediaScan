/**
 * CodecProfileRegistry.ts
 * Data-driven registry defining every telephony and media codec profile, valid bitrates,
 * bandwidths, frame sizes, DTX characteristics, file headers, and filename templates.
 * Aligned with 3GPP, ITU-T, IETF specifications, and RTPG reference clip naming conventions.
 */

export type AudioBandwidth = 'NB' | 'WB' | 'SWB' | 'FB';

export interface CodecModeDefinition {
  modeId: string | number;
  bitrateKbps: number;
  rateLabel: string;        // e.g. 'r475', 'r795', 'r238', 'r96'
  framePayloadBytes: number;
  tocByte?: number;         // ToC byte when applicable (e.g. AMR, EVS)
  description?: string;
}

export interface CodecProfile {
  id: string;               // e.g. 'g711u', 'g711a', 'g722', 'g726', 'amr-nb', 'amr-wb', 'evs', 'g729', 'ilbc', 'opus'
  name: string;             // Display name, e.g. 'G.711 µ-law (PCMU)'
  sampleRate: number;       // Native input rate (8000, 16000, 32000, 48000)
  bandwidth: AudioBandwidth;
  frameDurationMs: number;  // Typically 10, 20, or 30 ms (or 0 for continuous octets)
  modes: CodecModeDefinition[];
  defaultModeIndex: number;
  supportsDtx: boolean;
  defaultDtx: boolean;
  supportsOctetAlignToggle?: boolean;
  fileExtension: string;    // Default extension, e.g. 'ulaw', '722', 'amr', 'awb', 'evs', '729'
  filenameTemplate: string; // e.g. '{base}.{CODEC}r{rate}{dtx}' or '{base}.{ext}'
  fileMagic?: Uint8Array;   // Container file header magic (e.g. #!AMR\n)
  channelCountHeader?: boolean; // EVS 4-byte big-endian channel count
  docUrl?: string;          // Official specification or standard documentation URL
  docTitle?: string;        // Specification label e.g. 'ITU-T G.722'
  description?: string;     // Technical summary of the codec
}

export class CodecProfileRegistry {
  private static profiles: Map<string, CodecProfile> = new Map();

  static {
    // 1. G.711 mu-law (PCMU)
    this.register({
      id: 'g711u',
      name: 'G.711 µ-law (PCMU)',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: '64k', bitrateKbps: 64, rateLabel: '64', framePayloadBytes: 160, description: '64 kbps standard log-PCM' }
      ],
      defaultModeIndex: 0,
      supportsDtx: false,
      defaultDtx: false,
      fileExtension: 'ulaw',
      filenameTemplate: '{base}.ulaw',
      docUrl: 'https://www.itu.int/rec/T-REC-G.711',
      docTitle: 'ITU-T G.711',
      description: 'ITU-T G.711 µ-law: 64 kbps (8 kHz) PCM log companding. Primary PSTN and VoIP standard in North America and Japan.'
    });

    // 2. G.711 A-law (PCMA)
    this.register({
      id: 'g711a',
      name: 'G.711 A-law (PCMA)',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: '64k', bitrateKbps: 64, rateLabel: '64', framePayloadBytes: 160, description: '64 kbps standard log-PCM' }
      ],
      defaultModeIndex: 0,
      supportsDtx: false,
      defaultDtx: false,
      fileExtension: 'alaw',
      filenameTemplate: '{base}.alaw',
      docUrl: 'https://www.itu.int/rec/T-REC-G.711',
      docTitle: 'ITU-T G.711',
      description: 'ITU-T G.711 A-law: 64 kbps (8 kHz) PCM log companding. Primary PSTN and VoIP standard in Europe and internationally.'
    });

    // 3. G.722 (Wideband Sub-band ADPCM)
    this.register({
      id: 'g722',
      name: 'G.722 Wideband ADPCM',
      sampleRate: 16000,
      bandwidth: 'WB',
      frameDurationMs: 20,
      modes: [
        { modeId: 'mode1', bitrateKbps: 64, rateLabel: '64', framePayloadBytes: 160, description: 'Mode 1 (64 kbps, 8-bit octet)' },
        { modeId: 'mode2', bitrateKbps: 56, rateLabel: '56', framePayloadBytes: 140, description: 'Mode 2 (56 kbps, 7-bit octet)' },
        { modeId: 'mode3', bitrateKbps: 48, rateLabel: '48', framePayloadBytes: 120, description: 'Mode 3 (48 kbps, 6-bit octet)' }
      ],
      defaultModeIndex: 0,
      supportsDtx: false,
      defaultDtx: false,
      fileExtension: '722',
      filenameTemplate: '{base}.722',
      docUrl: 'https://www.itu.int/rec/T-REC-G.722',
      docTitle: 'ITU-T G.722',
      description: 'ITU-T G.722: 7 kHz Wideband audio coding at 64/56/48 kbps using Sub-Band ADPCM (16 kHz). Provides crystal-clear wideband HD voice.'
    });

    // 4. G.726 (Narrowband ADPCM)
    this.register({
      id: 'g726',
      name: 'G.726 ADPCM',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: '16k', bitrateKbps: 16, rateLabel: '16', framePayloadBytes: 40, description: '16 kbps (2 bits/sample)' },
        { modeId: '24k', bitrateKbps: 24, rateLabel: '24', framePayloadBytes: 60, description: '24 kbps (3 bits/sample)' },
        { modeId: '32k', bitrateKbps: 32, rateLabel: '32', framePayloadBytes: 80, description: '32 kbps (4 bits/sample, typical)' },
        { modeId: '40k', bitrateKbps: 40, rateLabel: '40', framePayloadBytes: 100, description: '40 kbps (5 bits/sample)' }
      ],
      defaultModeIndex: 2,
      supportsDtx: false,
      defaultDtx: false,
      fileExtension: 'g726',
      filenameTemplate: '{base}.g726',
      docUrl: 'https://www.itu.int/rec/T-REC-G.726',
      docTitle: 'ITU-T G.726',
      description: 'ITU-T G.726: 40, 32, 24, 16 kbps ADPCM (8 kHz). Standard for DECT wireless cordless phones and PBX interconnects.'
    });

    // 5. AMR-NB (3GPP TS 26.101 / RFC 4867)
    this.register({
      id: 'amr-nb',
      name: 'AMR-NB (Adaptive Multi-Rate Narrowband)',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: 0, bitrateKbps: 4.75, rateLabel: '475', framePayloadBytes: 12, tocByte: 0x04, description: 'Mode 0: 4.75 kbps' },
        { modeId: 1, bitrateKbps: 5.15, rateLabel: '515', framePayloadBytes: 13, tocByte: 0x0c, description: 'Mode 1: 5.15 kbps' },
        { modeId: 2, bitrateKbps: 5.90, rateLabel: '59',  framePayloadBytes: 15, tocByte: 0x14, description: 'Mode 2: 5.90 kbps' },
        { modeId: 3, bitrateKbps: 6.70, rateLabel: '67',  framePayloadBytes: 17, tocByte: 0x1c, description: 'Mode 3: 6.70 kbps' },
        { modeId: 4, bitrateKbps: 7.40, rateLabel: '74',  framePayloadBytes: 19, tocByte: 0x24, description: 'Mode 4: 7.40 kbps' },
        { modeId: 5, bitrateKbps: 7.95, rateLabel: '795', framePayloadBytes: 20, tocByte: 0x2c, description: 'Mode 5: 7.95 kbps' },
        { modeId: 6, bitrateKbps: 10.20, rateLabel: '102', framePayloadBytes: 26, tocByte: 0x34, description: 'Mode 6: 10.20 kbps' },
        { modeId: 7, bitrateKbps: 12.20, rateLabel: '122', framePayloadBytes: 31, tocByte: 0x3c, description: 'Mode 7: 12.20 kbps (GSM-EFR)' }
      ],
      defaultModeIndex: 7,
      supportsDtx: true,
      defaultDtx: false,
      supportsOctetAlignToggle: true,
      fileExtension: 'amr',
      filenameTemplate: '{base}.AMRr{rate}{dtx}',
      fileMagic: new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a]), // #!AMR\n
      docUrl: 'https://www.3gpp.org/ftp/Specs/archive/26_series/26.071/',
      docTitle: '3GPP TS 26.071 / RFC 4867',
      description: '3GPP TS 26.071 / RFC 4867: Adaptive Multi-Rate Narrowband speech codec (8 kHz, 4.75–12.2 kbps). Standard 2G/3G mobile cellular codec.'
    });

    // 6. AMR-WB (3GPP TS 26.201 / ITU-T G.722.2 / RFC 4867)
    this.register({
      id: 'amr-wb',
      name: 'AMR-WB (G.722.2 Wideband)',
      sampleRate: 16000,
      bandwidth: 'WB',
      frameDurationMs: 20,
      modes: [
        { modeId: 0, bitrateKbps: 6.60, rateLabel: '66',  framePayloadBytes: 17, tocByte: 0x04, description: 'Mode 0: 6.60 kbps' },
        { modeId: 1, bitrateKbps: 8.85, rateLabel: '88',  framePayloadBytes: 23, tocByte: 0x0c, description: 'Mode 1: 8.85 kbps' },
        { modeId: 2, bitrateKbps: 12.65, rateLabel: '126', framePayloadBytes: 32, tocByte: 0x14, description: 'Mode 2: 12.65 kbps (VolTE)' },
        { modeId: 3, bitrateKbps: 14.25, rateLabel: '142', framePayloadBytes: 36, tocByte: 0x1c, description: 'Mode 3: 14.25 kbps' },
        { modeId: 4, bitrateKbps: 15.85, rateLabel: '158', framePayloadBytes: 40, tocByte: 0x24, description: 'Mode 4: 15.85 kbps' },
        { modeId: 5, bitrateKbps: 18.25, rateLabel: '182', framePayloadBytes: 46, tocByte: 0x2c, description: 'Mode 5: 18.25 kbps' },
        { modeId: 6, bitrateKbps: 19.85, rateLabel: '198', framePayloadBytes: 50, tocByte: 0x34, description: 'Mode 6: 19.85 kbps' },
        { modeId: 7, bitrateKbps: 23.05, rateLabel: '230', framePayloadBytes: 58, tocByte: 0x3c, description: 'Mode 7: 23.05 kbps' },
        { modeId: 8, bitrateKbps: 23.85, rateLabel: '238', framePayloadBytes: 60, tocByte: 0x44, description: 'Mode 8: 23.85 kbps (Full Band)' }
      ],
      defaultModeIndex: 8,
      supportsDtx: true,
      defaultDtx: false,
      supportsOctetAlignToggle: true,
      fileExtension: 'awb',
      filenameTemplate: '{base}.AMRWBr{rate}{dtx}',
      fileMagic: new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x2d, 0x57, 0x42, 0x0a]), // #!AMR-WB\n
      docUrl: 'https://www.3gpp.org/ftp/Specs/archive/26_series/26.171/',
      docTitle: '3GPP TS 26.171 / ITU-T G.722.2',
      description: '3GPP TS 26.171 / ITU-T G.722.2: Adaptive Multi-Rate Wideband HD Voice codec (16 kHz, 6.6–23.85 kbps). Standard for 3G/VoLTE HD Voice.'
    });

    // 7. EVS-NB (3GPP TS 26.445 Enhanced Voice Services Narrowband)
    this.register({
      id: 'evs-nb',
      name: 'EVS (3GPP Enhanced Voice Services)',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: 'evs_5_9',  bitrateKbps: 5.9,   rateLabel: '59',   framePayloadBytes: 15,  tocByte: 0x00, description: 'Primary 5.9 kbps' },
        { modeId: 'evs_7_2',  bitrateKbps: 7.2,   rateLabel: '72',   framePayloadBytes: 18,  tocByte: 0x01, description: 'Primary 7.2 kbps' },
        { modeId: 'evs_8_0',  bitrateKbps: 8.0,   rateLabel: '80',   framePayloadBytes: 20,  tocByte: 0x02, description: 'Primary 8.0 kbps' },
        { modeId: 'evs_9_6',  bitrateKbps: 9.6,   rateLabel: '96',   framePayloadBytes: 24,  tocByte: 0x03, description: 'Primary 9.6 kbps (Standard VoLTE NB)' },
        { modeId: 'evs_13_2', bitrateKbps: 13.2,  rateLabel: '132',  framePayloadBytes: 33,  tocByte: 0x04, description: 'Primary 13.2 kbps' },
        { modeId: 'evs_16_4', bitrateKbps: 16.4,  rateLabel: '164',  framePayloadBytes: 41,  tocByte: 0x05, description: 'Primary 16.4 kbps' },
        { modeId: 'evs_24_4', bitrateKbps: 24.4,  rateLabel: '244',  framePayloadBytes: 61,  tocByte: 0x06, description: 'Primary 24.4 kbps' },
      ],
      defaultModeIndex: 3, // 9.6 kbps
      supportsDtx: true,
      defaultDtx: false,
      fileExtension: 'evs',
      filenameTemplate: '{base}.EVS{band}r{rate}{dtx}',
      fileMagic: new Uint8Array([0x23, 0x21, 0x45, 0x56, 0x53, 0x5f, 0x4d, 0x43, 0x31, 0x2e, 0x30, 0x0a]), // #!EVS_MC1.0\n
      channelCountHeader: true,
      docUrl: 'https://www.3gpp.org/ftp/Specs/archive/26_series/26.445/',
      docTitle: '3GPP TS 26.445',
      description: '3GPP TS 26.445: Enhanced Voice Services (EVS) Narrowband (8 kHz) operating from 5.9 to 24.4 kbps for VoLTE/5G.'
    });

    // 8. EVS (3GPP TS 26.445 Enhanced Voice Services Wideband)
    this.register({
      id: 'evs',
      name: 'EVS (3GPP Enhanced Voice Services)',
      sampleRate: 16000,
      bandwidth: 'WB',
      frameDurationMs: 20,
      modes: [
        { modeId: 'evs_5_9',  bitrateKbps: 5.9,   rateLabel: '59',   framePayloadBytes: 15,  tocByte: 0x00, description: 'Primary 5.9 kbps' },
        { modeId: 'evs_7_2',  bitrateKbps: 7.2,   rateLabel: '72',   framePayloadBytes: 18,  tocByte: 0x01, description: 'Primary 7.2 kbps' },
        { modeId: 'evs_8_0',  bitrateKbps: 8.0,   rateLabel: '80',   framePayloadBytes: 20,  tocByte: 0x02, description: 'Primary 8.0 kbps' },
        { modeId: 'evs_9_6',  bitrateKbps: 9.6,   rateLabel: '96',   framePayloadBytes: 24,  tocByte: 0x03, description: 'Primary 9.6 kbps (Standard VoLTE)' },
        { modeId: 'evs_13_2', bitrateKbps: 13.2,  rateLabel: '132',  framePayloadBytes: 33,  tocByte: 0x04, description: 'Primary 13.2 kbps' },
        { modeId: 'evs_16_4', bitrateKbps: 16.4,  rateLabel: '164',  framePayloadBytes: 41,  tocByte: 0x05, description: 'Primary 16.4 kbps' },
        { modeId: 'evs_24_4', bitrateKbps: 24.4,  rateLabel: '244',  framePayloadBytes: 61,  tocByte: 0x06, description: 'Primary 24.4 kbps' },
        { modeId: 'evs_32_0', bitrateKbps: 32.0,  rateLabel: '320',  framePayloadBytes: 80,  tocByte: 0x07, description: 'Primary 32.0 kbps' },
        { modeId: 'evs_48_0', bitrateKbps: 48.0,  rateLabel: '480',  framePayloadBytes: 120, tocByte: 0x08, description: 'Primary 48.0 kbps' },
        { modeId: 'evs_64_0', bitrateKbps: 64.0,  rateLabel: '640',  framePayloadBytes: 160, tocByte: 0x09, description: 'Primary 64.0 kbps' },
        { modeId: 'evs_96_0', bitrateKbps: 96.0,  rateLabel: '960',  framePayloadBytes: 240, tocByte: 0x0a, description: 'Primary 96.0 kbps' },
        { modeId: 'evs_128_0',bitrateKbps: 128.0, rateLabel: '1280', framePayloadBytes: 320, tocByte: 0x0b, description: 'Primary 128.0 kbps' },
        // AMR-WB IO modes in EVS
        { modeId: 'io_6_6',   bitrateKbps: 6.60,  rateLabel: '66',   framePayloadBytes: 17,  tocByte: 0x30, description: 'AMR-WB IO 6.60 kbps' },
        { modeId: 'io_8_85',  bitrateKbps: 8.85,  rateLabel: '88',   framePayloadBytes: 23,  tocByte: 0x31, description: 'AMR-WB IO 8.85 kbps' },
        { modeId: 'io_12_65', bitrateKbps: 12.65, rateLabel: '126',  framePayloadBytes: 32,  tocByte: 0x32, description: 'AMR-WB IO 12.65 kbps' },
        { modeId: 'io_23_85', bitrateKbps: 23.85, rateLabel: '238',  framePayloadBytes: 60,  tocByte: 0x38, description: 'AMR-WB IO 23.85 kbps' }
      ],
      defaultModeIndex: 3, // 9.6 kbps
      supportsDtx: true,
      defaultDtx: false,
      fileExtension: 'evs',
      filenameTemplate: '{base}.EVS{band}r{rate}{dtx}',
      fileMagic: new Uint8Array([0x23, 0x21, 0x45, 0x56, 0x53, 0x5f, 0x4d, 0x43, 0x31, 0x2e, 0x30, 0x0a]), // #!EVS_MC1.0\n
      channelCountHeader: true,
      docUrl: 'https://www.3gpp.org/ftp/Specs/archive/26_series/26.445/',
      docTitle: '3GPP TS 26.445',
      description: '3GPP TS 26.445: Enhanced Voice Services (EVS) Wideband (16 kHz) operating from 5.9 to 128 kbps with AMR-WB IO compatibility.'
    });

    // 9. EVS-SWB (3GPP TS 26.445 Enhanced Voice Services Super-Wideband)
    this.register({
      id: 'evs-swb',
      name: 'EVS (3GPP Enhanced Voice Services)',
      sampleRate: 32000,
      bandwidth: 'SWB',
      frameDurationMs: 20,
      modes: [
        { modeId: 'evs_9_6',  bitrateKbps: 9.6,   rateLabel: '96',   framePayloadBytes: 24,  tocByte: 0x03, description: 'Primary 9.6 kbps' },
        { modeId: 'evs_13_2', bitrateKbps: 13.2,  rateLabel: '132',  framePayloadBytes: 33,  tocByte: 0x04, description: 'Primary 13.2 kbps (Standard 5G/VoNR SWB)' },
        { modeId: 'evs_16_4', bitrateKbps: 16.4,  rateLabel: '164',  framePayloadBytes: 41,  tocByte: 0x05, description: 'Primary 16.4 kbps' },
        { modeId: 'evs_24_4', bitrateKbps: 24.4,  rateLabel: '244',  framePayloadBytes: 61,  tocByte: 0x06, description: 'Primary 24.4 kbps (High Fidelity SWB)' },
        { modeId: 'evs_32_0', bitrateKbps: 32.0,  rateLabel: '320',  framePayloadBytes: 80,  tocByte: 0x07, description: 'Primary 32.0 kbps' },
        { modeId: 'evs_48_0', bitrateKbps: 48.0,  rateLabel: '480',  framePayloadBytes: 120, tocByte: 0x08, description: 'Primary 48.0 kbps' },
        { modeId: 'evs_64_0', bitrateKbps: 64.0,  rateLabel: '640',  framePayloadBytes: 160, tocByte: 0x09, description: 'Primary 64.0 kbps' },
        { modeId: 'evs_96_0', bitrateKbps: 96.0,  rateLabel: '960',  framePayloadBytes: 240, tocByte: 0x0a, description: 'Primary 96.0 kbps' },
        { modeId: 'evs_128_0',bitrateKbps: 128.0, rateLabel: '1280', framePayloadBytes: 320, tocByte: 0x0b, description: 'Primary 128.0 kbps' }
      ],
      defaultModeIndex: 1, // 13.2 kbps
      supportsDtx: true,
      defaultDtx: false,
      fileExtension: 'evs',
      filenameTemplate: '{base}.EVS{band}r{rate}{dtx}',
      fileMagic: new Uint8Array([0x23, 0x21, 0x45, 0x56, 0x53, 0x5f, 0x4d, 0x43, 0x31, 0x2e, 0x30, 0x0a]), // #!EVS_MC1.0\n
      channelCountHeader: true,
      docUrl: 'https://www.3gpp.org/ftp/Specs/archive/26_series/26.445/',
      docTitle: '3GPP TS 26.445',
      description: '3GPP TS 26.445: Enhanced Voice Services (EVS) Super-Wideband (32 kHz) operating from 9.6 to 128 kbps for 5G/VoNR.'
    });

    // 8. G.729 / G.729A
    this.register({
      id: 'g729',
      name: 'G.729 / G.729A CS-ACELP',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 10,
      modes: [
        { modeId: '8k', bitrateKbps: 8, rateLabel: '8', framePayloadBytes: 10, description: '8 kbps (10 bytes per 10 ms frame)' }
      ],
      defaultModeIndex: 0,
      supportsDtx: true,
      defaultDtx: false,
      fileExtension: '729',
      filenameTemplate: '{base}.729',
      docUrl: 'https://www.itu.int/rec/T-REC-G.729',
      docTitle: 'ITU-T G.729',
      description: 'ITU-T G.729: Coding of speech at 8 kbps using CS-ACELP (10 ms frames, 8 kHz). High-efficiency bandwidth-saving toll codec.'
    });

    // 9. iLBC (RFC 3951 Internet Low Bitrate Codec)
    this.register({
      id: 'ilbc',
      name: 'iLBC (Internet Low Bitrate Codec)',
      sampleRate: 8000,
      bandwidth: 'NB',
      frameDurationMs: 20,
      modes: [
        { modeId: '20ms', bitrateKbps: 15.2, rateLabel: '152', framePayloadBytes: 38, description: '20 ms frame (15.2 kbps, 38 bytes)' },
        { modeId: '30ms', bitrateKbps: 13.33, rateLabel: '133', framePayloadBytes: 50, description: '30 ms frame (13.33 kbps, 50 bytes)' }
      ],
      defaultModeIndex: 0,
      supportsDtx: false,
      defaultDtx: false,
      fileExtension: 'ilbc',
      filenameTemplate: '{base}.ilbc',
      docUrl: 'https://www.rfc-editor.org/rfc/rfc3951',
      docTitle: 'IETF RFC 3951',
      description: 'IETF RFC 3951: Internet Low Bitrate Codec for robust speech communication over IP with packet loss resilience.'
    });

    // 10. Opus (RFC 6716)
    this.register({
      id: 'opus',
      name: 'Opus Audio Codec',
      sampleRate: 48000,
      bandwidth: 'FB',
      frameDurationMs: 20,
      modes: [
        { modeId: '16k',  bitrateKbps: 16,  rateLabel: '16',  framePayloadBytes: 40,  description: '16 kbps (Voice Narrowband)' },
        { modeId: '24k',  bitrateKbps: 24,  rateLabel: '24',  framePayloadBytes: 60,  description: '24 kbps (Voice Wideband)' },
        { modeId: '32k',  bitrateKbps: 32,  rateLabel: '32',  framePayloadBytes: 80,  description: '32 kbps (Standard VoIP)' },
        { modeId: '64k',  bitrateKbps: 64,  rateLabel: '64',  framePayloadBytes: 160, description: '64 kbps (High Fidelity)' },
        { modeId: '128k', bitrateKbps: 128, rateLabel: '128', framePayloadBytes: 320, description: '128 kbps (Music / Fullband)' }
      ],
      defaultModeIndex: 2, // 32 kbps
      supportsDtx: true,
      defaultDtx: false,
      fileExtension: 'opus',
      filenameTemplate: '{base}.opus',
      docUrl: 'https://www.rfc-editor.org/rfc/rfc6716',
      docTitle: 'IETF RFC 6716',
      description: 'IETF RFC 6716: Interactive audio codec combining Skype SILK and Xiph CELT from 6 to 510 kbps.'
    });
  }

  public static register(profile: CodecProfile): void {
    this.profiles.set(profile.id, profile);
  }

  public static get(id: string): CodecProfile | undefined {
    if (id === 'evs-wb') return this.profiles.get('evs');
    return this.profiles.get(id);
  }

  public static getAll(): CodecProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Generates formatted filename according to template.
   */
  public static formatFilename(
    template: string,
    params: {
      base: string;
      codecId: string;
      band?: string;
      rateLabel?: string;
      dtx?: boolean;
      ext?: string;
    }
  ): string {
    const profile = this.get(params.codecId);
    const tmpl = template || (profile ? profile.filenameTemplate : '{base}.bin');

    const baseName = params.base.replace(/\.[^/.]+$/, '');
    const bandStr = params.band || (profile ? profile.bandwidth : 'WB');
    const rateStr = params.rateLabel || (profile ? profile.modes[profile.defaultModeIndex].rateLabel : '');
    const dtxStr = params.dtx ? 'dtx' : '';
    const extStr = params.ext || (profile ? profile.fileExtension : 'bin');

    let out = tmpl
      .replace('{base}', baseName)
      .replace('{CODEC}', (profile ? profile.name.split(' ')[0] : params.codecId).toUpperCase())
      .replace('{band}', bandStr)
      .replace('{rate}', rateStr)
      .replace('{dtx}', dtxStr)
      .replace('{ext}', extStr);

    // Clean up any double dots if template omitted elements
    out = out.replace(/\.{2,}/g, '.');
    return out;
  }
}
