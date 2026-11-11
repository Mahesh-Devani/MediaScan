import * as fs from 'node:fs';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import type { BaselineSnapshot } from './generate-baseline-snapshot.ts';

const baselineRaw = fs.readFileSync(path.resolve('test/fixtures/baseline/baseline-snapshot.json'), 'utf-8');
const baseline: BaselineSnapshot = JSON.parse(baselineRaw);

const files = [
  { name: 'mrfp-o.pcap', path: path.resolve('test/fixtures/mrfp-o/mrfp-o.pcap') },
  { name: 'mrfp-1.pcap', path: path.resolve('test/fixtures/mrfp-1/mrfp-1.pcap') }
];

console.log('=== Performance Benchmark: Plain Capture Parse + Stream List ===');

for (const { name, path: pcapPath } of files) {
  const fileBuffer = fs.readFileSync(pcapPath);
  const pcapBytes = new Uint8Array(fileBuffer.buffer, fileBuffer.byteOffset, fileBuffer.byteLength);

  // Warmup run
  CapturePipeline.process(pcapBytes);

  // 10 timed runs
  const iterations = 10;
  const times: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    CapturePipeline.process(pcapBytes);
    times.push(performance.now() - t0);
  }

  const avgTime = times.reduce((a, b) => a + b, 0) / iterations;
  const baselineTime = baseline.pcaps[name]?.parseTimeMs ?? 0;
  const diffPercent = ((avgTime - baselineTime) / baselineTime) * 100;

  console.log(`\nFile: ${name} (${(fileBuffer.byteLength / (1024 * 1024)).toFixed(2)} MB)`);
  console.log(`  Baseline Parse Time: ${baselineTime.toFixed(2)} ms`);
  console.log(`  Current Avg Parse Time: ${avgTime.toFixed(2)} ms (${iterations} runs)`);
  console.log(`  Difference: ${diffPercent > 0 ? '+' : ''}${diffPercent.toFixed(2)}%`);
}
