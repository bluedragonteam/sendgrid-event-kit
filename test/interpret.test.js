import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  customArgsOf, eventTime, interpretEvent, interpretEvents, isMachineOpenTime, isUnknownRecipient, messageIdOf, readerIp
} from '../src/index.js';

const sentAt = new Date('2026-11-20T15:00:00.400Z');
const seconds = (iso) => Math.floor(new Date(iso).getTime() / 1000);
const base = (fields) => ({
  email: 'Ada@Example.com',
  timestamp: seconds('2026-11-20T18:00:00Z'),
  sg_event_id: 'evt-1',
  sg_message_id: 'abc123.filterdrecv-1-2-3',
  ...fields
});

test('an open seconds after sending is a machine; a later one is a person', () => {
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T15:00:03Z')), true);
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T15:00:19Z')), true);
  // Event times are whole seconds, so they can land just before sentAt
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T15:00:00Z')), true);
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T15:00:31Z')), false);
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T18:00:00Z')), false);
});

test('without a send time nothing is ruled a machine; the window is configurable', () => {
  assert.equal(isMachineOpenTime(null, new Date()), false);
  assert.equal(isMachineOpenTime('not a date', new Date()), false);
  assert.equal(isMachineOpenTime(sentAt, new Date('2026-11-20T15:00:45Z'), 60_000), true);
});

test('an open long before a follow-up was sent is not blamed on the follow-up', () => {
  const followUp = new Date('2026-11-23T15:00:00Z');
  assert.equal(isMachineOpenTime(followUp, new Date('2026-11-21T09:00:00Z')), false);
});

test("an open's IP is kept unless a mail proxy fetched the image", () => {
  assert.equal(readerIp({ ip: '198.51.100.4', useragent: 'Mozilla/5.0 (Windows NT 10.0) Outlook' }), '198.51.100.4');
  assert.equal(readerIp({ ip: '66.249.84.1', useragent: 'Mozilla/5.0 (Windows NT 5.1; rv:11.0) Gecko Firefox/11.0 (via ggpht.com GoogleImageProxy)' }), null);
  assert.equal(readerIp({ ip: '74.6.1.1', useragent: 'YahooMailProxy; https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html' }), null);
  assert.equal(readerIp({ ip: '  ' }), null);
  assert.equal(readerIp({ ip: 'x'.repeat(65) }), null);
  assert.equal(readerIp({}), null);
});

test('timestamps: seconds, milliseconds, missing', () => {
  assert.equal(eventTime({ timestamp: 1600112492 }).toISOString(), '2020-09-14T19:41:32.000Z');
  assert.equal(eventTime({ timestamp: 1591726752372 }).toISOString(), '2020-06-09T18:19:12.372Z');
  assert.equal(eventTime({}), null);
  const now = new Date('2026-01-01T00:00:00Z');
  assert.equal(interpretEvent({ event: 'delivered' }, { now }).at.getTime(), now.getTime());
});

test('delivered: normalized email, time, message id and custom args', () => {
  const result = interpretEvent(base({ event: 'delivered', response: '250 OK', contactId: 'c1', campaign: 'spring' }));
  assert.equal(result.type, 'delivered');
  assert.equal(result.email, 'ada@example.com');
  assert.equal(result.at.toISOString(), '2026-11-20T18:00:00.000Z');
  assert.equal(result.messageId, 'abc123');
  assert.equal(result.eventId, 'evt-1');
  assert.equal(result.reason, '250 OK');
  assert.deepEqual(result.customArgs, { contactId: 'c1', campaign: 'spring' });
  assert.deepEqual(result.suppress, { address: false, reason: null });
});

test('custom args: top-level keys and nested unique_args / custom_args', () => {
  assert.deepEqual(customArgsOf({ event: 'open', email: 'a@b.c', unique_args: { a: '1' }, custom_args: { b: '2' }, c: '3' }), { a: '1', b: '2', c: '3' });
  assert.deepEqual(customArgsOf(null), {});
  assert.equal(messageIdOf({ sg_message_id: 'plain' }), 'plain');
  assert.equal(messageIdOf({}), null);
});

test('open: a person, with the reader IP', () => {
  const result = interpretEvent(base({ event: 'open', ip: '198.51.100.4', useragent: 'Thunderbird' }), { sentAt });
  assert.equal(result.type, 'open');
  assert.equal(result.ip, '198.51.100.4');
});

