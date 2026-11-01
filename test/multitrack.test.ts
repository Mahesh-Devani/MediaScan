import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'node:path';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import { MultiTrackPlayer } from '../src/media/MultiTrackPlayer.ts';

describe('Multi-Track RTP Player Engine', () => {
  const pcapFile = path.resolve('test/fixtures/mrfp-o/mrfp-o.pcap');
  const pcapBytes = new Uint8Array(fs.readFileSync(pcapFile));
  const pipelineResult = CapturePipeline.process(pcapBytes);

  it('correctly loads all streams with proper direction and timeline alignment', async () => {
    const player = new MultiTrackPlayer();
    await player.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs
    );

    const tracks = player.getTracks();
    assert.strictEqual(tracks.length, 8, 'Must load all 8 RTP streams');

    // Verify inbound / outbound distribution
    const inbounds = tracks.filter(t => t.direction === 'inbound');
    const outbounds = tracks.filter(t => t.direction === 'outbound');
    assert.strictEqual(inbounds.length, 4, 'Must have 4 inbound streams');
    assert.strictEqual(outbounds.length, 4, 'Must have 4 outbound streams');

    // Total duration should match longest stream duration (~58.5s)
    const totalDuration = player.getTotalDuration();
    assert.ok(totalDuration > 58 && totalDuration < 60, `Total duration ${totalDuration}s should be ~58.5s`);

    // Verify relative start times
    for (const t of tracks) {
      assert.ok(t.relativeStartTime >= 0);
      assert.ok(t.relativeEndTime <= totalDuration + 0.5);
      assert.ok(t.peaks.length > 0, 'Must have precomputed waveform peaks');
    }
  });

  it('handles track muting and solo isolation correctly', async () => {
    const player = new MultiTrackPlayer();
    await player.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs
    );

    const tracks = player.getTracks();
    const firstSsrc = tracks[0].ssrc;

    // Solo first stream
    player.setTrackSolo(firstSsrc, true);
    assert.strictEqual(tracks[0].isSolo, true);
    assert.strictEqual(tracks[1].isSolo, false);

    // Mute second stream
    player.setTrackMute(tracks[1].ssrc, true);
    assert.strictEqual(tracks[1].isMuted, true);

    // Mute all
    player.muteAll(true);
    assert.ok(tracks.every(t => t.isMuted));

    // Unmute all
    player.muteAll(false);
    assert.ok(tracks.every(t => !t.isMuted));
  });

  it('exports combined multi-track mixed WAV', async () => {
    const player = new MultiTrackPlayer();
    await player.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs
    );

    const mixedWav = player.exportMixedWav();
    assert.ok(mixedWav.length > 44, 'Mixed WAV must contain header and data');

    const view = new DataView(mixedWav.buffer, mixedWav.byteOffset, mixedWav.byteLength);
    // RIFF check
    assert.strictEqual(view.getUint32(0, false), 0x52494646); // 'RIFF'
    assert.strictEqual(view.getUint32(8, false), 0x57415645); // 'WAVE'
    assert.strictEqual(view.getUint32(24, true), 16000, 'Mix rate should be 16000 Hz');
  });

  it('supports GoldWave-style time range selection and range WAV export', async () => {
    const player = new MultiTrackPlayer();
    await player.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs
    );

    // Initial state: no selection
    assert.strictEqual(player.getSelection(), null);

    // Set selection from 10.5s to 25.0s
    player.setSelection(10.5, 25.0);
    const sel = player.getSelection();
    assert.ok(sel !== null);
    assert.strictEqual(sel.startSec, 10.5);
    assert.strictEqual(sel.endSec, 25.0);

    // Inverted selection (drag leftwards: 25.0s down to 10.5s) should auto-normalize
    player.setSelection(25.0, 10.5);
    const sel2 = player.getSelection();
    assert.ok(sel2 !== null);
    assert.strictEqual(sel2.startSec, 10.5);
    assert.strictEqual(sel2.endSec, 25.0);

    // Loop state toggle
    player.setIsLooping(true);
    assert.strictEqual(player.getIsLooping(), true);

    // Export WAV for selection slice (14.5 seconds @ 16kHz)
    const sliceWav = player.exportMixedWav();
    assert.ok(sliceWav.length > 44);

    const view = new DataView(sliceWav.buffer, sliceWav.byteOffset, sliceWav.byteLength);
    const dataSize = view.getUint32(40, true);
    const sampleCount = dataSize / 2; // 16-bit mono = 2 bytes per sample
    const expectedSamples = Math.ceil(14.5 * 16000);
    assert.strictEqual(sampleCount, expectedSamples, 'Slice WAV must have exact duration samples');

    // Clear selection
    player.clearSelection();
    assert.strictEqual(player.getSelection(), null);
  });

  it('supports conversation filtering and multiple sorting modes', async () => {
    const player = new MultiTrackPlayer();
    await player.loadSession(
      pipelineResult.streams,
      pipelineResult.dialogs,
      pipelineResult.mediaServer?.ip || '',
      pipelineResult.legs,
      pipelineResult.conversations
    );

    // Initial state: default sorting is 'leg-pairs'
    const tracksPairs = player.getTracks();
    assert.strictEqual(tracksPairs.length, 8);
    // In leg-pairs mode, Leg A IN and Leg A OUT should be adjacent
    assert.strictEqual(tracksPairs[0].legId, 'Leg A');
    assert.strictEqual(tracksPairs[0].direction, 'inbound');
    assert.strictEqual(tracksPairs[1].legId, 'Leg A');
    assert.strictEqual(tracksPairs[1].direction, 'outbound');

    // Test 'in-first' sorting
    player.setSortOrder('in-first');
    const tracksInFirst = player.getTracks();
    assert.strictEqual(tracksInFirst.length, 8);
    assert.ok(tracksInFirst.slice(0, 4).every(t => t.direction === 'inbound'), 'First 4 must be Inbound');
    assert.ok(tracksInFirst.slice(4, 8).every(t => t.direction === 'outbound'), 'Last 4 must be Outbound');

    // Test 'out-first' sorting
    player.setSortOrder('out-first');
    const tracksOutFirst = player.getTracks();
    assert.strictEqual(tracksOutFirst.length, 8);
    assert.ok(tracksOutFirst.slice(0, 4).every(t => t.direction === 'outbound'), 'First 4 must be Outbound');
    assert.ok(tracksOutFirst.slice(4, 8).every(t => t.direction === 'inbound'), 'Last 4 must be Inbound');

    // Test 'chronological' sorting
    player.setSortOrder('chronological');
    const tracksChrono = player.getTracks();
    assert.strictEqual(tracksChrono.length, 8);
    for (let i = 1; i < tracksChrono.length; i++) {
      assert.ok(tracksChrono[i].startTime >= tracksChrono[i - 1].startTime, 'Must be sorted by startTime');
    }

    // Test conversation filtering
    player.setConversationFilter('0');
    const filteredTracks = player.getTracks();
    assert.strictEqual(filteredTracks.length, 8, 'Conversation 0 in mrfp-o has 8 streams across 4 legs');

    // Reset filter to 'all'
    player.setConversationFilter('all');
    assert.strictEqual(player.getTracks().length, 8);
  });
});
