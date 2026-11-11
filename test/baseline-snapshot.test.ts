import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateBaseline, type BaselineSnapshot } from '../scripts/generate-baseline-snapshot.ts';

describe('Pre-SRTP Baseline Non-Regression Golden Test', () => {
  const snapshotPath = path.resolve('test/fixtures/baseline/baseline-snapshot.json');

  it('preserves 100% byte-identical PCM/WAV hashes and stream parameters across all golden pcaps', async () => {
    assert.ok(fs.existsSync(snapshotPath), `Baseline snapshot file must exist: ${snapshotPath}`);
    const baselineRaw = fs.readFileSync(snapshotPath, 'utf-8');
    const baseline: BaselineSnapshot = JSON.parse(baselineRaw);

    const currentRaw = await generateBaseline();
    const current: BaselineSnapshot = JSON.parse(JSON.stringify(currentRaw));

    // 1. Synthetic Video Verification
    assert.equal(current.syntheticVideo.nalCount, baseline.syntheticVideo.nalCount, 'Video NAL count must match');
    assert.equal(current.syntheticVideo.annexBSha256, baseline.syntheticVideo.annexBSha256, 'H.264 Annex B SHA-256 must match');
    assert.equal(current.syntheticVideo.mp4Sha256, baseline.syntheticVideo.mp4Sha256, 'Muxed MP4 container SHA-256 must match');

    // 2. PCAP Verification
    for (const [pcapName, basePcap] of Object.entries(baseline.pcaps)) {
      const curPcap = current.pcaps[pcapName];
      assert.ok(curPcap, `Pcap ${pcapName} must be present in current execution`);

      // Stats
      assert.deepEqual(curPcap.stats, basePcap.stats, `Packet statistics for ${pcapName} must match`);

      // Media Server
      assert.deepEqual(curPcap.mediaServer?.ip, basePcap.mediaServer?.ip, `Media Server IP for ${pcapName} must match`);

      // Dialogs
      assert.equal(curPcap.dialogCount, basePcap.dialogCount, `Dialog count for ${pcapName} must match`);
      assert.deepEqual(curPcap.dialogs, basePcap.dialogs, `Dialog list for ${pcapName} must match`);

      // Legs
      assert.equal(curPcap.legCount, basePcap.legCount, `Leg count for ${pcapName} must match`);
      assert.deepEqual(curPcap.legs, basePcap.legs, `Leg model for ${pcapName} must match`);

      // Conversations
      assert.equal(curPcap.conversationCount, basePcap.conversationCount, `Conversation count for ${pcapName} must match`);
      assert.deepEqual(curPcap.conversations, basePcap.conversations, `Conversations for ${pcapName} must match`);

      // Streams
      assert.equal(curPcap.streams.length, basePcap.streams.length, `Stream count for ${pcapName} must match`);
      for (let i = 0; i < basePcap.streams.length; i++) {
        const bStream = basePcap.streams[i];
        const cStream = curPcap.streams[i];

        assert.equal(cStream.ssrc, bStream.ssrc, `Stream ${i} SSRC must match`);
        assert.equal(cStream.payloadType, bStream.payloadType, `Stream ${bStream.ssrc} PT must match`);
        assert.equal(cStream.codec, bStream.codec, `Stream ${bStream.ssrc} codec must match`);
        assert.equal(cStream.packetCount, bStream.packetCount, `Stream ${bStream.ssrc} packet count must match`);
        assert.equal(cStream.lossCount, bStream.lossCount, `Stream ${bStream.ssrc} loss count must match`);
        assert.equal(cStream.lossPercent, bStream.lossPercent, `Stream ${bStream.ssrc} loss % must match`);
        assert.equal(cStream.jitterUs, bStream.jitterUs, `Stream ${bStream.ssrc} jitter must match`);
        assert.equal(cStream.mos, bStream.mos, `Stream ${bStream.ssrc} MOS must match`);
        assert.equal(cStream.rFactor, bStream.rFactor, `Stream ${bStream.ssrc} rFactor must match`);

        // Byte-for-byte audio hash verification
        if (bStream.pcmSha256) {
          assert.equal(cStream.pcmSha256, bStream.pcmSha256, `Stream ${bStream.ssrc} PCM SHA-256 must be byte-identical`);
          assert.equal(cStream.pcmSampleCount, bStream.pcmSampleCount, `Stream ${bStream.ssrc} sample count must match`);
        }
        if (bStream.wavSha256) {
          assert.equal(cStream.wavSha256, bStream.wavSha256, `Stream ${bStream.ssrc} WAV SHA-256 must be byte-identical`);
        }
        if (bStream.snrDb !== undefined) {
          assert.equal(cStream.snrDb, bStream.snrDb, `Stream ${bStream.ssrc} SNR must match`);
        }
      }
    }
  });
});
