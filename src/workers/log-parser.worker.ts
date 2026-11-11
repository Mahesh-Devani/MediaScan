/**
 * log-parser.worker.ts
 * Background Web Worker to scan and parse telecommunication product logs and NSS key logs.
 */

import { LogKeyParser, type ExtractedLogKey, type RegexPatternDef } from '../srtp/LogKeyParser.ts';

export interface LogParserWorkerRequest {
  id: number;
  text: string;
  customPatterns?: Array<{
    name: string;
    description?: string;
    pattern: string;
    flags?: string;
  }>;
}

export interface LogParserWorkerResponse {
  id: number;
  keys: ExtractedLogKey[];
  error?: string;
  executionTimeMs: number;
}

self.onmessage = (e: MessageEvent<LogParserWorkerRequest>) => {
  const { id, text, customPatterns } = e.data;
  const t0 = performance.now();

  try {
    let patterns: RegexPatternDef[] | undefined;
    if (customPatterns && customPatterns.length > 0) {
      patterns = customPatterns.map(cp => ({
        name: cp.name,
        description: cp.description || cp.name,
        regex: new RegExp(cp.pattern, cp.flags || 'gi'),
        extract: (m: RegExpExecArray) => {
          const b64 = m[1];
          if (!b64) return null;
          return LogKeyParser.PATTERNS[0].extract([`a=crypto:1 AES_CM_128_HMAC_SHA1_80 inline:${b64}`] as any);
        },
      }));
    }

    const keys = LogKeyParser.parseLogText(text, patterns);
    const executionTimeMs = performance.now() - t0;
    self.postMessage({ id, keys, executionTimeMs });
  } catch (err: any) {
    self.postMessage({
      id,
      keys: [],
      error: err?.message || String(err),
      executionTimeMs: performance.now() - t0,
    });
  }
};
