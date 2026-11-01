import { describe, it } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { CapturePipeline } from '../src/CapturePipeline.ts';
import { EvsDepacketizer } from '../src/decoders/EvsDepacketizer.ts';
import { StreamAudioDecoder } from '../src/decoders/StreamAudioDecoder.ts';

const PCAP_PATH = 'test/fixtures/mrfp-1/mrfp-1.pcap';
const REF_DIR = 'test/fixtures/mrfp-1';

describe('Phase 4: EVS (Enhanced Voice Services) Depacketizer & Multi-Band Support', () => {
  it('correctly builds and correlates all 7 legs in mrfp-1.pcap', () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    assert.equal(result.legs.length, 7, 'Should have exactly 7 legs (2 earlier + 5 conference)');
    assert.equal(result.dialogs.length, 5, 'Should have 5 SIP dialogs');

    // Verify all 5 conference legs have their matched inbound and outbound streams
    const legC = result.legs.find(l => l.remoteEndpoint.port === 10000);
    assert.ok(legC && legC.inboundStream, 'Leg C has inbound stream');

    const legD = result.legs.find(l => l.remoteEndpoint.port === 10006);
    assert.ok(legD && legD.inboundStream && legD.outboundStream, 'Leg D has both in and out streams');

    const legE = result.legs.find(l => l.remoteEndpoint.port === 10012 && l.isCorrelatedWithSip);
    assert.ok(legE && legE.inboundStream && legE.outboundStream, 'Leg E (EVS-NB) has both in and out streams');

    const legF = result.legs.find(l => l.remoteEndpoint.port === 10018 && l.isCorrelatedWithSip);
    assert.ok(legF && legF.inboundStream && legF.outboundStream, 'Leg F (EVS-WB) has both in and out streams');

    const legG = result.legs.find(l => l.remoteEndpoint.port === 10024 && l.isCorrelatedWithSip);
    assert.ok(legG && legG.inboundStream && legG.outboundStream, 'Leg G (EVS-SWB) has both in and out streams');
  });

  it('depacketizes Header-Full EVS-HF WB (10314) matching reference .evs_hf file byte-for-byte', () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    const s10314 = result.streams.find(s => s.dstPort === 10314);
    assert.ok(s10314, 'Stream to port 10314 found');

    const refPath = `${REF_DIR}/fd5d;d50a;8c17;2110;;547-10314-pt106.evs_hf`;
    if (!fs.existsSync(refPath)) return;
    const refData = fs.readFileSync(refPath);

    const bitstream = EvsDepacketizer.depacketize(
      s10314.packets.map(p => p.payload),
      true // Header-Full mode
    );

    assert.equal(bitstream.length, refData.length, `File length should match (${refData.length} bytes)`);
    assert.ok(Buffer.from(bitstream).equals(refData), 'Header-Full EVS-HF bitstream is 100% byte-identical to reference bitstream output');
  });

  it('depacketizes Compact EVS SWB (11334) matching reference .evs file byte-for-byte', () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    const s11334 = result.streams.find(s => s.dstPort === 11334);
    assert.ok(s11334, 'Stream to port 11334 found');

    const refPath = `${REF_DIR}/fd5d;d50a;8c17;2110;;547-11334-pt107.evs`;
    if (!fs.existsSync(refPath)) return;
    const refData = fs.readFileSync(refPath);

    const bitstream = EvsDepacketizer.depacketize(
      s11334.packets.map(p => p.payload),
      false // Compact mode
    );

    assert.equal(bitstream.length, refData.length, `File length should match (${refData.length} bytes)`);
    assert.ok(Buffer.from(bitstream).equals(refData), 'Compact EVS bitstream is 100% byte-identical to reference bitstream output');
  });

  it('depacketizes Header-Full EVS-HF NB (9292) matching reference .evs_hf file byte-for-byte', () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    const s9292 = result.streams.find(s => s.dstPort === 9292);
    assert.ok(s9292, 'Stream to port 9292 found');

    const refPath = `${REF_DIR}/fd5d;d50a;8c17;2110;;547-9292-pt105.evs_hf`;
    if (!fs.existsSync(refPath)) return;
    const refData = fs.readFileSync(refPath);

    const bitstream = EvsDepacketizer.depacketize(
      s9292.packets.map(p => p.payload),
      true // Header-Full mode
    );

    assert.equal(bitstream.length, refData.length, `File length should match (${refData.length} bytes)`);
    assert.ok(Buffer.from(bitstream).equals(refData), 'Header-Full EVS-HF bitstream is 100% byte-identical to reference bitstream output');
  });

  it('correctly resolves EVS bandwidths and nominal rates from SDP fmtp', async () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    const s105 = result.streams.find(s => s.payloadType === 105)!;
    const info105 = StreamAudioDecoder.resolveCodec(s105, result.dialogs);
    assert.equal(info105.normalizedCodec, 'EVS-HF');
    assert.equal(info105.bandwidth, 'NB');
    assert.equal(info105.clockRate, 8000);

    const s106 = result.streams.find(s => s.payloadType === 106)!;
    const info106 = StreamAudioDecoder.resolveCodec(s106, result.dialogs);
    assert.equal(info106.normalizedCodec, 'EVS-HF');
    assert.equal(info106.bandwidth, 'WB');
    assert.equal(info106.clockRate, 16000);

    const s107 = result.streams.find(s => s.payloadType === 107 && s.dstPort === 11334)!;
    const info107 = StreamAudioDecoder.resolveCodec(s107, result.dialogs);
    assert.equal(info107.normalizedCodec, 'EVS');
    assert.equal(info107.bandwidth, 'SWB');
    assert.equal(info107.clockRate, 32000);

    // Decode stream should generate real speech PCM and bitstream
    const decoded107 = await StreamAudioDecoder.decodeStream(s107, result.dialogs);
    assert.ok(decoded107.pcm.length > 0, 'Real PCM decoded');
    assert.equal(decoded107.sampleRate, 32000, 'SWB nominal sample rate 32kHz');
    assert.ok(decoded107.bitstream && decoded107.bitstream.length > 0, 'Bitstream attached');
    assert.equal(decoded107.bitstreamExt, 'evs');

    // Verify against 3GPP reference PCM
    const refPath = `${REF_DIR}/mime32_fd5d;d50a;8c17;2110;;547-11334-pt107.evs.pcm`;
    if (fs.existsSync(refPath)) {
      const refBuf = fs.readFileSync(refPath);
      const refPcm = new Int16Array(refBuf.buffer, refBuf.byteOffset, refBuf.byteLength / 2);
      assert.equal(decoded107.pcm.length, refPcm.length, 'Decoded sample count matches reference PCM exactly');

      // Check first 10,000 samples for exact match
      let diff = 0;
      for (let i = 0; i < 10000; i++) {
        diff += Math.abs(decoded107.pcm[i] - refPcm[i]);
      }
      assert.equal(diff, 0, 'WASM decoded PCM matches 3GPP reference PCM 100% bit-exact on first 10,000 samples');
    }
  });

  it('decodes real vocal dynamics and pauses for both EVS inbound and outbound streams', async () => {
    if (!fs.existsSync(PCAP_PATH)) return;
    const buf = fs.readFileSync(PCAP_PATH);
    const result = CapturePipeline.process(new Uint8Array(buf));

    // 1. Outbound EVS-HF WB stream (Stream 10314 -> 10018, 16kHz)
    const outWbStream = result.streams.find(s => s.srcPort === 10314 && s.dstPort === 10018);
    assert.ok(outWbStream, 'Outbound WB stream found');
    const decodedOutWb = await StreamAudioDecoder.decodeStream(outWbStream, result.dialogs);

    let maxAmpWb = 0, silentWb = 0, speechWb = 0;
    for (let i = 0; i < decodedOutWb.pcm.length; i++) {
      const v = Math.abs(decodedOutWb.pcm[i]);
      if (v > maxAmpWb) maxAmpWb = v;
      if (v < 50) silentWb++;
      if (v > 1000) speechWb++;
    }
    assert.ok(maxAmpWb > 30000, `Outbound WB stream has vocal peaks (maxAmp: ${maxAmpWb})`);
    assert.ok(silentWb > 10000, `Outbound WB stream has natural pauses (silent: ${silentWb})`);
    assert.ok(speechWb > 10000, `Outbound WB stream has speech syllables (speech: ${speechWb})`);

    // 2. Outbound EVS-HF NB stream (Stream 9292 -> 10012, 8kHz)
    const outNbStream = result.streams.find(s => s.srcPort === 9292 && s.dstPort === 10012);
    assert.ok(outNbStream, 'Outbound NB stream found');
    const decodedOutNb = await StreamAudioDecoder.decodeStream(outNbStream, result.dialogs);

    let maxAmpNb = 0, silentNb = 0, speechNb = 0;
    for (let i = 0; i < decodedOutNb.pcm.length; i++) {
      const v = Math.abs(decodedOutNb.pcm[i]);
      if (v > maxAmpNb) maxAmpNb = v;
      if (v < 50) silentNb++;
      if (v > 1000) speechNb++;
    }
    assert.ok(maxAmpNb > 30000, `Outbound NB stream has vocal peaks (maxAmp: ${maxAmpNb})`);
    assert.ok(silentNb > 10000, `Outbound NB stream has natural pauses (silent: ${silentNb})`);
    assert.ok(speechNb > 10000, `Outbound NB stream has speech syllables (speech: ${speechNb})`);

    // 3. Outbound EVS SWB multi-frame stream (Stream 11334 -> 10024, 32kHz)
    const outSwbStream = result.streams.find(s => s.srcPort === 11334 && s.dstPort === 10024);
    assert.ok(outSwbStream, 'Outbound SWB stream found');
    const decodedOutSwb = await StreamAudioDecoder.decodeStream(outSwbStream, result.dialogs);

    let maxAmpSwb = 0, silentSwb = 0, speechSwb = 0;
    for (let i = 0; i < decodedOutSwb.pcm.length; i++) {
      const v = Math.abs(decodedOutSwb.pcm[i]);
      if (v > maxAmpSwb) maxAmpSwb = v;
      if (v < 50) silentSwb++;
      if (v > 1000) speechSwb++;
    }
    assert.ok(maxAmpSwb > 30000, `Outbound SWB stream has vocal peaks (maxAmp: ${maxAmpSwb})`);
    assert.ok(silentSwb > 10000, `Outbound SWB stream has natural pauses (silent: ${silentSwb})`);
    assert.ok(speechSwb > 10000, `Outbound SWB stream has speech syllables (speech: ${speechSwb})`);

    // 4. Inbound active stream (Stream 10024 -> 11334, 32kHz)
    const inSwbStream = result.streams.find(s => s.srcPort === 10024 && s.dstPort === 11334);
    assert.ok(inSwbStream, 'Inbound SWB stream found');
    const decodedInSwb = await StreamAudioDecoder.decodeStream(inSwbStream, result.dialogs);
    let maxAmpIn = 0;
    for (let i = 0; i < decodedInSwb.pcm.length; i++) {
      const v = Math.abs(decodedInSwb.pcm[i]);
      if (v > maxAmpIn) maxAmpIn = v;
    }
    assert.ok(maxAmpIn > 5000, `Inbound SWB stream has vocal peaks (maxAmp: ${maxAmpIn})`);
  });
});
