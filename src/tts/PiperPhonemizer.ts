/**
 * PiperPhonemizer.ts
 * 100% offline client-side G2P (Grapheme-to-Phoneme) tokenizer using eSpeak-ng WebAssembly.
 * Converts multilingual text into Piper-compatible IPA phoneme IDs.
 */

// @ts-ignore
import { createPiperPhonemize } from './piper_phonemize.esm.js';

export interface PhonemizeResult {
  phonemeIds: number[];
  phonemes: string[];
  processedText: string;
}

export class PiperPhonemizer {
  private static instancePromise: Promise<any> | null = null;
  private static currentCallback: ((data: string) => void) | null = null;

  /**
   * Resolves language / voice code to eSpeak voice identifier.
   */
  public static resolveEspeakVoice(language: string, voiceCode?: string): string {
    if (voiceCode) return voiceCode;
    const lang = language.toLowerCase().replace('_', '-');
    if (lang.startsWith('en-us') || lang === 'en') return 'en-us';
    if (lang.startsWith('en-in') || lang.startsWith('en-gb')) return 'en-gb-x-rp';
    if (lang.startsWith('es')) return 'es';
    if (lang.startsWith('tr')) return 'tr';
    if (lang.startsWith('fr')) return 'fr';
    if (lang.startsWith('de')) return 'de';
    if (lang.startsWith('ar')) return 'ar';
    if (lang.startsWith('pl')) return 'pl';
    return 'en-us';
  }

  private static async getModule(wasmBaseUrl: string = 'wasm/'): Promise<any> {
    if (!this.instancePromise) {
      const isNode = typeof process !== 'undefined' && process.versions?.node;
      if (isNode && typeof (globalThis as any).require === 'undefined') {
        try {
          const mod = await import(/* @vite-ignore */ 'module');
          (globalThis as any).require = mod.createRequire(import.meta.url);
        } catch (e) {}
      }
      this.instancePromise = createPiperPhonemize({
        locateFile: (url: string) => {
          if (isNode) {
            if (url.endsWith('.wasm')) return './public/wasm/piper_phonemize.wasm';
            if (url.endsWith('.data')) return './public/wasm/piper_phonemize.data';
            return './public/wasm/' + url;
          }
          const base = wasmBaseUrl.endsWith('/') ? wasmBaseUrl : wasmBaseUrl + '/';
          if (url.endsWith('.wasm')) return base + 'piper_phonemize.wasm';
          if (url.endsWith('.data')) return base + 'piper_phonemize.data';
          return base + url;
        },
        print: (data: string) => {
          if (PiperPhonemizer.currentCallback) {
            PiperPhonemizer.currentCallback(data);
          }
        },
        printErr: (err: any) => {
          console.warn('[PiperPhonemize warn]', err);
        },
      });
    }
    return this.instancePromise;
  }

  /**
   * Phonemizes text using piper_phonemize WebAssembly.
   */
  public static async phonemize(
    text: string,
    espeakVoice: string,
    wasmBaseUrl: string = 'wasm/'
  ): Promise<PhonemizeResult> {
    const mod = await this.getModule(wasmBaseUrl);

    return new Promise<PhonemizeResult>((resolve, reject) => {
      PiperPhonemizer.currentCallback = (data: string) => {
        try {
          const parsed = JSON.parse(data);
          resolve({
            phonemeIds: parsed.phoneme_ids || [],
            phonemes: parsed.phonemes || [],
            processedText: parsed.processed_text || text,
          });
        } catch (err) {
          reject(err);
        }
      };

      try {
        const inputJson = JSON.stringify([{ text: text.trim() }]);
        mod.callMain([
          '-l',
          espeakVoice,
          '--input',
          inputJson,
          '--espeak_data',
          '/espeak-ng-data',
        ]);
      } catch (err) {
        reject(err);
      }
    });
  }
}
