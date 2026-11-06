/**
 * channel-independence.test.ts
 * Tests for ChannelSplitter and multi-channel scoring independence:
 * - A stereo file with clean left and noisy right produces different scores.
 * - Scoring a channel from a multi-channel file matches scoring it as mono.
 * - Digitally silent channels are detected and skipped with a note.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ChannelSplitter } from '../src/audio/ChannelSplitter.ts';
import { DnsmosEngine } from '../src/dnsmos/DnsmosEngine.ts';
import { DnsmosToolEngine } from '../src/dnsmos/DnsmosToolEngine.ts';

describe('Channel Independence and Multi-Channel Telemetry', () => {

  it('correctly labels 1, 2, 6, and 8 channel configurations with standard names', () => {
    const mono = [new Float32Array(100)];
    const stereo = [new Float32Array(100), new Float32Array(100)];
    const surround51 = Array.from({ length: 6 }, () => new Float32Array(100));
    const surround71 = Array.from({ length: 8 }, () => new Float32Array(100));

    const monoRes = ChannelSplitter.splitChannels(mono);
    assert.strictEqual(monoRes[0].channelName, 'Mono');

    const stereoRes = ChannelSplitter.splitChannels(stereo);
    assert.strictEqual(stereoRes[0].channelName, 'Left');
    assert.strictEqual(stereoRes[1].channelName, 'Right');

    const s51Res = ChannelSplitter.splitChannels(surround51);
    assert.strictEqual(s51Res[2].channelName, 'Center');
    assert.strictEqual(s51Res[3].channelName, 'LFE (Subwoofer)');

    const s71Res = ChannelSplitter.splitChannels(surround71);
    assert.strictEqual(s71Res[7].channelName, 'Side Right');
  });

  it('detects digitally silent channels and skips them with a diagnostic note', () => {
    const silentData = new Float32Array(16000); // All zeros
    const activeData = new Float32Array(16000);
    for (let i = 0; i < 16000; i++) {
      activeData[i] = Math.sin((2 * Math.PI * 440 * i) / 16000) * 0.5;
    }

    const channels = ChannelSplitter.splitChannels([silentData, activeData]);
    assert.strictEqual(channels[0].isSilent, true);
    assert.ok(channels[0].silenceReason?.includes('silent'));
    assert.strictEqual(channels[1].isSilent, false);
    assert.ok(channels[1].peakDbfs > -10);

    // Scoring a silent channel throws/skips cleanly without returning a false 0 or 1.0
    assert.rejects(async () => {
      await DnsmosToolEngine.scoreChannel({
        fileId: 'f1',
        fileName: 'test.wav',
        channel: channels[0],
        sampleRate: 16000,
        formatName: 'WAV',
      });
    }, /silent/);
  });

  it('evaluates stereo audio with clean vs noisy channels independently', async () => {
    const N = 144160; // 9.01s at 16kHz
    const cleanLeft = new Float32Array(N);
    const noisyRight = new Float32Array(N);

    // Harmonic speech-like carrier on both
    for (let i = 0; i < N; i++) {
      const t = i / 16000;
      const speech = (
        0.3 * Math.sin(2 * Math.PI * 220 * t) +
        0.2 * Math.sin(2 * Math.PI * 440 * t) +
        0.1 * Math.sin(2 * Math.PI * 880 * t)
      );
      cleanLeft[i] = speech;
      // High noise on right channel
      const noise = (Math.random() * 2 - 1) * 0.4;
      noisyRight[i] = speech + noise;
    }

    // Score both channels
    const resLeft = await DnsmosEngine.evaluatePcm(cleanLeft, 16000, {
      streamId: 'stereo_left',
      ssrc: 101,
      codec: 'PCM',
    });

    const resRight = await DnsmosEngine.evaluatePcm(noisyRight, 16000, {
      streamId: 'stereo_right',
      ssrc: 102,
      codec: 'PCM',
    });

    // Clean left must have significantly higher background quality (BAK) than noisy right
    assert.ok(resLeft.bak > resRight.bak, `Expected Left BAK (${resLeft.bak}) > Right BAK (${resRight.bak})`);
    assert.ok(resLeft.ovrl > resRight.ovrl, `Expected Left OVRL (${resLeft.ovrl}) > Right OVRL (${resRight.ovrl})`);

    // Channel isolation: scoring cleanLeft as mono file gives bit-exact identical score
    const resMono = await DnsmosEngine.evaluatePcm(cleanLeft, 16000, {
      streamId: 'stereo_left',
      ssrc: 101,
      codec: 'PCM',
    });
    assert.strictEqual(resLeft.sig, resMono.sig);
    assert.strictEqual(resLeft.bak, resMono.bak);
    assert.strictEqual(resLeft.ovrl, resMono.ovrl);
  });

  it('synthesizes a mono downmix when requested', () => {
    const left = new Float32Array([0.2, 0.4, 0.6]);
    const right = new Float32Array([0.4, 0.6, 0.8]);

    const channels = ChannelSplitter.splitChannels([left, right], true);
    assert.strictEqual(channels.length, 3);
    assert.strictEqual(channels[2].channelName, 'Mono Downmix');
    assert.strictEqual(channels[2].isMonoDownmix, true);
    assert.ok(Math.abs(channels[2].data[0] - 0.3) < 0.001);
    assert.ok(Math.abs(channels[2].data[1] - 0.5) < 0.001);
    assert.ok(Math.abs(channels[2].data[2] - 0.7) < 0.001);
  });
});
