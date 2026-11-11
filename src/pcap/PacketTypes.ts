export const LinkType = {
  NULL: 0,
  ETHERNET: 1,
  RAW_IP: 12,
  LINUX_SLL: 113,     // Linux cooked-mode v1
  LINUX_SLL2: 276,    // Linux cooked-mode v2
  IEEE802_11: 105,
} as const;
export type LinkType = typeof LinkType[keyof typeof LinkType];

export const EtherType = {
  IPv4: 0x0800,
  ARP: 0x0806,
  VLAN_8021Q: 0x8100,
  VLAN_8021AD: 0x88a8,
  IPv6: 0x86dd,
} as const;
export type EtherType = typeof EtherType[keyof typeof EtherType];

export const IpProtocol = {
  HOPOPT: 0,
  ICMP: 1,
  IGMP: 2,
  TCP: 6,
  UDP: 17,
  IPV6_ROUTE: 43,
  IPV6_FRAG: 44,
  ICMPv6: 58,
  IPV6_NONXT: 59,
  IPV6_OPTS: 60,
} as const;
export type IpProtocol = typeof IpProtocol[keyof typeof IpProtocol];

export interface CapturedPacket {
  frameNumber: number;
  timestampSec: number; // Unix epoch or relative seconds (floating point with micro/nano precision)
  capturedLength: number;
  originalLength: number;
  data: Uint8Array;
  fileOffset?: number;
}

export interface NetworkHeader {
  version: 4 | 6;
  srcIp: string;
  dstIp: string;
  protocol: number;
  hopLimit: number;
  payloadOffset: number;
  payloadLength: number;
  identification?: number;
  isFragment?: boolean;
  fragmentOffset?: number;
  moreFragments?: boolean;
}

export interface TransportHeader {
  protocol: 'UDP' | 'TCP' | 'OTHER';
  srcPort: number;
  dstPort: number;
  payloadOffset: number;
  payloadLength: number;
  // TCP specific
  tcpSeq?: number;
  tcpAck?: number;
  tcpFlags?: {
    syn: boolean;
    ack: boolean;
    fin: boolean;
    rst: boolean;
    psh: boolean;
  };
}

export interface DissectedPacket extends CapturedPacket {
  network?: NetworkHeader;
  transport?: TransportHeader;
  payload: Uint8Array;
}
