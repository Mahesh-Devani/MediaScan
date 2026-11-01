import { SdpParser } from './SdpParser.ts';
import type { SdpSession } from './SdpParser.ts';

export interface SipAddress {
  raw: string;
  uri: string;
  user?: string;
  tag?: string;
  params: Record<string, string>;
}

export interface SipCSeq {
  seq: number;
  method: string;
}

export interface SipMessage {
  isRequest: boolean;
  method: string;
  statusCode?: number;
  reasonPhrase?: string;
  uri?: string;
  callId: string;
  cseq: SipCSeq;
  from: SipAddress;
  to: SipAddress;
  via: string[];
  contact?: string;
  contentType?: string;
  contentLength: number;
  conferenceId?: string;
  replaces?: string;
  headers: Map<string, string[]>;
  body: string;
  sdp?: SdpSession;
}

export class SipParser {
  private static COMPACT_HEADERS: Record<string, string> = {
    i: 'call-id',
    m: 'contact',
    f: 'from',
    t: 'to',
    v: 'via',
    c: 'content-type',
    l: 'content-length',
    k: 'supported',
    s: 'subject',
  };

  /**
   * Fast detection of whether a packet starts with SIP request or response.
   */
  public static isSip(data: Uint8Array): boolean {
    if (data.length < 10) return false;
    const str = String.fromCharCode(...data.subarray(0, 14));
    return (
      str.startsWith('SIP/2.0 ') ||
      str.startsWith('INVITE ') ||
      str.startsWith('ACK ') ||
      str.startsWith('BYE ') ||
      str.startsWith('CANCEL ') ||
      str.startsWith('OPTIONS ') ||
      str.startsWith('REGISTER ') ||
      str.startsWith('INFO ') ||
      str.startsWith('PRACK ') ||
      str.startsWith('UPDATE ') ||
      str.startsWith('NOTIFY ') ||
      str.startsWith('SUBSCRIBE ') ||
      str.startsWith('MESSAGE ')
    );
  }

  /**
   * Parse SIP message from UTF-8 byte array or string.
   */
  public static parse(input: Uint8Array | string): SipMessage | null {
    const text = typeof input === 'string' ? input : new TextDecoder('utf-8', { fatal: false }).decode(input);
    if (!text || text.length < 10) return null;

    let headerBodySplit = text.indexOf('\r\n\r\n');
    let lineEndLen = 4;
    if (headerBodySplit === -1) {
      headerBodySplit = text.indexOf('\n\n');
      lineEndLen = 2;
    }

    const headerPart = headerBodySplit !== -1 ? text.substring(0, headerBodySplit) : text;
    const bodyPart = headerBodySplit !== -1 ? text.substring(headerBodySplit + lineEndLen) : '';

    const lines = headerPart.split(/\r?\n/);
    if (lines.length === 0 || !lines[0]) return null;

    const firstLine = lines[0].trim();
    let isRequest = false;
    let method = '';
    let statusCode: number | undefined;
    let reasonPhrase: string | undefined;
    let uri: string | undefined;

    if (firstLine.startsWith('SIP/2.0 ')) {
      isRequest = false;
      const parts = firstLine.split(/\s+/);
      statusCode = parseInt(parts[1], 10);
      reasonPhrase = parts.slice(2).join(' ');
      method = `${statusCode} ${reasonPhrase}`;
    } else {
      isRequest = true;
      const parts = firstLine.split(/\s+/);
      if (parts.length >= 2) {
        method = parts[0];
        uri = parts[1];
      } else {
        return null;
      }
    }

    const headers = new Map<string, string[]>();

    // Unfold multi-line headers (RFC 3261 Section 7.3.1)
    for (let i = 1; i < lines.length; i++) {
      let line = lines[i];
      if (!line) continue;

      if ((line.startsWith(' ') || line.startsWith('\t')) && i > 1) {
        // Continuation line
        continue;
      }

      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;

      let name = line.substring(0, colonIdx).trim().toLowerCase();
      if (SipParser.COMPACT_HEADERS[name]) {
        name = SipParser.COMPACT_HEADERS[name];
      }
      const val = line.substring(colonIdx + 1).trim();

      const existing = headers.get(name);
      if (existing) {
        existing.push(val);
      } else {
        headers.set(name, [val]);
      }
    }

    const getFirst = (k: string) => headers.get(k)?.[0] || '';

    const callId = getFirst('call-id');
    const cseqRaw = getFirst('cseq');
    const cseqParts = cseqRaw.split(/\s+/);
    const cseq: SipCSeq = {
      seq: parseInt(cseqParts[0], 10) || 0,
      method: cseqParts[1] || method,
    };

    const from = SipParser.parseAddress(getFirst('from'));
    const to = SipParser.parseAddress(getFirst('to'));
    const via = headers.get('via') || [];
    const contact = getFirst('contact');
    const contentType = getFirst('content-type').toLowerCase();
    const contentLength = parseInt(getFirst('content-length'), 10) || bodyPart.length;
    const conferenceId = getFirst('conference-id') || getFirst('x-conference-id');
    const replaces = getFirst('replaces');

    let sdp: SdpSession | undefined;
    if (contentType.includes('application/sdp') && bodyPart) {
      sdp = SdpParser.parse(bodyPart);
    }

    return {
      isRequest,
      method,
      statusCode,
      reasonPhrase,
      uri,
      callId,
      cseq,
      from,
      to,
      via,
      contact,
      contentType,
      contentLength,
      conferenceId,
      replaces,
      headers,
      body: bodyPart,
      sdp,
    };
  }

  /**
   * Parse SIP From/To/Contact address: "Name" <sip:user@host:port;params>;tag=xxx
   */
  public static parseAddress(raw: string): SipAddress {
    const res: SipAddress = {
      raw,
      uri: '',
      params: {},
    };

    if (!raw) return res;

    let uriStr = raw;
    const angleStart = raw.indexOf('<');
    const angleEnd = raw.indexOf('>');

    if (angleStart !== -1 && angleEnd !== -1 && angleEnd > angleStart) {
      uriStr = raw.substring(angleStart + 1, angleEnd);
      const afterAngle = raw.substring(angleEnd + 1);
      const paramMatches = afterAngle.split(';');
      for (const p of paramMatches) {
        const eqIdx = p.indexOf('=');
        if (eqIdx !== -1) {
          const k = p.substring(0, eqIdx).trim().toLowerCase();
          const v = p.substring(eqIdx + 1).trim();
          res.params[k] = v;
          if (k === 'tag') res.tag = v;
        }
      }
    } else {
      const semiIdx = raw.indexOf(';');
      if (semiIdx !== -1) {
        uriStr = raw.substring(0, semiIdx).trim();
      }
    }

    res.uri = uriStr;

    // Extract user part from sip:user@host
    const atIdx = uriStr.indexOf('@');
    const colonIdx = uriStr.indexOf(':');
    if (atIdx !== -1 && colonIdx !== -1 && atIdx > colonIdx) {
      res.user = uriStr.substring(colonIdx + 1, atIdx);
    }

    return res;
  }
}
