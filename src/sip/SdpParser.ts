export interface SdpOrigin {
  username: string;
  sessId: string;
  sessVersion: string;
  netType: string;
  addrType: string;
  unicastAddr: string;
}

export interface SdpConnection {
  netType: string;
  addrType: string;
  address: string;
}

export interface SdpCodec {
  pt: number;
  name: string;
  clockRate: number;
  channels?: number;
}

export interface SdpMedia {
  type: 'audio' | 'video' | 'text' | 'application' | string;
  port: number;
  protocol: string;
  formats: number[];
  connection?: SdpConnection;
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  ptime?: number;
  maxptime?: number;
  rtpmap: Map<number, SdpCodec>;
  fmtp: Map<number, string>;
}

export interface SdpSession {
  version: number;
  origin?: SdpOrigin;
  sessionName?: string;
  connection?: SdpConnection;
  media: SdpMedia[];
}

export class SdpParser {
  /**
   * Parse SDP text into structured SdpSession.
   */
  public static parse(sdpText: string): SdpSession {
    const lines = sdpText.split(/\r?\n/);
    const session: SdpSession = {
      version: 0,
      media: [],
    };

    let currentMedia: SdpMedia | null = null;
    let sessionDirection: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive' = 'sendrecv';

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.length < 2 || line[1] !== '=') {
        continue;
      }

      const type = line[0];
      const val = line.substring(2).trim();

      switch (type) {
        case 'v':
          session.version = parseInt(val, 10) || 0;
          break;

        case 'o': {
          const parts = val.split(/\s+/);
          if (parts.length >= 6) {
            session.origin = {
              username: parts[0],
              sessId: parts[1],
              sessVersion: parts[2],
              netType: parts[3],
              addrType: parts[4],
              unicastAddr: parts[5],
            };
          }
          break;
        }

        case 's':
          session.sessionName = val;
          break;

        case 'c': {
          const parts = val.split(/\s+/);
          if (parts.length >= 3) {
            const conn: SdpConnection = {
              netType: parts[0],
              addrType: parts[1],
              address: parts[2],
            };
            if (currentMedia) {
              currentMedia.connection = conn;
            } else {
              session.connection = conn;
            }
          }
          break;
        }

        case 'm': {
          const parts = val.split(/\s+/);
          if (parts.length >= 4) {
            const mediaType = parts[0];
            const port = parseInt(parts[1], 10) || 0;
            const protocol = parts[2];
            const formats = parts.slice(3).map(p => parseInt(p, 10)).filter(p => !isNaN(p));

            currentMedia = {
              type: mediaType,
              port,
              protocol,
              formats,
              direction: sessionDirection,
              rtpmap: new Map<number, SdpCodec>(),
              fmtp: new Map<number, string>(),
            };

            // Populate known static payload types
            for (const pt of formats) {
              const staticCodec = SdpParser.getStaticCodec(pt);
              if (staticCodec) {
                currentMedia.rtpmap.set(pt, staticCodec);
              }
            }

            session.media.push(currentMedia);
          }
          break;
        }

        case 'a': {
          if (!currentMedia) {
            if (val === 'sendrecv' || val === 'sendonly' || val === 'recvonly' || val === 'inactive') {
              sessionDirection = val;
            }
            break;
          }

          if (val === 'sendrecv' || val === 'sendonly' || val === 'recvonly' || val === 'inactive') {
            currentMedia.direction = val;
          } else if (val.startsWith('rtpmap:')) {
            const rtpmapStr = val.substring(7).trim();
            const spaceIdx = rtpmapStr.indexOf(' ');
            if (spaceIdx > 0) {
              const pt = parseInt(rtpmapStr.substring(0, spaceIdx), 10);
              const codecInfo = rtpmapStr.substring(spaceIdx + 1).trim();
              const parts = codecInfo.split('/');
              const name = parts[0];
              const clockRate = parseInt(parts[1], 10) || 8000;
              const channels = parts.length > 2 ? parseInt(parts[2], 10) : undefined;

              currentMedia.rtpmap.set(pt, { pt, name, clockRate, channels });
            }
          } else if (val.startsWith('fmtp:')) {
            const fmtpStr = val.substring(5).trim();
            const spaceIdx = fmtpStr.indexOf(' ');
            if (spaceIdx > 0) {
              const pt = parseInt(fmtpStr.substring(0, spaceIdx), 10);
              const params = fmtpStr.substring(spaceIdx + 1).trim();
              currentMedia.fmtp.set(pt, params);
            }
          } else if (val.startsWith('ptime:')) {
            currentMedia.ptime = parseInt(val.substring(6).trim(), 10);
          } else if (val.startsWith('maxptime:')) {
            currentMedia.maxptime = parseInt(val.substring(9).trim(), 10);
          }
          break;
        }
      }
    }

    return session;
  }

  /**
   * RFC 3551 standard static payload types.
   */
  public static getStaticCodec(pt: number): SdpCodec | null {
    switch (pt) {
      case 0: return { pt: 0, name: 'PCMU', clockRate: 8000, channels: 1 };
      case 3: return { pt: 3, name: 'GSM', clockRate: 8000, channels: 1 };
      case 4: return { pt: 4, name: 'G723', clockRate: 8000, channels: 1 };
      case 5: return { pt: 5, name: 'DVI4', clockRate: 8000, channels: 1 };
      case 6: return { pt: 6, name: 'DVI4', clockRate: 16000, channels: 1 };
      case 7: return { pt: 7, name: 'LPC', clockRate: 8000, channels: 1 };
      case 8: return { pt: 8, name: 'PCMA', clockRate: 8000, channels: 1 };
      case 9: return { pt: 9, name: 'G722', clockRate: 8000, channels: 1 }; // note: RFC 3551 sets clock rate to 8000 for G722 although sampling is 16kHz
      case 10: return { pt: 10, name: 'L16', clockRate: 44100, channels: 2 };
      case 11: return { pt: 11, name: 'L16', clockRate: 44100, channels: 1 };
      case 12: return { pt: 12, name: 'QCELP', clockRate: 8000, channels: 1 };
      case 13: return { pt: 13, name: 'CN', clockRate: 8000, channels: 1 };
      case 14: return { pt: 14, name: 'MPA', clockRate: 90000 };
      case 15: return { pt: 15, name: 'G728', clockRate: 8000, channels: 1 };
      case 16: return { pt: 16, name: 'DVI4', clockRate: 11025, channels: 1 };
      case 17: return { pt: 17, name: 'DVI4', clockRate: 22050, channels: 1 };
      case 18: return { pt: 18, name: 'G729', clockRate: 8000, channels: 1 };
      case 26: return { pt: 26, name: 'JPEG', clockRate: 90000 };
      case 31: return { pt: 31, name: 'H261', clockRate: 90000 };
      case 32: return { pt: 32, name: 'MPV', clockRate: 90000 };
      case 33: return { pt: 33, name: 'MP2T', clockRate: 90000 };
      case 34: return { pt: 34, name: 'H263', clockRate: 90000 };
      default: return null;
    }
  }
}
