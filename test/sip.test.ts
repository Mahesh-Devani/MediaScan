import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SipParser } from '../src/sip/SipParser.ts';
import { SdpParser } from '../src/sip/SdpParser.ts';
import { DialogManager } from '../src/sip/DialogManager.ts';

describe('SipParser & SdpParser', () => {
  const rawInvite = 
`INVITE sip:msml@[fd5d:d50a:8c17:2140::548]:5060 SIP/2.0\r
Via: SIP/2.0/UDP [fd5d:d50a:8c17:2140::54d]:5060;branch=z9hG4bK*002e-0137\r
From: <sip:user@[fd5d:d50a:8c17:2140::87e]>;tag=user-tag-123\r
To: <sip:msml@[fd5d:d50a:8c17:2140::54d]:5060>\r
Call-ID: call-abc-123@[fd5d:d50a:8c17:2140::87e]:5065\r
CSeq: 100 INVITE\r
Contact: <sip:user@[fd5d:d50a:8c17:2140::87e]:5065>\r
Content-Type: application/sdp\r
Content-Length: 216\r
\r
v=0\r
o=- 5065 26 IN IP6 fd5d:d50a:8c17:2140::87e\r
s=Media Session\r
c=IN IP6 fd5d:d50a:8c17:2110::87e\r
t=0 0\r
m=audio 10048 RTP/AVP 0 101\r
a=rtpmap:0 PCMU/8000\r
a=rtpmap:101 telephone-event/8000\r
a=fmtp:101 0-15\r
a=ptime:20\r
a=sendrecv\r
`;

  const raw200Ok = 
`SIP/2.0 200 OK\r
Via: SIP/2.0/UDP [fd5d:d50a:8c17:2140::54d]:5060;branch=z9hG4bK*002e-0137\r
From: <sip:user@[fd5d:d50a:8c17:2140::87e]>;tag=user-tag-123\r
To: <sip:msml@[fd5d:d50a:8c17:2140::54d]:5060>;tag=msml-tag-456\r
Call-ID: call-abc-123@[fd5d:d50a:8c17:2140::87e]:5065\r
CSeq: 100 INVITE\r
Content-Type: application/sdp\r
Content-Length: 216\r
\r
v=0\r
o=- 61080 61080 IN IP6 fd5d:d50a:8c17:2140::548\r
s=Media Server\r
c=IN IP6 fd5d:d50a:8c17:2110::547\r
t=0 0\r
m=audio 8194 RTP/AVP 0\r
a=rtpmap:0 PCMU/8000\r
a=ptime:20\r
a=sendrecv\r
`;

  it('parses SIP INVITE request and its embedded SDP', () => {
    const sip = SipParser.parse(new TextEncoder().encode(rawInvite));
    assert.ok(sip);
    assert.equal(sip.isRequest, true);
    assert.equal(sip.method, 'INVITE');
    assert.equal(sip.callId, 'call-abc-123@[fd5d:d50a:8c17:2140::87e]:5065');
    assert.equal(sip.from.user, 'user');
    assert.equal(sip.from.tag, 'user-tag-123');
    assert.equal(sip.cseq.seq, 100);
    assert.equal(sip.cseq.method, 'INVITE');

    assert.ok(sip.sdp);
    assert.equal(sip.sdp.connection?.address, 'fd5d:d50a:8c17:2110::87e');
    assert.equal(sip.sdp.media.length, 1);

    const audio = sip.sdp.media[0];
    assert.equal(audio.type, 'audio');
    assert.equal(audio.port, 10048);
    assert.equal(audio.direction, 'sendrecv');
    assert.equal(audio.ptime, 20);
    assert.equal(audio.rtpmap.get(0)?.name, 'PCMU');
    assert.equal(audio.rtpmap.get(0)?.clockRate, 8000);
    assert.equal(audio.rtpmap.get(101)?.name, 'telephone-event');
  });

  it('parses SIP 200 OK response with Media Server SDP answer', () => {
    const sip = SipParser.parse(new TextEncoder().encode(raw200Ok));
    assert.ok(sip);
    assert.equal(sip.isRequest, false);
    assert.equal(sip.statusCode, 200);
    assert.equal(sip.reasonPhrase, 'OK');
    assert.equal(sip.to.tag, 'msml-tag-456');

    assert.ok(sip.sdp);
    assert.equal(sip.sdp.connection?.address, 'fd5d:d50a:8c17:2110::547');
    assert.equal(sip.sdp.media[0].port, 8194);
    assert.equal(sip.sdp.media[0].rtpmap.get(0)?.name, 'PCMU');
  });

  it('DialogManager correlates offer and answer into a dialog session', () => {
    const dm = new DialogManager();
    const inv = SipParser.parse(new TextEncoder().encode(rawInvite))!;
    const ok = SipParser.parse(new TextEncoder().encode(raw200Ok))!;

    dm.addMessage(inv, 1.0);
    dm.addMessage(ok, 1.2);

    const dialogs = dm.getDialogs();
    assert.equal(dialogs.length, 1);
    const d = dialogs[0];
    assert.equal(d.callId, 'call-abc-123@[fd5d:d50a:8c17:2140::87e]:5065');
    assert.equal(d.state, 'Confirmed');
    assert.ok(d.offer);
    assert.ok(d.answer);
    assert.equal(d.offerMediaEndpoint?.ip, 'fd5d:d50a:8c17:2110::87e');
    assert.equal(d.offerMediaEndpoint?.port, 10048);
    assert.equal(d.answerMediaEndpoint?.ip, 'fd5d:d50a:8c17:2110::547');
    assert.equal(d.answerMediaEndpoint?.port, 8194);
  });
});
