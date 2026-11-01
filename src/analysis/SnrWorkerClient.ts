/**
 * SnrWorkerClient.ts
 * Manages off-main-thread SNR worker communication, request ID sequencing,
 * and seamless fallback when Worker is unavailable.
 */

import { SnrEngine, type SnrOptions, type SnrResult } from './SnrEngine.ts';
import type { SnrWorkerRequest, SnrWorkerResponse } from '../workers/snr.worker.ts';

export class SnrWorkerClient {
  private static worker: Worker | null = null;
  private static reqSeq = 0;
  private static pendingCallbacks = new Map<number, (res: SnrResult) => void>();

  private static getWorker(): Worker | null {
    if (this.worker) return this.worker;
    if (typeof Worker === 'undefined') return null;

    try {
      this.worker = new Worker(new URL('../workers/snr.worker.ts', import.meta.url), {
        type: 'module',
      });

      this.worker.onmessage = (e: MessageEvent<SnrWorkerResponse>) => {
        const { id, result } = e.data;
        const cb = this.pendingCallbacks.get(id);
        if (cb) {
          this.pendingCallbacks.delete(id);
          cb(result);
        }
      };

      this.worker.onerror = (err) => {
        console.error('[SnrWorkerClient] Worker error:', err);
      };

      return this.worker;
    } catch (err) {
      console.warn('[SnrWorkerClient] Could not instantiate Web Worker, using main thread fallback:', err);
      return null;
    }
  }

  /**
   * Dispatches SNR analysis to the Web Worker.
   */
  public static async analyze(
    pcm: Int16Array,
    sampleRate: number,
    options: SnrOptions
  ): Promise<SnrResult> {
    const worker = this.getWorker();

    if (!worker) {
      // Fallback: run on main thread
      return SnrEngine.analyze(pcm, sampleRate, options);
    }

    const id = ++this.reqSeq;

    return new Promise<SnrResult>((resolve) => {
      this.pendingCallbacks.set(id, resolve);

      const req: SnrWorkerRequest = {
        id,
        pcm,
        sampleRate,
        options,
      };

      worker.postMessage(req);
    });
  }
}
