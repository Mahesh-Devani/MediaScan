/**
 * DnsmosEngine.ts
 * Core engine for Microsoft DNSMOS P.835 / P.808 speech quality evaluation.
 * Handles:
 * - Worker task dispatch & response handling
 * - Result caching per (streamId, ssrc, range, isPersonalized, includeP808)
 * - Input vs Output leg comparison and Noise Reduction diagnostics
 * - Batch evaluation queue with progress reporting and cancellation
 */

import type {
  DnsmosResult,
  DnsmosComparisonResult,
  DnsmosOptions,
  DnsmosWorkerTask,
  DnsmosWorkerResponse,
  DnsmosFileInfo,
} from './DnsmosTypes.ts';
import { AudioResampler } from './AudioResampler.ts';
import { processDnsmosTask } from '../workers/dnsmos.worker.ts';

export class DnsmosEngine {
  private static worker: Worker | null = null;
  private static activeCallbacks = new Map<string, { resolve: (res: DnsmosResult) => void; reject: (err: any) => void }>();
  private static resultCache = new Map<string, DnsmosResult>();

  private static isBatchRunning = false;
  private static batchAbortController: AbortController | null = null;

  /**
   * Evaluates DNSMOS scores for a PCM audio buffer.
   * Runs in Web Worker in browser environment; runs directly in Node.js test environment.
   */
  public static async evaluatePcm(
    pcm: Int16Array | Float32Array,
    sampleRate: number,
    meta: {
      streamId: string;
      ssrc: number;
      legId?: string;
      direction?: 'inbound' | 'outbound';
      codec: string;
      startSec?: number;
      endSec?: number;
      isFullStream?: boolean;
      fileInfo?: DnsmosFileInfo;
    },
    options: DnsmosOptions = {}
  ): Promise<DnsmosResult> {
    const isPersonalized = !!options.isPersonalized;
    const includeP808 = !!options.includeP808;
    const startSec = meta.startSec || 0;
    const endSec = meta.endSec || (pcm.length / sampleRate);
    const isFullStream = meta.isFullStream !== false;

    // 1. Check cache
    const cacheKey = meta.fileInfo
      ? `${meta.fileInfo.fileName}_ch${meta.fileInfo.channelIndex}_${startSec.toFixed(2)}_${endSec.toFixed(2)}_${isPersonalized}_${includeP808}`
      : `${meta.ssrc}_${startSec.toFixed(2)}_${endSec.toFixed(2)}_${isPersonalized}_${includeP808}`;
    if (this.resultCache.has(cacheKey)) {
      return this.resultCache.get(cacheKey)!;
    }

    // 2. Resample to 16 kHz Float32Array
    const audioPcm16k = AudioResampler.resampleTo16k(pcm, sampleRate);

    const task: DnsmosWorkerTask = {
      taskId: `task_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      audioPcm: audioPcm16k,
      sampleRate: 16000,
      originalSampleRate: sampleRate,
      streamId: meta.streamId,
      ssrc: meta.ssrc,
      legId: meta.legId,
      direction: meta.direction,
      codec: meta.codec,
      startSec,
      endSec,
      isFullStream,
      options,
      fileInfo: meta.fileInfo,
    };

    // 3. Execution: Browser Worker vs Node direct execution
    let result: DnsmosResult;
    const isBrowserWorkerAvailable = typeof Worker !== 'undefined' && typeof window !== 'undefined';

    if (isBrowserWorkerAvailable) {
      const appBaseUrl = new URL('./', window.location.href).href;
      task.options = {
        ...options,
        modelBaseUrl: options.modelBaseUrl || appBaseUrl,
        wasmBaseUrl: options.wasmBaseUrl || `${appBaseUrl}wasm/`,
      };
      result = await this.dispatchToWorker(task);
    } else {
      // Node.js direct execution (for unit & golden tests)
      // Provide relative model path for Node environment
      const nodeOptions: DnsmosOptions = {
        ...options,
        modelBaseUrl: options.modelBaseUrl || 'public/',
      };
      result = await processDnsmosTask({ ...task, options: nodeOptions });
    }

    // Store in cache
    this.resultCache.set(cacheKey, result);
    return result;
  }

  private static dispatchToWorker(task: DnsmosWorkerTask): Promise<DnsmosResult> {
    this.ensureWorker();

    return new Promise((resolve, reject) => {
      this.activeCallbacks.set(task.taskId, { resolve, reject });
      this.worker!.postMessage(task);
    });
  }

  private static ensureWorker(): void {
    if (this.worker) return;

    try {
      this.worker = new Worker(new URL('../workers/dnsmos.worker.ts', import.meta.url), {
        type: 'module',
      });

      this.worker.onmessage = (e: MessageEvent<DnsmosWorkerResponse>) => {
        const { taskId, success, result, error } = e.data;
        const cb = this.activeCallbacks.get(taskId);
        if (cb) {
          this.activeCallbacks.delete(taskId);
          if (success && result) {
            cb.resolve(result);
          } else {
            cb.reject(new Error(error || 'DNSMOS worker processing failed'));
          }
        }
      };

      this.worker.onerror = (err) => {
        console.error('[DnsmosEngine] Worker global error:', err);
      };
    } catch (err) {
      console.error('[DnsmosEngine] Failed to create DNSMOS worker:', err);
      throw err;
    }
  }

  /**
   * Compares an Inbound stream leg against an Outbound stream leg to assess Noise Reduction (NR) impact.
   */
  public static compareLegs(
    inputResult: DnsmosResult,
    outputResult: DnsmosResult
  ): DnsmosComparisonResult {
    const deltaSig = Number((outputResult.sig - inputResult.sig).toFixed(4));
    const deltaBak = Number((outputResult.bak - inputResult.bak).toFixed(4));
    const deltaOvrl = Number((outputResult.ovrl - inputResult.ovrl).toFixed(4));

    let verdict: DnsmosComparisonResult['verdict'];
    let diagnosticExplanation: string;

    if (deltaBak >= 0.2 && deltaSig <= -0.2) {
      verdict = 'bak_up_sig_down';
      diagnosticExplanation = 'Noise reduction suppressed background noise (+BAK) but noticeably degraded speech signal quality (-SIG). Possible over-suppression or musical noise artifact.';
    } else if (Math.abs(deltaBak) < 0.1 && Math.abs(deltaSig) < 0.1) {
      verdict = 'bak_flat';
      diagnosticExplanation = 'Noise reduction had minimal or no perceptible effect on background noise intrusion (BAK remains flat).';
    } else if (deltaSig <= -0.25 && deltaBak <= -0.25 && deltaOvrl <= -0.25) {
      verdict = 'all_down';
      diagnosticExplanation = 'All quality metrics degraded across output leg. Likely caused by tandem transcoding, packet loss, or digital clipping on the media server.';
    } else if (deltaBak >= 0.2 && deltaSig >= -0.1) {
      verdict = 'effective_nr';
      diagnosticExplanation = 'Highly effective noise reduction: background noise significantly reduced (+BAK) while preserving natural speech clarity.';
    } else {
      verdict = 'neutral';
      diagnosticExplanation = 'Speech and noise quality metrics remain stable between input and output legs.';
    }

    return {
      inputResult,
      outputResult,
      deltaSig,
      deltaBak,
      deltaOvrl,
      verdict,
      diagnosticExplanation,
    };
  }

  /**
   * Enqueues batch scoring across multiple streams with progress and abort support.
   */
  public static async runBatch(
    items: Array<{ pcm: Int16Array | Float32Array; sampleRate: number; meta: any }>,
    options: DnsmosOptions,
    onProgress: (completed: number, total: number, latest?: DnsmosResult) => void
  ): Promise<DnsmosResult[]> {
    this.isBatchRunning = true;
    this.batchAbortController = new AbortController();
    const results: DnsmosResult[] = [];
    const total = items.length;

    for (let i = 0; i < total; i++) {
      if (this.batchAbortController.signal.aborted) {
        break;
      }
      const item = items[i];
      try {
        const res = await this.evaluatePcm(item.pcm, item.sampleRate, item.meta, options);
        results.push(res);
        onProgress(i + 1, total, res);
      } catch (err) {
        console.warn(`[DnsmosEngine] Error processing stream SSRC ${item.meta.ssrc}:`, err);
        onProgress(i + 1, total, undefined);
      }
    }

    this.isBatchRunning = false;
    this.batchAbortController = null;
    return results;
  }

  public static cancelBatch(): void {
    if (this.batchAbortController) {
      this.batchAbortController.abort();
    }
    this.isBatchRunning = false;
  }

  public static isBatchActive(): boolean {
    return this.isBatchRunning;
  }

  public static clearCache(): void {
    this.resultCache.clear();
  }
}
