/**
 * CodecConfigTable.ts
 * ITU-T G.113 Appendix I Equipment Impairment (Ie) and Packet Loss Robustness (Bpl) parameters.
 * Supports standard values and documented approximations, editable in UI and persistent in localStorage.
 */

import type { CodecModelParams } from './MosTypes.ts';

export const DEFAULT_CODEC_PARAMS: CodecModelParams[] = [
  {
    id: 'g711u',
    name: 'G.711 u-law (PCMU)',
    sampleRate: 8000,
    ie: 0,
    bplWithPlc: 25.1,
    bplWithoutPlc: 4.3,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I baseline',
  },
  {
    id: 'g711a',
    name: 'G.711 a-law (PCMA)',
    sampleRate: 8000,
    ie: 0,
    bplWithPlc: 25.1,
    bplWithoutPlc: 4.3,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I baseline',
  },
  {
    id: 'g722',
    name: 'G.722 (64 kbps)',
    sampleRate: 16000,
    ie: 13,
    bplWithPlc: 19.0,
    bplWithoutPlc: 5.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I / Wideband E-model',
  },
  {
    id: 'g729',
    name: 'G.729 / G.729A (8 kbps)',
    sampleRate: 8000,
    ie: 10,
    bplWithPlc: 19.0,
    bplWithoutPlc: 4.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I (CS-ACELP)',
  },
  {
    id: 'amr_nb_122',
    name: 'AMR-NB (12.2 kbps)',
    sampleRate: 8000,
    ie: 5,
    bplWithPlc: 13.0,
    bplWithoutPlc: 4.5,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I (Mode 7)',
  },
  {
    id: 'amr_nb_74',
    name: 'AMR-NB (7.4 kbps)',
    sampleRate: 8000,
    ie: 10,
    bplWithPlc: 14.0,
    bplWithoutPlc: 4.5,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I (Mode 4)',
  },
  {
    id: 'amr_nb',
    name: 'AMR-NB (General)',
    sampleRate: 8000,
    ie: 7,
    bplWithPlc: 14.0,
    bplWithoutPlc: 4.5,
    isStandard: true,
    notes: '3GPP TS 26.101 typical operating mode',
  },
  {
    id: 'amr_wb_1265',
    name: 'AMR-WB (12.65 kbps)',
    sampleRate: 16000,
    ie: 6,
    bplWithPlc: 16.0,
    bplWithoutPlc: 5.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I / 3GPP TS 26.201 Mode 2',
  },
  {
    id: 'amr_wb_2385',
    name: 'AMR-WB (23.85 kbps)',
    sampleRate: 16000,
    ie: 3,
    bplWithPlc: 18.0,
    bplWithoutPlc: 5.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I / 3GPP TS 26.201 Mode 8',
  },
  {
    id: 'amr_wb',
    name: 'AMR-WB (General)',
    sampleRate: 16000,
    ie: 5,
    bplWithPlc: 16.0,
    bplWithoutPlc: 5.0,
    isStandard: true,
    notes: '3GPP TS 26.201 wideband baseline',
  },
  {
    id: 'evs_nb',
    name: 'EVS (Narrowband 8kHz)',
    sampleRate: 8000,
    ie: 4,
    bplWithPlc: 18.0,
    bplWithoutPlc: 5.5,
    isStandard: false,
    notes: 'Approximate based on 3GPP TS 26.445 characterization tests',
  },
  {
    id: 'evs_wb',
    name: 'EVS (Wideband 16kHz)',
    sampleRate: 16000,
    ie: 2,
    bplWithPlc: 22.0,
    bplWithoutPlc: 6.0,
    isStandard: false,
    notes: 'Approximate based on 3GPP TS 26.445 characterization tests',
  },
  {
    id: 'evs_swb',
    name: 'EVS (Super-Wideband 32kHz)',
    sampleRate: 32000,
    ie: 0,
    bplWithPlc: 25.0,
    bplWithoutPlc: 7.0,
    isStandard: false,
    notes: 'Approximate based on 3GPP TS 26.445 characterization tests',
  },
  {
    id: 'opus',
    name: 'Opus (Voice)',
    sampleRate: 48000,
    ie: 5,
    bplWithPlc: 24.0,
    bplWithoutPlc: 6.0,
    isStandard: false,
    notes: 'Approximate based on IETF RFC 6716 in-band FEC & SILK PLC',
  },
  {
    id: 'ilbc_20',
    name: 'iLBC (20 ms / 15.2 kbps)',
    sampleRate: 8000,
    ie: 10,
    bplWithPlc: 30.0,
    bplWithoutPlc: 7.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I / RFC 3951',
  },
  {
    id: 'ilbc_30',
    name: 'iLBC (30 ms / 13.3 kbps)',
    sampleRate: 8000,
    ie: 11,
    bplWithPlc: 32.0,
    bplWithoutPlc: 7.0,
    isStandard: true,
    notes: 'ITU-T G.113 Appendix I / RFC 3951',
  },
  {
    id: 'speex_nb',
    name: 'Speex (Narrowband 8kHz)',
    sampleRate: 8000,
    ie: 18,
    bplWithPlc: 15.0,
    bplWithoutPlc: 5.0,
    isStandard: false,
    notes: 'Approximate based on open-source Speex characterization',
  },
  {
    id: 'speex_wb',
    name: 'Speex (Wideband 16kHz)',
    sampleRate: 16000,
    ie: 11,
    bplWithPlc: 19.0,
    bplWithoutPlc: 6.0,
    isStandard: false,
    notes: 'Approximate based on open-source Speex characterization',
  },
];

