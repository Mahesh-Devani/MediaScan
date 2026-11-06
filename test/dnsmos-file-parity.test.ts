/**
 * dnsmos-file-parity.test.ts
 * Golden parity test verifying that:
 * 1. WAV files parsed through WavParser produce scores matching reference within 0.01 across all 5 golden fixtures.
 * 2. Multi-channel stereo WAV (clean left, noisy right) scores match their respective individual mono references within 0.01.
 * 3. Compares multiple results and emits sample rate mismatch warnings when comparing 8kHz vs 16kHz files.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { WavParser } from '../src/audio/WavParser.ts';
import { ChannelSplitter } from '../src/audio/ChannelSplitter.ts';
import { DnsmosEngine } from '../src/dnsmos/DnsmosEngine.ts';
import { DnsmosToolEngine } from '../src/dnsmos/DnsmosToolEngine.ts';

describe('DNSMOS File Pipeline Golden Parity & Multi-Channel Fixtures', () => {
  const goldenPath = path.resolve(process.cwd(), 'test/fixtures/dnsmos/golden_dnsmos.json');

  it('matches reference scores within 0.01 when reading all 5 golden fixtures via WavParser', async () => {
    assert.ok(fs.existsSync(goldenPath), `Golden fixture not found: ${goldenPath}`);
    const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));

    const fixtures = ['clean_speech', 'noisy_speech', 'nr_processed', 'g711_8k', 'short_clip'];

    for (const name of fixtures) {
      const expected = goldenData[name];
      const wavPath = path.resolve(process.cwd(), expected.filename);
      const wavBuffer = fs.readFileSync(wavPath);

      // 1. Parse via WavParser
      const parsed = WavParser.parse(wavBuffer, path.basename(wavPath));
      assert.strictEqual(parsed.numChannels, 1);
      assert.ok(parsed.sampleRate > 0);

      // 2. Score via DnsmosEngine
      const actual = await DnsmosEngine.evaluatePcm(
        parsed.channelData[0],
        parsed.sampleRate,
        {
          streamId: name,
          ssrc: 2000 + fixtures.indexOf(name),
          codec: parsed.formatName,
          fileInfo: {
            fileName: path.basename(wavPath),
            channelIndex: 0,
            channelName: 'Mono',
            totalChannels: 1,
            formatName: parsed.formatName,
          },
        },
        { includeP808: true }
      );

      // Verify tolerance within 0.01
      const diffSig = Math.abs(actual.sig - expected.SIG);
      const diffBak = Math.abs(actual.bak - expected.BAK);
      const diffOvrl = Math.abs(actual.ovrl - expected.OVRL);

      assert.ok(
        diffSig <= 0.01,
        `Fixture ${name} SIG mismatch via WavParser: expected ${expected.SIG.toFixed(4)}, got ${actual.sig.toFixed(4)} (diff: ${diffSig.toFixed(4)})`
      );
      assert.ok(
        diffBak <= 0.01,
        `Fixture ${name} BAK mismatch via WavParser: expected ${expected.BAK.toFixed(4)}, got ${actual.bak.toFixed(4)} (diff: ${diffBak.toFixed(4)})`
      );
      assert.ok(
        diffOvrl <= 0.01,
        `Fixture ${name} OVRL mismatch via WavParser: expected ${expected.OVRL.toFixed(4)}, got ${actual.ovrl.toFixed(4)} (diff: ${diffOvrl.toFixed(4)})`
      );
    }
  });

  it('accurately scores a stereo WAV containing clean speech on Left and noisy speech on Right', async () => {
    const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const cleanRef = goldenData['clean_speech'];
    const noisyRef = goldenData['noisy_speech'];

    const cleanBuf = fs.readFileSync(path.resolve(process.cwd(), cleanRef.filename));
    const noisyBuf = fs.readFileSync(path.resolve(process.cwd(), noisyRef.filename));

    const cleanParsed = WavParser.parse(cleanBuf, 'clean.wav');
    const noisyParsed = WavParser.parse(noisyBuf, 'noisy.wav');

    const len = Math.min(cleanParsed.channelData[0].length, noisyParsed.channelData[0].length);
    const stereoData = [
      cleanParsed.channelData[0].subarray(0, len),
      noisyParsed.channelData[0].subarray(0, len),
    ];

    const channels = ChannelSplitter.splitChannels(stereoData);
    assert.strictEqual(channels.length, 2);
    assert.strictEqual(channels[0].channelName, 'Left');
    assert.strictEqual(channels[1].channelName, 'Right');

    // Score Left (clean)
    const scoreLeft = await DnsmosToolEngine.scoreChannel({
      fileId: 'stereo_test',
      fileName: 'stereo_meeting.wav',
      channel: channels[0],
      sampleRate: 16000,
      formatName: 'WAV Stereo',
    });

    // Score Right (noisy)
    const scoreRight = await DnsmosToolEngine.scoreChannel({
      fileId: 'stereo_test',
      fileName: 'stereo_meeting.wav',
      channel: channels[1],
      sampleRate: 16000,
      formatName: 'WAV Stereo',
    });

    // Left channel matches clean_speech reference within 0.01
    assert.ok(Math.abs(scoreLeft.sig - cleanRef.SIG) <= 0.01);
    assert.ok(Math.abs(scoreLeft.bak - cleanRef.BAK) <= 0.01);

    // Right channel matches noisy_speech reference within 0.01
    assert.ok(Math.abs(scoreRight.sig - noisyRef.SIG) <= 0.01);
    assert.ok(Math.abs(scoreRight.bak - noisyRef.BAK) <= 0.01);

    // Compare mode generates delta and detects matched sample rate
    const comp = DnsmosToolEngine.compareMultiple([scoreLeft, scoreRight]);
    assert.strictEqual(comp.hasRateMismatch, false);
    assert.strictEqual(comp.items.length, 2);
    assert.ok(comp.items[1].deltaBakAgainstBase < 0, 'Noisy right channel has lower BAK than clean left base');
  });

  it('detects sample rate mismatch when comparing 8 kHz vs 16 kHz files', async () => {
    const goldenData = JSON.parse(fs.readFileSync(goldenPath, 'utf8'));
    const ref8k = goldenData['g711_8k'];
    const ref16k = goldenData['clean_speech'];

    const buf8k = fs.readFileSync(path.resolve(process.cwd(), ref8k.filename));
    const buf16k = fs.readFileSync(path.resolve(process.cwd(), ref16k.filename));

    const parsed8k = WavParser.parse(buf8k, 'g711_8k.wav');
    const parsed16k = WavParser.parse(buf16k, 'clean_16k.wav');

    const score8k = await DnsmosEngine.evaluatePcm(parsed8k.channelData[0], 8000, {
      streamId: 'g711_8k',
      ssrc: 8001,
      codec: 'G.711',
    });

    const score16k = await DnsmosEngine.evaluatePcm(parsed16k.channelData[0], 16000, {
      streamId: 'clean_16k',
      ssrc: 16001,
      codec: 'EVS-WB',
    });

    const comp = DnsmosToolEngine.compareMultiple([score8k, score16k]);
    assert.strictEqual(comp.hasRateMismatch, true);
    assert.ok(comp.rateMismatchWarning?.includes('different native sample rates'));
  });
});
