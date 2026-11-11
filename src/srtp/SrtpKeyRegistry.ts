/**
 * SrtpKeyRegistry.ts
 * Central in-memory registry for SRTP and SRTCP encryption keys.
 * Correlates keys from:
 * 1. SDP offer/answer dialogs (RFC 4568 SDES negotiation with tag selection and directional split)
 * 2. Explicit SSRC or 5-tuple associations
 * 3. Manual key entry via UI (in-memory only, strictly zero persistent storage)
 * Enforces emergency kill switch.
 */

import { SdesParser } from './SdesParser.ts';
import { SrtpContext } from './SrtpContext.ts';
import { DtlsExporter } from '../dtls/DtlsExporter.ts';
import type { DtlsHandshakeInfo } from '../dtls/DtlsParser.ts';
import type { SdesCrypto, SrtpCryptoSuite } from './SrtpTypes.ts';
import type { SipDialog } from '../sip/DialogManager.ts';

export interface KeyRecord {
  crypto: SdesCrypto;
  context: SrtpContext;
  source: 'sdp' | 'manual' | 'log';
  direction?: 'inbound' | 'outbound';
  callId?: string;
  ssrc?: number;
  srcEndpoint?: string; // ip:port
  dstEndpoint?: string; // ip:port
  startTime?: number;
  endTime?: number;
}

export class SrtpKeyRegistry {
  private static killSwitchEnabled: boolean = false;

  private ssrcMap = new Map<number, SrtpContext>();
  private endpointMap = new Map<string, SrtpContext>(); // "ip:port" -> context
  private records: KeyRecord[] = [];
  private nssKeyLogs = new Map<string, string>(); // clientRandomHex -> masterSecretHex

  /**
   * Emergency kill switch to bypass all SRTP/DTLS decryption and restore 100% baseline behavior.
   */
  public static setKillSwitch(disabled: boolean): void {
    SrtpKeyRegistry.killSwitchEnabled = disabled;
  }

  public static isKillSwitchEnabled(): boolean {
    return SrtpKeyRegistry.killSwitchEnabled;
  }

  /**
   * Clears all keys from memory (called on page reload, capture switch, or "Clear Keys").
   */
  public clear(): void {
    this.ssrcMap.clear();
    this.endpointMap.clear();
    this.records = [];
  }

  /**
   * Registers a key directly for an SSRC.
   */
  public registerSsrcKey(ssrc: number, crypto: SdesCrypto, source: 'sdp' | 'manual' | 'log' = 'manual'): void {
    const context = new SrtpContext(crypto);
    this.ssrcMap.set(ssrc, context);
    this.records.push({
      crypto,
      context,
      source,
      ssrc,
    });
  }

  /**
   * Registers a key for a sending endpoint (srcIp:srcPort).
   */
  public registerEndpointKey(ip: string, port: number, crypto: SdesCrypto, source: 'sdp' | 'manual' | 'log' = 'manual'): void {
    const context = new SrtpContext(crypto);
    const ep = `${ip}:${port}`;
    this.endpointMap.set(ep, context);
    this.records.push({
      crypto,
      context,
      source,
      srcEndpoint: ep,
    });
  }

  /**
   * Registers NSS SSLKEYLOGFILE master secret mapped to client_random.
   */
  public registerNssKeyLog(clientRandomHex: string, masterSecretHex: string): void {
    this.nssKeyLogs.set(clientRandomHex.toLowerCase(), masterSecretHex.toLowerCase());
  }

  /**
   * Derives and registers SRTP keys from a parsed DTLS 1.2 handshake if matching NSS key log is present.
   */
  public registerDtlsHandshake(info: DtlsHandshakeInfo): boolean {
    if (SrtpKeyRegistry.killSwitchEnabled) return false;
    if (!info.clientRandom || !info.serverRandom) return false;

    const crHex = Array.from(info.clientRandom).map(b => b.toString(16).padStart(2, '0')).join('').toLowerCase();
    const msHex = this.nssKeyLogs.get(crHex);
    if (!msHex) return false;

    const suite = info.negotiatedProfile || 'AES_CM_128_HMAC_SHA1_80';
    const msBytes = new Uint8Array(msHex.length / 2);
    for (let i = 0; i < msBytes.length; i++) {
      msBytes[i] = parseInt(msHex.substring(i * 2, i * 2 + 2), 16);
    }

    const exported = DtlsExporter.exportKeys(msBytes, info.clientRandom, info.serverRandom, suite);

    // Register Client -> Server key
    if (info.clientEndpoint) {
      const clientCrypto: SdesCrypto = {
        tag: 1,
        cryptoSuite: suite,
        masterKey: exported.clientKey,
        masterSalt: exported.clientSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };
      const [ip, port] = info.clientEndpoint.split(':');
      this.registerEndpointKey(ip, parseInt(port, 10), clientCrypto, 'log');
    }

    // Register Server -> Client key
    if (info.serverEndpoint) {
      const serverCrypto: SdesCrypto = {
        tag: 2,
        cryptoSuite: suite,
        masterKey: exported.serverKey,
        masterSalt: exported.serverSalt,
        unencryptedSrtp: false,
        unencryptedSrtcp: false,
        unauthenticatedSrtp: false,
        kdr: 0,
        rawInline: '',
      };
      const [ip, port] = info.serverEndpoint.split(':');
      this.registerEndpointKey(ip, parseInt(port, 10), serverCrypto, 'log');
    }

    return true;
  }

