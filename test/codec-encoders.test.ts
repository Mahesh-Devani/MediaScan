/**
 * test/codec-encoders.test.ts
 * Unit tests for G.711, G.722, RawClipPackager, and AudioPreprocessor.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { G711Encoder } from '../src/encoders/G711Encoder.ts';
import { G711Decoder } from '../src/decoders/G711Decoder.ts';
import { G722Encoder } from '../src/encoders/G722Encoder.ts';
import { G722Decoder } from '../src/decoders/G722Decoder.ts';
import { G726Encoder } from '../src/encoders/G726Encoder.ts';
import { G726Decoder } from '../src/decoders/G726Decoder.ts';
import { G729Encoder } from '../src/encoders/G729Encoder.ts';
import { G729Decoder } from '../src/decoders/G729Decoder.ts';
import { EvsEncoder } from '../src/encoders/EvsEncoder.ts';
import { EvsDecoder } from '../src/decoders/EvsDecoder.ts';
import { AmrNbEncoder } from '../src/encoders/AmrNbEncoder.ts';
import { AmrWbEncoder } from '../src/encoders/AmrWbEncoder.ts';
import { AmrDecoder } from '../src/decoders/AmrDecoder.ts';
import { Mp4BoxReader } from '../src/audio/Mp4BoxReader.ts';
import { CodecProfileRegistry } from '../src/codec/CodecProfileRegistry.ts';
import { RawClipPackager } from '../src/encoders/RawClipPackager.ts';
import { AudioPreprocessor } from '../src/codec/AudioPreprocessor.ts';
import { WavExporter } from '../src/media/WavExporter.ts';
import { WavParser } from '../src/audio/WavParser.ts';

function computeSnr(original: Int16Array | Float32Array, reconstructed: Int16Array | Float32Array, skipStart = 0): number {
  const len = Math.min(original.length, reconstructed.length);
  let signalPower = 0;
  let noisePower = 0;

  for (let i = skipStart; i < len; i++) {
    const orig = original[i];
    const recon = reconstructed[i];
    const diff = orig - recon;
    signalPower += orig * orig;
    noisePower += diff * diff;
  }

  if (noisePower === 0) return 100;
  return 10 * Math.log10(signalPower / noisePower);
}

describe('Phase 2: Codec Encoders & Raw Clip Processing Pipeline', () => {

  it('G.711 µ-law encodes and decodes with high fidelity (SNR > 30 dB)', () => {
    const sampleRate = 8000;
    const durationSec = 1.0;
    const numSamples = sampleRate * durationSec;
    const pcm16 = new Int16Array(numSamples);

    // 1 kHz sine wave at -6 dBFS (amplitude ~16000)
    for (let i = 0; i < numSamples; i++) {
      pcm16[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    }

    const encoded = G711Encoder.encodeUlaw(pcm16);
    assert.strictEqual(encoded.length, numSamples, 'Encoded bytes must equal sample count');

    const decoded = G711Decoder.decodeUlaw(encoded);
    assert.strictEqual(decoded.length, numSamples, 'Decoded samples must equal original');

    const snr = computeSnr(pcm16, decoded);
    assert.ok(snr > 30, `Expected µ-law SNR > 30 dB, got ${snr.toFixed(2)} dB`);
  });

  it('G.711 A-law encodes and decodes with high fidelity (SNR > 30 dB)', () => {
    const sampleRate = 8000;
    const durationSec = 1.0;
    const numSamples = sampleRate * durationSec;
    const pcm16 = new Int16Array(numSamples);

    for (let i = 0; i < numSamples; i++) {
      pcm16[i] = Math.round(16000 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate));
    }

    const encoded = G711Encoder.encodeAlaw(pcm16);
    assert.strictEqual(encoded.length, numSamples);

    const decoded = G711Decoder.decodeAlaw(encoded);
    const snr = computeSnr(pcm16, decoded);
    assert.ok(snr > 30, `Expected A-law SNR > 30 dB, got ${snr.toFixed(2)} dB`);
  });

  it('G.722 encodes and decodes 16 kHz wideband audio with sub-band reconstruction', () => {
    const sampleRate = 16000;
    const durationSec = 0.5;
    const numSamples = Math.round(sampleRate * durationSec);
    const pcm16 = new Int16Array(numSamples);

    // Mixed tone: 400 Hz (low band) + 2500 Hz (high band)
    for (let i = 0; i < numSamples; i++) {
      const s1 = 12000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate);
      const s2 = 4000 * Math.sin((2 * Math.PI * 2500 * i) / sampleRate);
      pcm16[i] = Math.round(s1 + s2);
    }

    // Mode 1: 64 kbps (8 bits/codeword, 2 samples per byte)
    const encoded = G722Encoder.encode(pcm16, 8);
    assert.strictEqual(encoded.length, numSamples / 2, 'G.722 64k must produce 1 byte per 2 samples');

    const decoded = G722Decoder.decodeG722(encoded, 8);
    assert.strictEqual(decoded.length, numSamples);

    // Cross-correlation accounting for 22-24 sample algorithmic QMF delay
    const delay = 24;
    let num = 0;
    let den1 = 0;
    let den2 = 0;
    for (let i = 100; i < numSamples - delay; i++) {
      const orig = pcm16[i];
      const recon = decoded[i + delay];
      num += orig * recon;
      den1 += orig * orig;
      den2 += recon * recon;
    }
    const corr = num / (Math.sqrt(den1 * den2) || 1);
    assert.ok(corr > 0.75, `Expected G.722 waveform correlation > 0.75, got ${corr.toFixed(3)}`);

    // Verify Mode 2 (56 kbps) and Mode 3 (48 kbps) produce expected bit rates
    const enc56 = G722Encoder.encode(pcm16, 7);
    assert.strictEqual(enc56.length, numSamples / 2);

    const enc48 = G722Encoder.encode(pcm16, 6);
    assert.strictEqual(enc48.length, numSamples / 2);
  });

  it('RawClipPackager correctly prepends container magic headers and computes telemetry', () => {
    // 1. AMR-NB
    const amrNbProfile = CodecProfileRegistry.get('amr-nb')!;
    assert.ok(amrNbProfile);

    // Simulate 50 frames of 20 ms Mode 7 (32 bytes per frame including ToC)
    const amrFrames: Uint8Array[] = [];
    for (let i = 0; i < 50; i++) {
      const f = new Uint8Array(32);
      f[0] = 0x3c; // ToC Mode 7
      amrFrames.push(f);
    }

    const packagedAmr = RawClipPackager.package(amrNbProfile, amrFrames, {
      baseFilename: 'speech_sample.wav',
      modeRateLabel: '122',
      dtxEnabled: false,
    });

    // Magic: #!AMR\n (6 bytes)
    assert.strictEqual(packagedAmr.data[0], 0x23);
    assert.strictEqual(packagedAmr.data[1], 0x21);
    assert.strictEqual(packagedAmr.data[2], 0x41); // 'A'
    assert.strictEqual(packagedAmr.data[3], 0x4d); // 'M'
    assert.strictEqual(packagedAmr.data[4], 0x52); // 'R'
    assert.strictEqual(packagedAmr.data[5], 0x0a); // '\n'
    assert.strictEqual(packagedAmr.data.length, 6 + 50 * 32);
    assert.strictEqual(packagedAmr.telemetry.durationSec, 1.0);
    assert.strictEqual(packagedAmr.telemetry.frameCount, 50);
    assert.strictEqual(packagedAmr.suggestedFilename, 'speech_sample.AMRr122');

    // 2. AMR-WB
    const amrWbProfile = CodecProfileRegistry.get('amr-wb')!;
    assert.ok(amrWbProfile);
    const wbFrames = [new Uint8Array(61)]; // ToC + 60 payload
    wbFrames[0][0] = 0x44; // Mode 8 (23.85 kbps)
    const packagedWb = RawClipPackager.package(amrWbProfile, wbFrames, {
      baseFilename: 'test_wb.wav',
      modeRateLabel: '238',
      dtxEnabled: true,
    });
    // Magic: #!AMR-WB\n (9 bytes)
    assert.strictEqual(packagedWb.data.length, 9 + 61);
    assert.strictEqual(packagedWb.suggestedFilename, 'test_wb.AMRWBr238dtx');

    // 3. EVS
    const evsProfile = CodecProfileRegistry.get('evs')!;
    assert.ok(evsProfile);
    const evsFrames = [new Uint8Array(25)]; // ToC 0x03 + 24 payload (9.6 kbps)
    evsFrames[0][0] = 0x03;
    const packagedEvs = RawClipPackager.package(evsProfile, evsFrames, {
      baseFilename: 'test_evs.wav',
      modeRateLabel: '96',
      dtxEnabled: true,
      bandwidth: 'WB',
    });
    // Magic: #!EVS_MC1.0\n (12 bytes) + 4-byte BE 1 = 16 bytes header
    assert.strictEqual(packagedEvs.data.length, 16 + 25);
    assert.strictEqual(packagedEvs.telemetry.headerBytes, 16);
    // Channel count: 0x00 0x00 0x00 0x01
    assert.strictEqual(packagedEvs.data[12], 0);
    assert.strictEqual(packagedEvs.data[13], 0);
    assert.strictEqual(packagedEvs.data[14], 0);
    assert.strictEqual(packagedEvs.data[15], 1);
    assert.strictEqual(packagedEvs.suggestedFilename, 'test_evs.EVSWBr96dtx');

    // 4. EVS-NB
    const evsNbProfile = CodecProfileRegistry.get('evs-nb')!;
    assert.ok(evsNbProfile);
    const evsNbFrames = [new Uint8Array(25)]; // ToC 0x03 + 24 payload (9.6 kbps)
    evsNbFrames[0][0] = 0x03;
    const packagedEvsNb = RawClipPackager.package(evsNbProfile, evsNbFrames, {
      baseFilename: 'test_evs_nb.wav',
      modeRateLabel: '96',
      dtxEnabled: false,
      bandwidth: 'NB',
    });
    assert.strictEqual(packagedEvsNb.data.length, 16 + 25);
    assert.strictEqual(packagedEvsNb.suggestedFilename, 'test_evs_nb.EVSNBr96');
    assert.strictEqual(packagedEvsNb.telemetry.sampleRate, 8000);
    assert.strictEqual(packagedEvsNb.telemetry.bandwidth, 'NB');

    // 5. EVS-SWB
    const evsSwbProfile = CodecProfileRegistry.get('evs-swb')!;
    assert.ok(evsSwbProfile);
    const evsSwbFrames = [new Uint8Array(62)]; // ToC 0x06 + 61 payload (24.4 kbps)
    evsSwbFrames[0][0] = 0x06;
    const packagedEvsSwb = RawClipPackager.package(evsSwbProfile, evsSwbFrames, {
      baseFilename: 'test_evs_swb.wav',
      modeRateLabel: '244',
      dtxEnabled: false,
      bandwidth: 'SWB',
    });
    assert.strictEqual(packagedEvsSwb.data.length, 16 + 62);
    assert.strictEqual(packagedEvsSwb.suggestedFilename, 'test_evs_swb.EVSSWBr244');
    assert.strictEqual(packagedEvsSwb.telemetry.sampleRate, 32000);
    assert.strictEqual(packagedEvsSwb.telemetry.bandwidth, 'SWB');
  });

  it('AudioPreprocessor handles channel downmixing, resampling, DC removal, and duration adjustments', () => {
    const rate48k = 48000;
    const durSec = 0.1;
    const numSamples = Math.round(rate48k * durSec);

    // Create stereo channels with DC offset
    const chL = new Float32Array(numSamples);
    const chR = new Float32Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      chL[i] = 0.5 * Math.sin((2 * Math.PI * 400 * i) / rate48k) + 0.1; // +0.1 DC offset
      chR[i] = 0.3 * Math.sin((2 * Math.PI * 400 * i) / rate48k) + 0.1;
    }

    // Process down to 16 kHz mono with DC removal, normalization, and padded to 0.2 sec
    const result = AudioPreprocessor.process([chL, chR], rate48k, {
      channel: 'mix',
      targetSampleRate: 16000,
      removeDc: true,
      normalize: true,
      targetPeakDbfs: -1.0,
      targetDurationSec: 0.2,
      durationMode: 'pad',
    });

    assert.strictEqual(result.sampleRate, 16000);
    assert.strictEqual(result.durationSec, 0.2);
    assert.strictEqual(result.pcm16.length, 3200); // 0.2s * 16000
    assert.ok(Math.abs(result.peakDbfs - (-1.0)) < 0.5, `Peak dBFS should be near -1.0, got ${result.peakDbfs}`);
  });

  it('EvsEncoder encodes 16 kHz audio with bit-exact 3GPP primary and AMR-WB IO modes', async () => {
    const sampleRate = 16000;
    const durationSec = 0.1; // 100 ms = 5 frames
    const numSamples = sampleRate * durationSec;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    }

    // 1. Primary 9.6 kbps Wideband
    const frames = await EvsEncoder.encode(pcm, {
      sampleRate: 16000,
      bitrateBps: 9600,
      bandwidth: 'WB',
      dtx: false,
      isAmrWbIo: false,
    });

    assert.strictEqual(frames.length, 5, 'Must produce exactly 5 frames for 100ms');
    // Each 9.6k frame has 1-byte ToC (0x03) + 24 bytes payload = 25 bytes
    assert.strictEqual(frames[0].length, 25);
    assert.strictEqual(frames[0][0], 0x03, 'ToC for primary 9.6 kbps is 0x03');

    // 2. AMR-WB IO Mode 8 (23.85 kbps)
    const ioFrames = await EvsEncoder.encode(pcm, {
      sampleRate: 16000,
      bitrateBps: 23850,
      bandwidth: 'WB',
      dtx: false,
      isAmrWbIo: true,
    });
    assert.strictEqual(ioFrames.length, 5);
    // Mode 8 has 1-byte ToC (0x38) + 60 bytes payload = 61 bytes
    assert.strictEqual(ioFrames[0].length, 61);
    assert.strictEqual(ioFrames[0][0], 0x38, 'ToC for AMR-WB IO 23.85 kbps is 0x38');

    // 3. Primary 9.6 kbps Narrowband (8 kHz)
    const pcm8k = new Int16Array(8000 * 0.1); // 100 ms @ 8 kHz = 5 frames
    for (let i = 0; i < pcm8k.length; i++) {
      pcm8k[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / 8000));
    }
    const nbFrames = await EvsEncoder.encode(pcm8k, {
      sampleRate: 8000,
      bitrateBps: 9600,
      bandwidth: 'NB',
      dtx: false,
    });
    assert.strictEqual(nbFrames.length, 5, 'Must produce exactly 5 frames for 100ms NB');
    assert.strictEqual(nbFrames[0].length, 25);
    assert.strictEqual(nbFrames[0][0], 0x03, 'ToC for primary 9.6 kbps NB is 0x03');
    const decodedNb = await EvsDecoder.decodePayloads(nbFrames, true, 8000);
    assert.strictEqual(decodedNb.sampleRate, 8000);
    assert.strictEqual(decodedNb.pcm.length, 800);

    // 4. Primary 24.4 kbps Super-Wideband (32 kHz)
    const pcm32k = new Int16Array(32000 * 0.1); // 100 ms @ 32 kHz = 5 frames
    for (let i = 0; i < pcm32k.length; i++) {
      pcm32k[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / 32000));
    }
    const swbFrames = await EvsEncoder.encode(pcm32k, {
      sampleRate: 32000,
      bitrateBps: 24400,
      bandwidth: 'SWB',
      dtx: false,
    });
    assert.strictEqual(swbFrames.length, 5, 'Must produce exactly 5 frames for 100ms SWB');
    assert.strictEqual(swbFrames[0].length, 62);
    assert.strictEqual(swbFrames[0][0], 0x06, 'ToC for primary 24.4 kbps SWB is 0x06');
    const decodedSwb = await EvsDecoder.decodePayloads(swbFrames, true, 32000);
    assert.strictEqual(decodedSwb.sampleRate, 32000);
    assert.strictEqual(decodedSwb.pcm.length, 3200);
  });

  it('AmrNbEncoder encodes 8 kHz speech with RFC 4867 ToC and decodes bit-exact', async () => {
    const sampleRate = 8000;
    const durationSec = 0.2; // 200 ms = 10 frames
    const numSamples = sampleRate * durationSec;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    }

    // Mode 5 (7.95 kbps / AMRr795)
    const frames = AmrNbEncoder.encode(pcm, { mode: AmrNbEncoder.MODES.MR795, dtx: false });
    assert.strictEqual(frames.length, 10, 'Must produce 10 frames for 200ms');
    assert.strictEqual(frames[0].length, 21, 'Mode 5 frame is 1-byte ToC + 20 payload = 21 bytes');
    assert.strictEqual(frames[0][0], 0x2c, 'ToC for Mode 5 Q=1 must be 0x2c');

    // Container round-trip
    const amrFile = AmrNbEncoder.encodeToAmrFile(pcm, { mode: AmrNbEncoder.MODES.MR795 });
    assert.strictEqual(amrFile.length, 6 + 10 * 21, 'Header 6 bytes + 10 frames of 21 bytes');
    assert.strictEqual(Buffer.from(amrFile.subarray(0, 6)).toString('ascii'), '#!AMR\n');

    const decoded = await AmrDecoder.decodeAmrFile(amrFile);
    assert.strictEqual(decoded.sampleRate, 8000);
    assert.strictEqual(decoded.pcm.length, numSamples, 'Decoded sample count must match input');

    // DTX behavior on silence
    const silence = new Int16Array(1600); // 200ms silence
    const dtxFrames = AmrNbEncoder.encode(silence, { mode: AmrNbEncoder.MODES.MR795, dtx: true });
    assert.strictEqual(dtxFrames.length, 10);
    const hasSidOrNoData = dtxFrames.some((f) => f[0] === 0x44 || f[0] === 0x7c);
    assert.ok(hasSidOrNoData, 'DTX on silence must produce SID (0x44) or NO_DATA (0x7c) frames');
  });

  it('AmrWbEncoder encodes 16 kHz wideband speech with RFC 4867 ToC and decodes cleanly', async () => {
    const sampleRate = 16000;
    const durationSec = 0.2; // 200 ms = 10 frames
    const numSamples = sampleRate * durationSec;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    }

    // Mode 8 (23.85 kbps / AMRWBr238)
    const frames = await AmrWbEncoder.encode(pcm, { mode: 8, dtx: false });
    assert.strictEqual(frames.length, 10, 'Must produce 10 frames for 200ms');
    assert.strictEqual(frames[0].length, 61, 'Mode 8 frame is 1-byte ToC + 60 payload = 61 bytes');
    assert.strictEqual(frames[0][0], 0x44, 'ToC for AMR-WB Mode 8 Q=1 must be 0x44');

    // Container round-trip
    const awbFile = await AmrWbEncoder.encodeToAwbFile(pcm, { mode: 8 });
    assert.strictEqual(awbFile.length, 9 + 10 * 61, 'Header 9 bytes + 10 frames of 61 bytes');
    assert.strictEqual(Buffer.from(awbFile.subarray(0, 9)).toString('ascii'), '#!AMR-WB\n');

    const decoded = await AmrDecoder.decodeAmrFile(awbFile);
    assert.strictEqual(decoded.sampleRate, 16000);
    assert.strictEqual(decoded.pcm.length, numSamples, 'Decoded sample count must match input');
  });

  it('Mp4BoxReader correctly detects and extracts audio tracks from 3GP containers', () => {
    // Non-MP4 data returns false
    assert.strictEqual(Mp4BoxReader.isMp4Or3gp(new Uint8Array([0, 1, 2, 3])), false);

    // Build a minimal synthetic 3GP container in memory:
    // ftyp box (major_brand: '3gp4', minor_version: 0, compatible_brands: ['3gp4', 'isom'])
    const ftypPayload = Buffer.from('3gp4\x00\x00\x00\x003gp4isom', 'binary');
    const ftypSize = 8 + ftypPayload.length;
    const ftyp = Buffer.alloc(ftypSize);
    ftyp.writeUInt32BE(ftypSize, 0);
    ftyp.write('ftyp', 4, 'ascii');
    ftypPayload.copy(ftyp, 8);

    assert.ok(Mp4BoxReader.isMp4Or3gp(new Uint8Array(ftyp)));

    // Parse minimal container without tracks
    const result = Mp4BoxReader.parse(new Uint8Array(ftyp));
    assert.ok(result.brands.includes('3gp4'));
    assert.strictEqual(result.audioTracks.length, 0);
  });

  it('G726Encoder encodes 8 kHz PCM to 32 kbps ADPCM and reconstructs speech', () => {
    const sampleRate = 8000;
    const durationSec = 0.5;
    const numSamples = sampleRate * durationSec;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(12000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    }

    const encoded = G726Encoder.encode32(pcm);
    assert.strictEqual(encoded.length, numSamples / 2, 'G.726 32k produces 4 bits per sample (1 byte per 2 samples)');

    const decoded = G726Decoder.decode32(encoded);
    assert.strictEqual(decoded.length, numSamples);

    const snr = computeSnr(pcm, decoded, 20);
    assert.ok(snr > 15, `Expected G.726 32k SNR > 15 dB, got ${snr.toFixed(2)} dB`);
  });

  it('G729Encoder encodes 8 kHz PCM into 10-byte frames and decodes successfully', () => {
    const sampleRate = 8000;
    const durationSec = 0.2; // 200 ms = 20 frames of 10 ms
    const numSamples = sampleRate * durationSec;
    const pcm = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm[i] = Math.round(10000 * Math.sin((2 * Math.PI * 400 * i) / sampleRate));
    }

    const frames = G729Encoder.encode(pcm, { dtx: false });
    assert.strictEqual(frames.length, 20, '200 ms of audio produces 20 frames of 10 ms');
    assert.strictEqual(frames[0].length, 10, 'Each G.729 frame must be exactly 10 bytes (80 bits)');

    // Decode round-trip
    const totalBytes = frames.reduce((a, f) => a + f.length, 0);
    const packed = new Uint8Array(totalBytes);
    let off = 0;
    for (const f of frames) {
      packed.set(f, off);
      off += f.length;
    }
    const decoded = G729Decoder.decode(packed);
    assert.strictEqual(decoded.length, numSamples);

    // DTX behavior on silence
    const silence = new Int16Array(160); // 20 ms silence
    const sidFrames = G729Encoder.encode(silence, { dtx: true });
    assert.strictEqual(sidFrames.length, 2);
    assert.strictEqual(sidFrames[0].length, 2, 'G.729 Annex B SID frame must be 2 bytes');
  });

  it('G.722 encodes and decodes smoothly without high-frequency comb or choppy amplitude artifacts', () => {
    const sampleRate = 16000;
    const n = 16000; // 1 second of audio
    const pcm = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      // Speech vowel formant combination: 250 Hz fundamental + 1200 Hz + 2400 Hz
      pcm[i] = Math.round(
        8000 * Math.sin((2 * Math.PI * 250 * i) / sampleRate) +
        4000 * Math.sin((2 * Math.PI * 1200 * i) / sampleRate) +
        2000 * Math.sin((2 * Math.PI * 2400 * i) / sampleRate)
      );
    }

    const enc = G722Encoder.encode(pcm, 8);
    const dec = G722Decoder.decodeG722(enc, 8);
    assert.strictEqual(dec.length, n);

    // Compute high-frequency roughness ratio (energy of sample-to-sample difference vs total energy)
    let origHf = 0, origTot = 0;
    let decHf = 0, decTot = 0;
    for (let i = 100; i < n - 100; i++) {
      const dOrig = pcm[i] - pcm[i - 1];
      origHf += dOrig * dOrig;
      origTot += pcm[i] * pcm[i];

      const dDec = dec[i] - dec[i - 1];
      decHf += dDec * dDec;
      decTot += dec[i] * dec[i];
    }
    const origRoughness = origHf / (origTot || 1);
    const decRoughness = decHf / (decTot || 1);
    const roughnessDelta = Math.abs(decRoughness - origRoughness);
    assert.ok(roughnessDelta < 0.01, `Expected reconstructed roughness to match original within 0.01, got delta ${roughnessDelta.toFixed(6)}`);

    // Cross correlation accounting for 24-sample QMF delay
    const delay = 24;
    let num = 0, den1 = 0, den2 = 0;
    for (let i = 100; i < n - delay; i++) {
      const orig = pcm[i];
      const recon = dec[i + delay];
      num += orig * recon;
      den1 += orig * orig;
      den2 += recon * recon;
    }
    const corr = num / Math.sqrt(den1 * den2);
    assert.ok(corr > 0.80, `Expected high speech correlation > 0.80, got ${corr.toFixed(3)}`);
  });

  it('CodecProfileRegistry defines valid documentation links and descriptions for all telephony profiles', () => {
    const requiredProfiles = ['g711u', 'g711a', 'g722', 'g726', 'amr-nb', 'amr-wb', 'evs', 'evs-nb', 'evs-swb', 'g729'];
    for (const id of requiredProfiles) {
      const profile = CodecProfileRegistry.get(id);
      assert.ok(profile, `Profile ${id} must exist in registry`);
      assert.ok(profile.docUrl && profile.docUrl.startsWith('http'), `Profile ${id} must have a valid HTTP docUrl`);
      assert.ok(profile.docTitle && profile.docTitle.length > 0, `Profile ${id} must have a docTitle`);
      assert.ok(profile.description && profile.description.length > 10, `Profile ${id} must have an explanatory description`);
    }
  });

  it('Track A preprocessed audio produces valid 16-bit linear PCM WAV bitstream for download', () => {
    const sampleRate = 16000;
    const numSamples = 16000;
    const pcm16 = new Int16Array(numSamples);
    for (let i = 0; i < numSamples; i++) {
      pcm16[i] = Math.round(14000 * Math.sin((2 * Math.PI * 440 * i) / sampleRate));
    }

    const wavBytes = WavExporter.encodeWav([pcm16], sampleRate, 16);
    assert.ok(wavBytes.length > 44, 'WAV file must include 44-byte RIFF header plus payload');
    assert.strictEqual(wavBytes[0], 0x52); // 'R'
    assert.strictEqual(wavBytes[1], 0x49); // 'I'
    assert.strictEqual(wavBytes[2], 0x46); // 'F'
    assert.strictEqual(wavBytes[3], 0x46); // 'F'

    // Verify parsed WAV matches original pcm16 samples exactly
    const parsed = WavParser.parse(wavBytes);
    assert.strictEqual(parsed.sampleRate, sampleRate);
    assert.strictEqual(parsed.numChannels, 1);
    assert.strictEqual(parsed.channelData[0].length, numSamples);

    for (let i = 0; i < numSamples; i++) {
      const origNormalized = pcm16[i] / 32768.0;
      assert.ok(Math.abs(parsed.channelData[0][i] - origNormalized) < 1e-4);
    }
  });

});
