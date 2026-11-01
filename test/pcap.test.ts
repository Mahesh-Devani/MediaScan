import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PcapParser } from '../src/pcap/PcapParser.ts';
import { Deduplicator } from '../src/pcap/Deduplicator.ts';
import { LinkType, EtherType, IpProtocol } from '../src/pcap/PacketTypes.ts';

describe('PcapParser & Link Layer Dissection', () => {
  it('parses classic PCAP little-endian header with microsecond resolution', () => {
    const buffer = new ArrayBuffer(24);
    const view = new DataView(buffer);
    // Magic 0xd4c3b2a1 (little endian)
    view.setUint32(0, 0xa1b2c3d4, true);
    view.setUint16(4, 2, true); // major 2
    view.setUint16(6, 4, true); // minor 4
    view.setInt32(8, 0, true);  // tz
    view.setUint32(12, 0, true); // sigfigs
    view.setUint32(16, 65535, true); // snaplen
    view.setUint32(20, LinkType.LINUX_SLL, true); // Linux cooked v1

    const parser = new PcapParser(new Uint8Array(buffer));
    const header = parser.getHeader();
    assert.equal(header.format, 'pcap');
    assert.equal(header.linkType, LinkType.LINUX_SLL);
    assert.equal(header.snaplen, 65535);
    assert.equal(header.isLittleEndian, true);
    assert.equal(header.isNano, false);
  });

  it('dissects Linux Cooked v1 (SLL) frame wrapping IPv6 and UDP', () => {
    // SLL header (16 bytes) + IPv6 header (40 bytes) + UDP header (8 bytes) + 4 bytes payload
    const totalLen = 16 + 40 + 8 + 4;
    const packetData = new Uint8Array(totalLen);
    const view = new DataView(packetData.buffer);

    // SLL header
    view.setUint16(0, 0, false); // packet type: unicast to us
    view.setUint16(2, 1, false); // ARPHRD_ETHER
    view.setUint16(4, 6, false); // link-layer address len
    // 6-13: MAC address
    view.setUint16(14, EtherType.IPv6, false); // Protocol: IPv6 (0x86dd)

    // IPv6 header at offset 16
    view.setUint32(16, 0x60000000, false); // Version 6
    view.setUint16(16 + 4, 12, false); // Payload length: 8 (UDP) + 4 (data) = 12
    packetData[16 + 6] = IpProtocol.UDP; // Next Header = UDP (17)
    packetData[16 + 7] = 64; // Hop Limit

    // Src IPv6: fd5d:d50a:8c17:2110::87e
    packetData[16 + 8] = 0xfd; packetData[16 + 9] = 0x5d;
    packetData[16 + 10] = 0xd5; packetData[16 + 11] = 0x0a;
    packetData[16 + 12] = 0x8c; packetData[16 + 13] = 0x17;
    packetData[16 + 14] = 0x21; packetData[16 + 15] = 0x10;
    packetData[16 + 22] = 0x08; packetData[16 + 23] = 0x7e;

    // Dst IPv6: fd5d:d50a:8c17:2110::547
    packetData[16 + 24] = 0xfd; packetData[16 + 25] = 0x5d;
    packetData[16 + 26] = 0xd5; packetData[16 + 27] = 0x0a;
    packetData[16 + 28] = 0x8c; packetData[16 + 29] = 0x17;
    packetData[16 + 30] = 0x21; packetData[16 + 31] = 0x10;
    packetData[16 + 38] = 0x05; packetData[16 + 39] = 0x47;

    // UDP header at offset 56
    view.setUint16(56, 10048, false); // Src Port: 10048
    view.setUint16(58, 8194, false);  // Dst Port: 8194
    view.setUint16(60, 12, false);    // Length: 12
    view.setUint16(62, 0, false);     // Checksum

    // Payload (4 bytes)
    packetData[64] = 0x80; packetData[65] = 0x00; packetData[66] = 0x12; packetData[67] = 0x34;

    const parsed = PcapParser.dissectPacket({
      frameNumber: 1,
      timestampSec: 10.5,
      capturedLength: totalLen,
      originalLength: totalLen,
      data: packetData,
    }, LinkType.LINUX_SLL);

    assert.ok(parsed.network);
    assert.equal(parsed.network.version, 6);
    assert.equal(parsed.network.srcIp, 'fd5d:d50a:8c17:2110::87e');
    assert.equal(parsed.network.dstIp, 'fd5d:d50a:8c17:2110::547');
    assert.equal(parsed.network.protocol, IpProtocol.UDP);

    assert.ok(parsed.transport);
    assert.equal(parsed.transport.protocol, 'UDP');
    assert.equal(parsed.transport.srcPort, 10048);
    assert.equal(parsed.transport.dstPort, 8194);
    assert.equal(parsed.payload.length, 4);
    assert.equal(parsed.payload[0], 0x80);
  });

  it('correctly filters duplicates with rolling window deduplicator', () => {
    const dedup = new Deduplicator(1500);
    const pkt1 = new Uint8Array([1, 2, 3, 4, 5]);
    const pkt2 = new Uint8Array([1, 2, 3, 4, 5]); // exact duplicate
    const pkt3 = new Uint8Array([1, 2, 3, 4, 6]); // different

    assert.equal(dedup.isDuplicate(pkt1), false);
    assert.equal(dedup.isDuplicate(pkt2), true);
    assert.equal(dedup.isDuplicate(pkt3), false);
  });
});