  /**
   * Extracts and correlates keys from a SIP dialog's offer and answer SDP sessions.
   * Offer crypto keys apply to the Offer -> Answer direction (Caller -> Callee).
   * Answer crypto keys apply to the Answer -> Offer direction (Callee -> Caller).
   */
  public registerSipDialog(dialog: SipDialog): void {
    if (SrtpKeyRegistry.killSwitchEnabled) return;
    if (!dialog.offer || !dialog.answer) return;

    const offerMediaList = dialog.offer.media || [];
    const answerMediaList = dialog.answer.media || [];

    const offerIp = dialog.offerMediaEndpoint?.ip || dialog.offer.connection?.address;
    const answerIp = dialog.answerMediaEndpoint?.ip || dialog.answer.connection?.address;

    for (let mIdx = 0; mIdx < offerMediaList.length; mIdx++) {
      const offerM = offerMediaList[mIdx];
      const answerM = answerMediaList[mIdx];
      if (!offerM || !answerM) continue;

      const offerCryptos = offerM.crypto || [];
      const answerCryptos = answerM.crypto || [];

      if (offerCryptos.length === 0 && answerCryptos.length === 0) continue;

      // The answer selects the tag from the offer
      let selectedOfferCrypto: SdesCrypto | null = null;
      let selectedAnswerCrypto: SdesCrypto | null = null;

      if (answerCryptos.length > 0) {
        selectedAnswerCrypto = answerCryptos[0];
        // Match offer tag with answer tag
        selectedOfferCrypto = offerCryptos.find(c => c.tag === selectedAnswerCrypto?.tag) || offerCryptos[0] || null;
      } else if (offerCryptos.length > 0) {
        selectedOfferCrypto = offerCryptos[0];
      }

      // 1. Caller -> Callee stream key
      if (selectedOfferCrypto && offerIp && offerM.port > 0) {
        const callerEp = `${offerIp}:${offerM.port}`;
        const callerCtx = new SrtpContext(selectedOfferCrypto);
        this.endpointMap.set(callerEp, callerCtx);

        this.records.push({
          crypto: selectedOfferCrypto,
          context: callerCtx,
          source: 'sdp',
          direction: 'outbound',
          callId: dialog.callId,
          srcEndpoint: callerEp,
          startTime: dialog.startTime,
          endTime: dialog.endTime,
        });
      }

      // 2. Callee -> Caller stream key
      if (selectedAnswerCrypto && answerIp && answerM.port > 0) {
        const calleeEp = `${answerIp}:${answerM.port}`;
        const calleeCtx = new SrtpContext(selectedAnswerCrypto);
        this.endpointMap.set(calleeEp, calleeCtx);

        this.records.push({
          crypto: selectedAnswerCrypto,
          context: calleeCtx,
          source: 'sdp',
          direction: 'inbound',
          callId: dialog.callId,
          srcEndpoint: calleeEp,
          startTime: dialog.startTime,
          endTime: dialog.endTime,
        });
      }
    }
  }

  /**
   * Resolves the appropriate SrtpContext for an incoming packet.
   */
  public getContextForPacket(
    ssrc: number,
    srcIp: string,
    srcPort: number,
    dstIp: string,
    dstPort: number,
    timeSec?: number
  ): SrtpContext | null {
    if (SrtpKeyRegistry.killSwitchEnabled) {
      return null;
    }

    // 1. Check exact SSRC match
    const ssrcCtx = this.ssrcMap.get(ssrc);
    if (ssrcCtx) return ssrcCtx;

    // 2. Check sending endpoint (srcIp:srcPort)
    const srcEp = `${srcIp}:${srcPort}`;
    const srcCtx = this.endpointMap.get(srcEp);
    if (srcCtx) return srcCtx;

    // 3. Check records with time-window matching (re-INVITE epochs)
    for (const rec of this.records) {
      if (rec.ssrc !== undefined && rec.ssrc === ssrc) {
        return rec.context;
      }
      if (rec.srcEndpoint && rec.srcEndpoint === srcEp) {
        if (timeSec === undefined || (rec.startTime === undefined || timeSec >= rec.startTime - 1.0)) {
          return rec.context;
        }
      }
    }

    return null;
  }

  /**
   * Returns all active key records (for UI status pills and indicators).
   */
  public getKeyRecords(): KeyRecord[] {
    return this.records;
  }
}
