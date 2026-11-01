import {
  LinkType,
  EtherType,
  IpProtocol,
} from './PacketTypes.ts';
import type {
  CapturedPacket,
  DissectedPacket,
  NetworkHeader,
  TransportHeader,
} from './PacketTypes.ts';

export interface PcapHeader {
  format: 'pcap' | 'pcapng';
  linkType: LinkType;
  snaplen: number;
  isLittleEndian: boolean;
  isNano: boolean;
}

export class PcapParser {
  private data: Uint8Array;
  private view: DataView;
  private offset: number = 0;
  private header!: PcapHeader;
  private frameCount: number = 0;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    this.parseFileHeader();
  }

  public getHeader(): PcapHeader {
    return this.header;
  }

  private parseFileHeader(): void {
    if (this.view.byteLength < 24) {
      throw new Error('Capture file is too short to contain a valid header');
    }

    const magic = this.view.getUint32(0, false);

    // Classic PCAP
    if (magic === 0xa1b2c3d4) {
      this.header = { format: 'pcap', linkType: this.view.getUint32(20, false) as LinkType, snaplen: this.view.getUint32(16, false), isLittleEndian: false, isNano: false };
      this.offset = 24;
    } else if (magic === 0xd4c3b2a1) {
      this.header = { format: 'pcap', linkType: this.view.getUint32(20, true) as LinkType, snaplen: this.view.getUint32(16, true), isLittleEndian: true, isNano: false };
      this.offset = 24;
    } else if (magic === 0xa1b23c4d) {
      this.header = { format: 'pcap', linkType: this.view.getUint32(20, false) as LinkType, snaplen: this.view.getUint32(16, false), isLittleEndian: false, isNano: true };
      this.offset = 24;
    } else if (magic === 0x4d3c2b1a) {
      this.header = { format: 'pcap', linkType: this.view.getUint32(20, true) as LinkType, snaplen: this.view.getUint32(16, true), isLittleEndian: true, isNano: true };
      this.offset = 24;
    }
    // PCAPNG Section Header Block (SHB: 0x0A0D0D0A)
    else if (magic === 0x0a0d0d0a) {
      const bom = this.view.getUint32(8, false);
      const isLittleEndian = (bom === 0x4d3c2b1a) || (bom === 0x1a2b3c4d && this.view.getUint32(8, true) === 0x1a2b3c4d);
      const le = isLittleEndian;
      this.header = { format: 'pcapng', linkType: LinkType.ETHERNET, snaplen: 65535, isLittleEndian: le, isNano: false };
      this.offset = 0; // PCAPNG reads block by block
    } else {
      throw new Error(`Unrecognized capture magic number: 0x${magic.toString(16)}`);
    }
  }

  /**
   * Reads next packet from the buffer. Returns null when EOF is reached.
   */
  public nextPacket(): CapturedPacket | null {
    if (this.header.format === 'pcap') {
      return this.nextClassicPacket();
    } else {
      return this.nextPcapNgPacket();
    }
  }

  private nextClassicPacket(): CapturedPacket | null {
    if (this.offset + 16 > this.view.byteLength) {
      return null;
    }

    const le = this.header.isLittleEndian;
    const tsSec = this.view.getUint32(this.offset, le);
    const tsUsec = this.view.getUint32(this.offset + 4, le);
    const inclLen = this.view.getUint32(this.offset + 8, le);
    const origLen = this.view.getUint32(this.offset + 12, le);
    this.offset += 16;

    if (this.offset + inclLen > this.view.byteLength) {
      return null;
    }

    const packetData = this.data.subarray(this.offset, this.offset + inclLen);
    this.offset += inclLen;
    this.frameCount++;

    const timestampSec = this.header.isNano ? (tsSec + tsUsec / 1e9) : (tsSec + tsUsec / 1e6);

    return {
      frameNumber: this.frameCount,
      timestampSec,
      capturedLength: inclLen,
      originalLength: origLen,
      data: packetData,
    };
  }

  private nextPcapNgPacket(): CapturedPacket | null {
    const le = this.header.isLittleEndian;
    while (this.offset + 8 <= this.view.byteLength) {
      const blockType = this.view.getUint32(this.offset, le);
      const blockTotalLength = this.view.getUint32(this.offset + 4, le);

      if (blockTotalLength < 12 || this.offset + blockTotalLength > this.view.byteLength) {
        return null;
      }

      // Section Header Block (0x0A0D0D0A)
      if (blockType === 0x0a0d0d0a) {
        // Skip SHB body
        this.offset += blockTotalLength;
        continue;
      }

      // Interface Description Block (0x00000001)
      if (blockType === 0x00000001) {
        const linkType = this.view.getUint16(this.offset + 8, le) as LinkType;
        const snaplen = this.view.getUint32(this.offset + 12, le);
        this.header.linkType = linkType;
        this.header.snaplen = snaplen || 65535;
        this.offset += blockTotalLength;
        continue;
      }

      // Enhanced Packet Block (0x00000006)
      if (blockType === 0x00000006) {
        const tsHigh = this.view.getUint32(this.offset + 12, le);
        const tsLow = this.view.getUint32(this.offset + 16, le);
        const capLen = this.view.getUint32(this.offset + 20, le);
        const origLen = this.view.getUint32(this.offset + 24, le);
        const packetData = this.data.subarray(this.offset + 28, this.offset + 28 + capLen);

        this.frameCount++;
        this.offset += blockTotalLength;

        // Default resolution is microsecond (1e-6)
        const tsUnits = (BigInt(tsHigh) << 32n) | BigInt(tsLow);
        const timestampSec = Number(tsUnits) / 1e6;

        return {
          frameNumber: this.frameCount,
          timestampSec,
          capturedLength: capLen,
          originalLength: origLen,
          data: packetData,
        };
      }

      // Simple Packet Block (0x00000003)
      if (blockType === 0x00000003) {
        const origLen = this.view.getUint32(this.offset + 8, le);
        const capLen = Math.min(origLen, blockTotalLength - 16);
        const packetData = this.data.subarray(this.offset + 12, this.offset + 12 + capLen);

        this.frameCount++;
        this.offset += blockTotalLength;

        return {
          frameNumber: this.frameCount,
          timestampSec: 0,
          capturedLength: capLen,
          originalLength: origLen,
          data: packetData,
        };
      }

      // Skip unhandled blocks
      this.offset += blockTotalLength;
    }
    return null;
  }

  /**
   * Dissects Link, Network (IPv4/IPv6), and Transport (UDP/TCP) layers from a captured packet.
   */
  public static dissectPacket(packet: CapturedPacket, linkType: LinkType): DissectedPacket {
    const raw = packet.data;
    let offset = 0;
    let etherType: number = 0;

    // 1. Link Layer Dissection
    if (linkType === LinkType.ETHERNET) {
      if (raw.length < 14) {
        return { ...packet, payload: raw };
      }
      etherType = (raw[12] << 8) | raw[13];
      offset = 14;

      // Handle 802.1Q VLAN tags
      while ((etherType === EtherType.VLAN_8021Q || etherType === EtherType.VLAN_8021AD) && offset + 4 <= raw.length) {
        etherType = (raw[offset + 2] << 8) | raw[offset + 3];
        offset += 4;
      }
    } else if (linkType === LinkType.LINUX_SLL) {
      // Linux Cooked-Mode v1: 16 bytes header
      if (raw.length < 16) {
        return { ...packet, payload: raw };
      }
      etherType = (raw[14] << 8) | raw[15];
      offset = 16;
    } else if (linkType === LinkType.LINUX_SLL2) {
      // Linux Cooked-Mode v2: 20 bytes header
      if (raw.length < 20) {
        return { ...packet, payload: raw };
      }
      etherType = (raw[0] << 8) | raw[1];
      offset = 20;
    } else if (linkType === LinkType.RAW_IP) {
      // Raw IP: check version directly
      const ver = raw[0] >> 4;
      etherType = ver === 6 ? EtherType.IPv6 : EtherType.IPv4;
      offset = 0;
    } else if (linkType === LinkType.NULL) {
      if (raw.length < 4) {
        return { ...packet, payload: raw };
      }
      const family = raw[0];
      etherType = family === 2 ? EtherType.IPv4 : (family === 24 || family === 28 || family === 30) ? EtherType.IPv6 : 0;
      offset = 4;
    }

    // 2. Network Layer Dissection
    let network: NetworkHeader | undefined;

    if (etherType === EtherType.IPv4 && offset + 20 <= raw.length) {
      const verIhl = raw[offset];
      const ihl = (verIhl & 0x0f) * 4;
      if (ihl >= 20 && offset + ihl <= raw.length) {
        const totalLen = (raw[offset + 2] << 8) | raw[offset + 3];
        const ident = (raw[offset + 4] << 8) | raw[offset + 5];
        const flagsFrag = (raw[offset + 6] << 8) | raw[offset + 7];
        const moreFragments = Boolean(flagsFrag & 0x2000);
        const fragOffset = (flagsFrag & 0x1fff) * 8;
        const ttl = raw[offset + 8];
        const protocol = raw[offset + 9];

        const srcIp = `${raw[offset + 12]}.${raw[offset + 13]}.${raw[offset + 14]}.${raw[offset + 15]}`;
        const dstIp = `${raw[offset + 16]}.${raw[offset + 17]}.${raw[offset + 18]}.${raw[offset + 19]}`;

        const payloadOffset = offset + ihl;
        const payloadLength = Math.max(0, Math.min(raw.length, offset + totalLen) - payloadOffset);

        network = {
          version: 4,
          srcIp,
          dstIp,
          protocol,
          hopLimit: ttl,
          payloadOffset,
          payloadLength,
          identification: ident,
          isFragment: moreFragments || fragOffset > 0,
          fragmentOffset: fragOffset,
          moreFragments,
        };
        offset = payloadOffset;
      }
    } else if (etherType === EtherType.IPv6 && offset + 40 <= raw.length) {
      const payloadLen = (raw[offset + 4] << 8) | raw[offset + 5];
      let nextHeader = raw[offset + 6];
      const hopLimit = raw[offset + 7];

      const srcIp = PcapParser.formatIpv6(raw, offset + 8);
      const dstIp = PcapParser.formatIpv6(raw, offset + 24);

      offset += 40;
      let isFragment = false;
      let fragOffset = 0;
      let moreFragments = false;
      let ident: number | undefined;

      // Skip IPv6 Extension Headers
      while (
        (nextHeader === IpProtocol.HOPOPT ||
         nextHeader === IpProtocol.IPV6_ROUTE ||
         nextHeader === IpProtocol.IPV6_OPTS ||
         nextHeader === IpProtocol.IPV6_FRAG) &&
        offset + 8 <= raw.length
      ) {
        const currNext = raw[offset];
        if (nextHeader === IpProtocol.IPV6_FRAG) {
          isFragment = true;
          const fragVal = (raw[offset + 2] << 8) | raw[offset + 3];
          fragOffset = (fragVal & 0xfff8);
          moreFragments = Boolean(fragVal & 0x0001);
          ident = (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
          offset += 8;
        } else {
          const extLen = (raw[offset + 1] + 1) * 8;
          offset += extLen;
        }
        nextHeader = currNext;
      }

      const payloadLength = Math.max(0, Math.min(raw.length - offset, payloadLen));

      network = {
        version: 6,
        srcIp,
        dstIp,
        protocol: nextHeader,
        hopLimit,
        payloadOffset: offset,
        payloadLength,
        identification: ident,
        isFragment,
        fragmentOffset: fragOffset,
        moreFragments,
      };
    }

    if (!network || network.isFragment && network.fragmentOffset! > 0) {
      return {
        ...packet,
        network,
        payload: raw.subarray(offset),
      };
    }

    // 3. Transport Layer Dissection
    let transport: TransportHeader | undefined;

    if (network.protocol === IpProtocol.UDP && offset + 8 <= raw.length) {
      const srcPort = (raw[offset] << 8) | raw[offset + 1];
      const dstPort = (raw[offset + 2] << 8) | raw[offset + 3];
      const udpLen = (raw[offset + 4] << 8) | raw[offset + 5];

      const payloadOffset = offset + 8;
      const payloadLength = Math.max(0, Math.min(raw.length, offset + udpLen) - payloadOffset);

      transport = {
        protocol: 'UDP',
        srcPort,
        dstPort,
        payloadOffset,
        payloadLength,
      };
      offset = payloadOffset;
    } else if (network.protocol === IpProtocol.TCP && offset + 20 <= raw.length) {
      const srcPort = (raw[offset] << 8) | raw[offset + 1];
      const dstPort = (raw[offset + 2] << 8) | raw[offset + 3];
      const seq = (raw[offset + 4] << 24) | (raw[offset + 5] << 16) | (raw[offset + 6] << 8) | raw[offset + 7];
      const ack = (raw[offset + 8] << 24) | (raw[offset + 9] << 16) | (raw[offset + 10] << 8) | raw[offset + 11];
      const dataOffset = ((raw[offset + 12] >> 4) & 0x0f) * 4;
      const flags = raw[offset + 13];

      const payloadOffset = offset + dataOffset;
      const payloadLength = Math.max(0, raw.length - payloadOffset);

      transport = {
        protocol: 'TCP',
        srcPort,
        dstPort,
        payloadOffset,
        payloadLength,
        tcpSeq: seq >>> 0,
        tcpAck: ack >>> 0,
        tcpFlags: {
          syn: Boolean(flags & 0x02),
          ack: Boolean(flags & 0x10),
          fin: Boolean(flags & 0x01),
          rst: Boolean(flags & 0x04),
          psh: Boolean(flags & 0x08),
        },
      };
      offset = payloadOffset;
    }

    return {
      ...packet,
      network,
      transport,
      payload: raw.subarray(offset),
    };
  }

  /**
   * Formats 16 bytes into RFC 5952 canonical IPv6 string with :: compression.
   */
  public static formatIpv6(data: Uint8Array, offset: number): string {
    const words: number[] = [];
    for (let i = 0; i < 8; i++) {
      words.push((data[offset + i * 2] << 8) | data[offset + i * 2 + 1]);
    }

    // Find longest contiguous run of zeros for ::
    let bestStart = -1;
    let bestLen = 0;
    let currStart = -1;
    let currLen = 0;

    for (let i = 0; i < 8; i++) {
      if (words[i] === 0) {
        if (currStart === -1) currStart = i;
        currLen++;
        if (currLen > bestLen) {
          bestStart = currStart;
          bestLen = currLen;
        }
      } else {
        currStart = -1;
        currLen = 0;
      }
    }

    if (bestLen < 2) {
      return words.map(w => w.toString(16)).join(':');
    }

    const before = words.slice(0, bestStart).map(w => w.toString(16)).join(':');
    const after = words.slice(bestStart + bestLen).map(w => w.toString(16)).join(':');
    return `${before}::${after}`;
  }
}
