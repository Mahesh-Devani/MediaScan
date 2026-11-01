import type { SipMessage } from './SipParser.ts';
import type { SdpSession, SdpCodec } from './SdpParser.ts';

export interface MediaEndpoint {
  ip: string;
  port: number;
}

export interface SipDialog {
  callId: string;
  state: 'Initial' | 'Early' | 'Confirmed' | 'Terminated';
  startTime: number;
  endTime: number;
  from: string;
  to: string;
  fromTag?: string;
  toTag?: string;
  requestUri?: string;
  conferenceId?: string;
  replaces?: string;
  offer?: SdpSession;
  answer?: SdpSession;
  offerMediaEndpoint?: MediaEndpoint;
  answerMediaEndpoint?: MediaEndpoint;
  offerVideoEndpoint?: MediaEndpoint;
  answerVideoEndpoint?: MediaEndpoint;
  negotiatedCodecs: SdpCodec[];
  ptime?: number;
  direction: 'sendrecv' | 'sendonly' | 'recvonly' | 'inactive';
  messages: Array<{ message: SipMessage; timestamp: number }>;
}

export class DialogManager {
  private dialogs: Map<string, SipDialog> = new Map();

  public addMessage(message: SipMessage, timestamp: number): SipDialog {
    let dialog = this.dialogs.get(message.callId);

    if (!dialog) {
      dialog = {
        callId: message.callId,
        state: 'Initial',
        startTime: timestamp,
        endTime: timestamp,
        from: message.from.user || message.from.uri,
        to: message.to.user || message.to.uri,
        fromTag: message.from.tag,
        toTag: message.to.tag,
        requestUri: message.uri,
        conferenceId: message.conferenceId,
        replaces: message.replaces,
        negotiatedCodecs: [],
        direction: 'sendrecv',
        messages: [],
      };
      this.dialogs.set(message.callId, dialog);
    }

    dialog.endTime = Math.max(dialog.endTime, timestamp);
    dialog.messages.push({ message, timestamp });

    if (message.from.tag && !dialog.fromTag) dialog.fromTag = message.from.tag;
    if (message.to.tag && !dialog.toTag) dialog.toTag = message.to.tag;

    // Handle SDP Offer / Answer
    if (message.sdp) {
      if (message.isRequest && (message.method === 'INVITE' || message.method === 'UPDATE')) {
        // Initial offer or re-INVITE offer
        dialog.offer = message.sdp;
        const audioMedia = message.sdp.media.find(m => m.type === 'audio');
        if (audioMedia) {
          const ip = audioMedia.connection?.address || message.sdp.connection?.address || '';
          if (ip && audioMedia.port > 0) {
            dialog.offerMediaEndpoint = { ip, port: audioMedia.port };
          }
          if (audioMedia.ptime) dialog.ptime = audioMedia.ptime;
          dialog.direction = audioMedia.direction;
        }

        const videoMedia = message.sdp.media.find(m => m.type === 'video');
        if (videoMedia) {
          const ip = videoMedia.connection?.address || message.sdp.connection?.address || '';
          if (ip && videoMedia.port > 0) {
            dialog.offerVideoEndpoint = { ip, port: videoMedia.port };
          }
        }
      } else if (!message.isRequest && message.statusCode && message.statusCode >= 200 && message.statusCode < 300) {
        // Answer in 200 OK
        dialog.answer = message.sdp;
        const audioMedia = message.sdp.media.find(m => m.type === 'audio');
        if (audioMedia) {
          const ip = audioMedia.connection?.address || message.sdp.connection?.address || '';
          if (ip && audioMedia.port > 0) {
            dialog.answerMediaEndpoint = { ip, port: audioMedia.port };
          }
          if (audioMedia.ptime) dialog.ptime = audioMedia.ptime;
          dialog.direction = audioMedia.direction;
        }

        const videoMedia = message.sdp.media.find(m => m.type === 'video');
        if (videoMedia) {
          const ip = videoMedia.connection?.address || message.sdp.connection?.address || '';
          if (ip && videoMedia.port > 0) {
            dialog.answerVideoEndpoint = { ip, port: videoMedia.port };
          }
        }
      } else if (message.isRequest && message.method === 'ACK' && !dialog.answer) {
        // Slow-start answer in ACK
        dialog.answer = message.sdp;
        const audioMedia = message.sdp.media.find(m => m.type === 'audio');
        if (audioMedia) {
          const ip = audioMedia.connection?.address || message.sdp.connection?.address || '';
          if (ip && audioMedia.port > 0) {
            dialog.answerMediaEndpoint = { ip, port: audioMedia.port };
          }
        }
      }

      this.updateNegotiatedCodecs(dialog);
    }

    // Update dialog state
    if (message.isRequest) {
      if (message.method === 'BYE') {
        dialog.state = 'Terminated';
      }
    } else if (message.statusCode) {
      if (message.statusCode >= 180 && message.statusCode < 200 && dialog.state === 'Initial') {
        dialog.state = 'Early';
      } else if (message.statusCode >= 200 && message.statusCode < 300) {
        dialog.state = 'Confirmed';
      } else if (message.statusCode >= 400 && dialog.state === 'Initial') {
        dialog.state = 'Terminated';
      }
    }

    return dialog;
  }

  private updateNegotiatedCodecs(dialog: SipDialog): void {
    if (!dialog.offer && !dialog.answer) return;

    const codecs = new Map<number, SdpCodec>();

    // Collect from offer
    if (dialog.offer) {
      for (const m of dialog.offer.media) {
        for (const [pt, c] of m.rtpmap) {
          codecs.set(pt, c);
        }
      }
    }

    // Override or narrow by answer
    if (dialog.answer) {
      for (const m of dialog.answer.media) {
        for (const [pt, c] of m.rtpmap) {
          codecs.set(pt, c);
        }
      }
    }

    dialog.negotiatedCodecs = Array.from(codecs.values());
  }

  public getDialogs(): SipDialog[] {
    return Array.from(this.dialogs.values());
  }

  public getMediaDialogs(): SipDialog[] {
    return Array.from(this.dialogs.values()).filter(d => 
      Boolean(d.offerMediaEndpoint || d.answerMediaEndpoint || d.offerVideoEndpoint || d.answerVideoEndpoint)
    );
  }

  public findDialogByCallId(callId: string): SipDialog | undefined {
    return this.dialogs.get(callId);
  }

  public findDialogByMediaEndpoint(ip: string, port: number): SipDialog | undefined {
    for (const d of this.dialogs.values()) {
      if (
        (d.offerMediaEndpoint?.ip === ip && d.offerMediaEndpoint?.port === port) ||
        (d.answerMediaEndpoint?.ip === ip && d.answerMediaEndpoint?.port === port) ||
        (d.offerVideoEndpoint?.ip === ip && d.offerVideoEndpoint?.port === port) ||
        (d.answerVideoEndpoint?.ip === ip && d.answerVideoEndpoint?.port === port)
      ) {
        return d;
      }
    }
    return undefined;
  }
}
