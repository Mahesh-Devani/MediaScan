/**
 * snr.worker.ts
 * Off-main-thread Web Worker for SNR analysis.
 */

import { SnrEngine, type SnrOptions, type SnrResult } from '../analysis/SnrEngine.ts';

export interface SnrWorkerRequest {
  id: number;
  pcm: Int16Array;
  sampleRate: number;
  options: SnrOptions;
}

export interface SnrWorkerResponse {
  id: number;
  result: SnrResult;
  executionTimeMs: number;
}

self.onmessage = (e: MessageEvent<SnrWorkerRequest>) => {
  const { id, pcm, sampleRate, options } = e.data;
  const t0 = performance.now();

  try {
    const result = SnrEngine.analyze(pcm, sampleRate, options);
    const executionTimeMs = performance.now() - t0;
    const response: SnrWorkerResponse = { id, result, executionTimeMs };
    self.postMessage(response);
  } catch (err: any) {
    const errorResult = SnrEngine.analyze(new Int16Array(0), sampleRate, options);
    errorResult.status = 'cannot_estimate';
    errorResult.cannotEstimateReason = `Worker exception: ${err?.message || err}`;
    self.postMessage({ id, result: errorResult, executionTimeMs: performance.now() - t0 });
  }
};