test('open through the Gmail image proxy: a person, but no IP', () => {
  const result = interpretEvent(base({ event: 'open', ip: '66.249.84.1', useragent: 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)' }), { sentAt });
  assert.equal(result.type, 'open');
  assert.equal(result.ip, null);
});

test('open flagged sg_machine_open (Apple MPP) is a machine open', () => {
  const result = interpretEvent(base({ event: 'open', sg_machine_open: true, ip: '17.58.0.1' }), { sentAt });
  assert.equal(result.type, 'machine_open');
  assert.equal(result.reason, 'apple_mpp');
  assert.equal(result.ip, null);
  assert.equal(interpretEvent(base({ event: 'open', sg_machine_open: false }), { sentAt }).type, 'open');
});

test('open within the window after the send or the follow-up is a machine open', () => {
  const quick = base({ event: 'open', timestamp: seconds('2026-11-20T15:00:05Z') });
  assert.equal(interpretEvent(quick, { sentAt }).type, 'machine_open');
  assert.equal(interpretEvent(quick, { sentAt }).reason, 'too_soon_after_send');
  assert.equal(interpretEvent(quick).type, 'open', 'no send time, no time-based guess');

  const afterFollowUp = base({ event: 'open', timestamp: seconds('2026-11-23T09:00:10Z') });
  assert.equal(interpretEvent(afterFollowUp, { sentAt, followUpSentAt: '2026-11-23T09:00:00Z' }).type, 'machine_open');
  assert.equal(interpretEvent(afterFollowUp, { sentAt, followUpSentAt: '2026-11-23T09:00:00Z', machineOpenWindowMs: 5000 }).type, 'open');
});

test('click: url, reader IP, and implies an open', () => {
  const result = interpretEvent(base({ event: 'click', url: 'https://example.com/pricing', ip: '203.0.113.9', useragent: 'Chrome' }), { sentAt });
  assert.equal(result.type, 'click');
  assert.equal(result.url, 'https://example.com/pricing');
  assert.equal(result.ip, '203.0.113.9');
  assert.equal(result.impliesOpen, true);
});

test('bounce: the address is suppressed', () => {
  const result = interpretEvent(base({ event: 'bounce', type: 'bounce', reason: '550 5.1.1 User unknown', bounce_classification: 'Invalid Address' }));
  assert.equal(result.type, 'bounce');
  assert.equal(result.reason, '550 5.1.1 User unknown');
  assert.equal(result.classification, 'Invalid Address');
  assert.deepEqual(result.suppress, { address: true, reason: 'bounce' });
  assert.equal(interpretEvent(base({ event: 'bounce' })).reason, 'bounced');
});

test('blocked bounce is about the sender: not suppressed', () => {
  const result = interpretEvent(base({ event: 'bounce', type: 'blocked', reason: '554 5.7.1 Message rejected due to reputation', bounce_classification: 'Reputation' }));
  assert.equal(result.type, 'sender_block');
  assert.equal(result.classification, 'Reputation');
  assert.deepEqual(result.suppress, { address: false, reason: null });
  assert.equal(interpretEvent(base({ event: 'bounce', type: 'blocked' })).reason, 'rejected by the receiving server');
});

test('blocked bounce that says the address does not exist is a bounce', () => {
  // Proofpoint's reply for an unknown mailbox, which SendGrid reported as "blocked"
  const result = interpretEvent(base({ event: 'bounce', type: 'blocked', reason: '550 #5.1.0 Address rejected.' }));
  assert.equal(result.type, 'bounce');
  assert.equal(result.reason, '550 #5.1.0 Address rejected.');
  assert.deepEqual(result.suppress, { address: true, reason: 'bounce' });
  assert.equal(interpretEvent(base({ event: 'bounce', type: 'blocked', reason: '550 rejected', bounce_classification: 'Invalid Address' })).type, 'bounce');
});

test('isUnknownRecipient: the address, not the sender', () => {
  for (const reason of [
    '550 #5.1.0 Address rejected.',
    '550 5.1.1 User Unknown',
    '550 5.1.1 <a@b.com>: Recipient address rejected: User unknown in virtual mailbox table',
    '550 No such user here',
    '550 Requested action not taken: mailbox unavailable',
    '554 5.1.10 Recipient address has null MX'
  ]) assert.equal(isUnknownRecipient(reason), true, reason);
  for (const reason of [
    '554 5.7.1 Message rejected due to reputation',
    '550 5.1.8 Sender address rejected: Domain not found',
    '550 5.7.1 Recipient address rejected: client blocked using zen.spamhaus.org',
    '550 5.7.1 Message rejected by policy',
    '421 Too many connections',
    '550 5.7.26 Unauthenticated email is not accepted (DMARC)',
    '',
    null
  ]) assert.equal(isUnknownRecipient(reason), false, String(reason));
});

test('dropped: suppression follows the reason', () => {
  const drop = (reason) => interpretEvent(base({ event: 'dropped', reason }));
  assert.deepEqual(drop('Bounced Address').suppress, { address: true, reason: 'bounce' });
  assert.deepEqual(drop('Invalid').suppress, { address: true, reason: 'bounce' });
  assert.deepEqual(drop('Spam Reporting Address').suppress, { address: true, reason: 'spam_report' });
  assert.deepEqual(drop('Unsubscribed Address').suppress, { address: true, reason: 'unsubscribe' });
  assert.deepEqual(drop('Group Unsubscribe').suppress, { address: true, reason: 'unsubscribe' });
  assert.equal(drop('Bounced Address').type, 'dropped');
  assert.equal(drop('Bounced Address').reason, 'Bounced Address');
});

test('dropped for reasons about the request, not the address: not suppressed', () => {
  for (const reason of ['Invalid SMTPAPI header', 'Invalid Template', 'Template Render Failure', 'Spam Content', 'Expired', 'Domain is not allowed', undefined]) {
    const result = interpretEvent(base({ event: 'dropped', reason }));
    assert.equal(result.type, 'dropped');
    assert.deepEqual(result.suppress, { address: false, reason: null }, String(reason));
  }
});

test('spam report and unsubscribes suppress the address', () => {
  assert.deepEqual(interpretEvent(base({ event: 'spamreport' })).suppress, { address: true, reason: 'spam_report' });
  assert.equal(interpretEvent(base({ event: 'spamreport' })).type, 'spam_report');
  const unsub = interpretEvent(base({ event: 'unsubscribe' }));
  assert.equal(unsub.type, 'unsubscribe');
  assert.deepEqual(unsub.suppress, { address: true, reason: 'unsubscribe', group: null });
  const group = interpretEvent(base({ event: 'group_unsubscribe', asm_group_id: 42 }));
  assert.equal(group.type, 'unsubscribe');
  assert.deepEqual(group.suppress, { address: true, reason: 'unsubscribe', group: 42 });
});

test('processed and deferred pass through without suppression', () => {
  assert.equal(interpretEvent(base({ event: 'processed' })).type, 'processed');
  const deferred = interpretEvent(base({ event: 'deferred', response: '421 try again later', attempt: '2' }));
  assert.equal(deferred.type, 'deferred');
  assert.equal(deferred.reason, '421 try again later');
  assert.equal(deferred.suppress.address, false);
});

test('test sends are ignored, even bounces', () => {
  for (const test of ['1', 'true', 1, true]) {
    const result = interpretEvent(base({ event: 'bounce', type: 'bounce', test }));
    assert.equal(result.type, 'ignored');
    assert.equal(result.reason, 'test event');
    assert.equal(result.suppress.address, false);
  }
  assert.equal(interpretEvent(base({ event: 'bounce', test: '0' })).type, 'bounce');
  assert.equal(interpretEvent(base({ event: 'bounce', unique_args: { test: '1' } })).type, 'ignored');
  const custom = interpretEvent(base({ event: 'bounce', sandbox: 'yes' }), { isTest: (event) => event.sandbox === 'yes' });
  assert.equal(custom.type, 'ignored');
});

test('unknown events and junk are ignored, never thrown on', () => {
  assert.equal(interpretEvent(base({ event: 'group_resubscribe' })).type, 'ignored');
  assert.match(interpretEvent(base({ event: 'group_resubscribe' })).reason, /unsupported/);
  for (const junk of [null, undefined, 'open', 42, [], {}]) {
    assert.equal(interpretEvent(junk).type, 'ignored');
  }
});

test('interpretEvents maps a payload, with per-event options', () => {
  const events = [
    base({ event: 'open', sg_message_id: 'm1.x', timestamp: seconds('2026-11-20T15:00:02Z') }),
    base({ event: 'open', sg_message_id: 'm2.x', timestamp: seconds('2026-11-20T15:00:02Z') })
  ];
  const sends = { m1: sentAt, m2: new Date('2026-11-19T10:00:00Z') };
  const types = interpretEvents(events, (event) => ({ sentAt: sends[messageIdOf(event)] })).map((r) => r.type);
  assert.deepEqual(types, ['machine_open', 'open']);
  assert.deepEqual(interpretEvents('nope'), []);
});
