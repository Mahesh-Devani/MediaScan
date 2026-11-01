import { describe, it } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import { StreamAudioDecoder } from '../src/decoders/StreamAudioDecoder.ts';
import { WavExporter } from '../src/media/WavExporter.ts';

describe('Phase 3: StreamAudioDecoder Integration', () => {
  const fixtureDir = path.resolve('test/fixtures/mrfp-o');
  const pcapFile = path.join(fixtureDir, 'mrfp-o.pcap');
  const pcapBytes = new Uint8Array(fs.readFileSync(pcapFile));
  const pipelineResult = CapturePipeline.process(pcapBytes);

  it('correctly resolves codec names from SDP dialogs and PTs', () => {
    const sPcmu = pipelineResult.streams.find(s => s.payloadType === 0)!;
    const sG722 = pipelineResult.streams.find(s => s.payloadType === 9)!;
    const sAmrNb = pipelineResult.streams.find(s => s.payloadType === 100)!;
    const sAmrWb = pipelineResult.streams.find(s => s.payloadType === 101)!;

    assert.ok(sPcmu && sG722 && sAmrNb && sAmrWb, 'All 4 codec streams must exist');

    const infoPcmu = StreamAudioDecoder.resolveCodec(sPcmu, pipelineResult.dialogs);
    assert.strictEqual(infoPcmu.normalizedCodec, 'PCMU');
    assert.strictEqual(infoPcmu.clockRate, 8000);

    const infoG722 = StreamAudioDecoder.resolveCodec(sG722, pipelineResult.dialogs);
    assert.strictEqual(infoG722.normalizedCodec, 'G722');
    assert.strictEqual(infoG722.clockRate, 8000); // Negotiated in SDP as 8000 (RFC 3551 standard)

    const infoAmr = StreamAudioDecoder.resolveCodec(sAmrNb, pipelineResult.dialogs);
    assert.strictEqual(infoAmr.normalizedCodec, 'AMR');
    assert.strictEqual(infoAmr.octetAligned, false);

    const infoAmrWb = StreamAudioDecoder.resolveCodec(sAmrWb, pipelineResult.dialogs);
    assert.strictEqual(infoAmrWb.normalizedCodec, 'AMR-WB');
    assert.strictEqual(infoAmrWb.octetAligned, false);
  });

  it('decodes G.711 stream and produces valid WAV', async () => {
    const sPcmu = pipelineResult.streams.find(s => s.payloadType === 0 && s.packets.length === 2282)!;
    assert.ok(sPcmu, 'PCMU stream must be found');
    const decoded = await StreamAudioDecoder.decodeStream(sPcmu, pipelineResult.dialogs);

    assert.strictEqual(decoded.sampleRate, 8000);
    assert.strictEqual(decoded.codec, 'PCMU');
    assert.ok(decoded.pcm.length > 0);

    const refPcmBytes = fs.readFileSync(path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-8194-pt0.ulaw.pcm'));
    const refPcm = new Int16Array(refPcmBytes.buffer, refPcmBytes.byteOffset, refPcmBytes.byteLength / 2);
    assert.strictEqual(decoded.pcm.length, refPcm.length);

    let maxDiff = 0;
    for (let i = 0; i < decoded.pcm.length; i++) {
      const diff = Math.abs(decoded.pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.strictEqual(maxDiff, 0, 'PCMU decoded via StreamAudioDecoder must be bit-exact to reference');

    const wav = WavExporter.encodeWav([decoded.pcm], decoded.sampleRate, 16);
    assert.strictEqual(wav[0], 0x52); // 'R'
    assert.strictEqual(wav[1], 0x49); // 'I'
    assert.strictEqual(wav[2], 0x46); // 'F'
    assert.strictEqual(wav[3], 0x46); // 'F'
  });

  it('decodes G.722 stream bit-exact and produces 16kHz WAV', async () => {
    const sG722 = pipelineResult.streams.find(s => s.payloadType === 9 && s.packets.length === 2925)!;
    const decoded = await StreamAudioDecoder.decodeStream(sG722, pipelineResult.dialogs);

    assert.strictEqual(decoded.sampleRate, 16000);
    assert.strictEqual(decoded.codec, 'G722');

    // Compare with reference PCM
    const refPcmBytes = fs.readFileSync(path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-9218-pt9.g722.pcm'));
    const refPcm = new Int16Array(refPcmBytes.buffer, refPcmBytes.byteOffset, refPcmBytes.byteLength / 2);
    assert.strictEqual(decoded.pcm.length, refPcm.length);

    let maxDiff = 0;
    for (let i = 0; i < decoded.pcm.length; i++) {
      const diff = Math.abs(decoded.pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.strictEqual(maxDiff, 0, 'G.722 decoded via StreamAudioDecoder must be bit-exact to reference');

    const wav = WavExporter.encodeWav([decoded.pcm], decoded.sampleRate, 16);
    const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    assert.strictEqual(view.getUint32(24, true), 16000, 'WAV sample rate must be 16000 Hz');
  });

  it('decodes AMR-NB stream bit-exact and produces 8kHz WAV', async () => {
    const sAmrNb = pipelineResult.streams.find(s => s.payloadType === 100 && s.packets.length === 2921)!;
    const decoded = await StreamAudioDecoder.decodeStream(sAmrNb, pipelineResult.dialogs);

    assert.strictEqual(decoded.sampleRate, 8000);
    assert.strictEqual(decoded.codec, 'AMR-NB');

    const refPcmBytes = fs.readFileSync(path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-10242-pt100.amr.pcm'));
    const refPcm = new Int16Array(refPcmBytes.buffer, refPcmBytes.byteOffset, refPcmBytes.byteLength / 2);
    assert.strictEqual(decoded.pcm.length, refPcm.length);

    let maxDiff = 0;
    for (let i = 0; i < decoded.pcm.length; i++) {
      const diff = Math.abs(decoded.pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.strictEqual(maxDiff, 0, 'AMR-NB decoded via StreamAudioDecoder must be bit-exact to reference');
  });

  it('decodes AMR-WB stream bit-exact and produces 16kHz WAV', async () => {
    const sAmrWb = pipelineResult.streams.find(s => s.payloadType === 101 && s.packets.length === 2919)!;
    const decoded = await StreamAudioDecoder.decodeStream(sAmrWb, pipelineResult.dialogs);

    assert.strictEqual(decoded.sampleRate, 16000);
    assert.strictEqual(decoded.codec, 'AMR-WB');

    const refPcmBytes = fs.readFileSync(path.join(fixtureDir, 'fd5d;d50a;8c17;2110;;547-11266-pt101.amrwb.pcm'));
    const refPcm = new Int16Array(refPcmBytes.buffer, refPcmBytes.byteOffset, refPcmBytes.byteLength / 2);
    assert.strictEqual(decoded.pcm.length, refPcm.length);

    let maxDiff = 0;
    for (let i = 0; i < decoded.pcm.length; i++) {
      const diff = Math.abs(decoded.pcm[i] - refPcm[i]);
      if (diff > maxDiff) maxDiff = diff;
    }
    assert.strictEqual(maxDiff, 0, 'AMR-WB decoded via StreamAudioDecoder must be bit-exact to reference');
  });

  it('creates synchronized dual-channel stereo WAV for G.722 leg', async () => {
    const legB = pipelineResult.legs.find(l => l.id === 'Leg B')!;
    assert.ok(legB && legB.inboundStream && legB.outboundStream);

    const inStream = pipelineResult.streams.find(s => s.ssrc === legB.inboundStream!.ssrc)!;
    const outStream = pipelineResult.streams.find(s => s.ssrc === legB.outboundStream!.ssrc)!;

    const [decIn, decOut] = await Promise.all([
      StreamAudioDecoder.decodeStream(inStream, pipelineResult.dialogs),
      StreamAudioDecoder.decodeStream(outStream, pipelineResult.dialogs),
    ]);

    assert.strictEqual(decIn.sampleRate, 16000);
    assert.strictEqual(decOut.sampleRate, 16000);

    const stereoWav = WavExporter.encodeStereoWav(decIn.pcm, decOut.pcm, 16000);
    const view = new DataView(stereoWav.buffer, stereoWav.byteOffset, stereoWav.byteLength);

    assert.strictEqual(view.getUint16(22, true), 2, 'Must have 2 audio channels');
    assert.strictEqual(view.getUint32(24, true), 16000, 'Sample rate must be 16000 Hz');
    assert.strictEqual(view.getUint16(34, true), 16, 'Bits per sample must be 16');
  });

  it('creates synchronized dual-channel stereo WAV for AMR-NB leg', async () => {
    const legC = pipelineResult.legs.find(l => l.id === 'Leg C')!;
    assert.ok(legC && legC.inboundStream && legC.outboundStream);

    const inStream = pipelineResult.streams.find(s => s.ssrc === legC.inboundStream!.ssrc)!;
    const outStream = pipelineResult.streams.find(s => s.ssrc === legC.outboundStream!.ssrc)!;

    const [decIn, decOut] = await Promise.all([
      StreamAudioDecoder.decodeStream(inStream, pipelineResult.dialogs),
      StreamAudioDecoder.decodeStream(outStream, pipelineResult.dialogs),
    ]);

    assert.strictEqual(decIn.sampleRate, 8000);
    assert.strictEqual(decOut.sampleRate, 8000);

    const stereoWav = WavExporter.encodeStereoWav(decIn.pcm, decOut.pcm, 8000);
    const view = new DataView(stereoWav.buffer, stereoWav.byteOffset, stereoWav.byteLength);

    assert.strictEqual(view.getUint16(22, true), 2, 'Must have 2 audio channels');
    assert.strictEqual(view.getUint32(24, true), 8000, 'Sample rate must be 8000 Hz');
    assert.strictEqual(view.getUint16(34, true), 16, 'Bits per sample must be 16');
  });

  it('correctly pads silence suppression gaps to restore full real-time clip duration', async () => {
    // SSRC 1619045890 has 23 silence gaps in PCAP
    const sOutPcmu = pipelineResult.streams.find(s => s.ssrc === 1619045890)!;
    assert.ok(sOutPcmu);

    const rawNoSilence = await StreamAudioDecoder.decodeStream(sOutPcmu, pipelineResult.dialogs, false);
    const paddedWithSilence = await StreamAudioDecoder.decodeStream(sOutPcmu, pipelineResult.dialogs, true);

    const rawSec = rawNoSilence.pcm.length / rawNoSilence.sampleRate;
    const paddedSec = paddedWithSilence.pcm.length / paddedWithSilence.sampleRate;
    const pcapSec = sOutPcmu.endTime - sOutPcmu.startTime;

    // Without padding, silence is compressed out (~21.7s)
    assert.ok(rawSec < 23 && rawSec > 20);

    // With padding (default), audio spans full real-time duration (~40.2s matching PCAP)
    assert.ok(Math.abs(paddedSec - pcapSec) < 0.2, `Padded duration ${paddedSec}s should match PCAP duration ${pcapSec}s`);
  });
});
