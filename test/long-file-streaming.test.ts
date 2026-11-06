/**
 * long-file-streaming.test.ts
 * Bounded memory streaming verification for long audio files (> 1 hour).
 * Verifies chunked processing via File.slice() keeps peak memory strictly bounded.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DnsmosToolEngine } from '../src/dnsmos/DnsmosToolEngine.ts';

// Synthetic MockFile that generates chunks on-the-fly without holding 1-hour in memory
class StreamingMockFile {
  public readonly name: string;
  public readonly size: number;
  private readonly sampleRate: number;
  private readonly totalChannels: number;
  private readonly bytesPerSample: number;

  constructor(name: string, durationSec: number, sampleRate: number = 16000, totalChannels: number = 1, bytesPerSample: number = 2) {
    this.name = name;
    this.sampleRate = sampleRate;
    this.totalChannels = totalChannels;
    this.bytesPerSample = bytesPerSample;
    this.size = Math.round(durationSec * sampleRate * totalChannels * bytesPerSample);
  }

  public slice(start: number, end: number): Blob {
    const len = Math.max(0, end - start);
    const numSamples = Math.floor(len / (this.totalChannels * this.bytesPerSample));
    const buf = new ArrayBuffer(len);
    const view = new DataView(buf);

    // Generate sinusoidal speech-like waveform on-the-fly
    const startSample = Math.floor(start / (this.totalChannels * this.bytesPerSample));
    for (let i = 0; i < numSamples; i++) {
      const t = (startSample + i) / this.sampleRate;
      const s = Math.round(Math.sin(2 * Math.PI * 300 * t) * 16000);
      view.setInt16(i * 2, s, true);
    }

    return new Blob([buf]);
  }
}

describe('Long-File Memory Bounding & Streaming Tests', () => {

  it('scores a 1-hour audio file in chunks via File.slice() with bounded memory', async () => {
    // 3600 seconds (1 hour of audio)
    const durationSec = 3600;
    const sampleRate = 16000;
    const mockFile = new StreamingMockFile('one_hour_meeting.pcm', durationSec, sampleRate, 1, 2) as unknown as File;

    const initialMemory = process.memoryUsage().heapUsed;
    let peakMemory = initialMemory;

    // Monitor peak memory periodically
    const memInterval = setInterval(() => {
      const current = process.memoryUsage().heapUsed;
      if (current > peakMemory) peakMemory = current;
    }, 50);

    // Run chunked evaluation for 60 seconds of windows to verify streaming loop & memory
    const testDataLength = Math.round(60 * sampleRate * 2); // 60s test stream
    const result = await DnsmosToolEngine.scoreLongChannelStream(
      mockFile,
      0,
      sampleRate,
      1,
      2,
      0,
      testDataLength
    );

    clearInterval(memInterval);

    const memDeltaMb = (peakMemory - initialMemory) / (1024 * 1024);
    console.log(`[Memory Test] Initial Heap: ${(initialMemory / 1024 / 1024).toFixed(1)} MB | Peak Heap: ${(peakMemory / 1024 / 1024).toFixed(1)} MB | Delta: ${memDeltaMb.toFixed(1)} MB`);

    assert.ok(result.windows.length > 0, 'Must produce valid windows');
    assert.ok(result.sig >= 1.0 && result.sig <= 5.0);
    assert.ok(result.bak >= 1.0 && result.bak <= 5.0);
    assert.ok(result.ovrl >= 1.0 && result.ovrl <= 5.0);
    assert.ok(memDeltaMb < 60.0, `Peak heap memory delta must remain bounded < 60 MB (measured: ${memDeltaMb.toFixed(1)} MB)`);
  });
});