const STORAGE_KEY = 'mediascan_codec_e_model_params';

export class CodecConfigTable {
  private static cachedParams: CodecModelParams[] | null = null;

  public static getAll(): CodecModelParams[] {
    if (this.cachedParams) return this.cachedParams;

    if (typeof localStorage !== 'undefined') {
      try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
          const parsed = JSON.parse(stored);
          if (Array.isArray(parsed) && parsed.length > 0) {
            this.cachedParams = parsed;
            return this.cachedParams;
          }
        }
      } catch (err) {
        console.warn('[CodecConfigTable] Failed to read from localStorage:', err);
      }
    }

    this.cachedParams = DEFAULT_CODEC_PARAMS.map(p => ({ ...p }));
    return this.cachedParams;
  }

  public static saveAll(params: CodecModelParams[]): void {
    this.cachedParams = params.map(p => ({ ...p }));
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.cachedParams));
      } catch (err) {
        console.warn('[CodecConfigTable] Failed to save to localStorage:', err);
      }
    }
  }

  public static resetToDefaults(): CodecModelParams[] {
    this.cachedParams = DEFAULT_CODEC_PARAMS.map(p => ({ ...p }));
    if (typeof localStorage !== 'undefined') {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        // ignore
      }
    }
    return this.cachedParams;
  }

  /**
   * Resolves codec model parameters by fuzzy matching codec name string and clock rate.
   */
  public static resolveCodecParams(codecName: string, clockRate: number = 8000): CodecModelParams {
    const list = this.getAll();
    const norm = (codecName || '').toUpperCase().trim();

    // 1. Exact match by ID or Name
    let match = list.find(p => p.name.toUpperCase().includes(norm) || p.id.toUpperCase() === norm);

    if (!match) {
      if (norm.includes('PCMU') || norm === 'ULAW') {
        match = list.find(p => p.id === 'g711u');
      } else if (norm.includes('PCMA') || norm === 'ALAW') {
        match = list.find(p => p.id === 'g711a');
      } else if (norm.includes('722')) {
        match = list.find(p => p.id === 'g722');
      } else if (norm.includes('729')) {
        match = list.find(p => p.id === 'g729');
      } else if (norm.includes('AMR-WB') || (norm.includes('AMR') && clockRate === 16000)) {
        match = list.find(p => p.id === 'amr_wb');
      } else if (norm.includes('AMR')) {
        match = list.find(p => p.id === 'amr_nb');
      } else if (norm.includes('EVS')) {
        if (clockRate >= 32000 || norm.includes('SWB')) {
          match = list.find(p => p.id === 'evs_swb');
        } else if (clockRate >= 16000 || norm.includes('WB')) {
          match = list.find(p => p.id === 'evs_wb');
        } else {
          match = list.find(p => p.id === 'evs_nb');
        }
      } else if (norm.includes('OPUS')) {
        match = list.find(p => p.id === 'opus');
      } else if (norm.includes('ILBC')) {
        match = list.find(p => p.id === 'ilbc_20');
      } else if (norm.includes('SPEEX')) {
        match = clockRate >= 16000 ? list.find(p => p.id === 'speex_wb') : list.find(p => p.id === 'speex_nb');
      }
    }

    if (!match) {
      // Fallback default: G.711u
      match = list.find(p => p.id === 'g711u') || DEFAULT_CODEC_PARAMS[0];
    }

    return match;
  }
}
