import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyEvent, emptySummary, interpretEvent, summarize, summarizeBy } from '../src/index.js';

const sentAt = new Date('2026-11-20T15:00:00Z');
const at = (iso) => Math.floor(new Date(iso).getTime() / 1000);
let n = 0;
const ev = (event, iso, fields = {}) => ({
  event, email: 'ada@example.com', timestamp: at(iso), sg_event_id: `e${++n}`, sg_message_id: 'm1.filter', ...fields
});

test('a message that was delivered, machine-opened, opened by a person and clicked', () => {
  const summary = summarize([
    ev('click', '2026-11-20T16:10:00Z', { url: 'https://example.com/a', ip: '203.0.113.9' }),
    ev('processed', '2026-11-20T15:00:00Z'),
    ev('delivered', '2026-11-20T15:00:01Z'),
    ev('open', '2026-11-20T15:00:04Z', { ip: '66.249.84.1', useragent: 'GoogleImageProxy' }),
    ev('open', '2026-11-20T15:20:00Z', { sg_machine_open: true }),
    ev('open', '2026-11-20T16:00:00Z', { ip: '203.0.113.9', useragent: 'Chrome' }),
    ev('open', '2026-11-21T09:00:00Z', { ip: '198.51.100.4', useragent: 'Outlook' }),
    ev('click', '2026-11-21T09:01:00Z', { url: 'https://example.com/a', ip: '198.51.100.4' }),
    ev('click', '2026-11-21T09:02:00Z', { url: 'https://example.com/b' })
  ], { sentAt });

  assert.equal(summary.email, 'ada@example.com');
  assert.equal(summary.messageId, 'm1');
  assert.equal(summary.delivered, true);
  assert.equal(summary.machineOpens, 2);
  assert.equal(summary.humanOpens, 2);
  assert.equal(summary.firstOpenAt.toISOString(), '2026-11-20T16:00:00.000Z');
  assert.equal(summary.lastOpenAt.toISOString(), '2026-11-21T09:02:00.000Z');
  assert.equal(summary.clicks, 3);
  assert.equal(summary.firstClickAt.toISOString(), '2026-11-20T16:10:00.000Z');
  assert.deepEqual(summary.urls, ['https://example.com/a', 'https://example.com/b']);
  assert.deepEqual(summary.readerIps, ['203.0.113.9', '198.51.100.4']);
  assert.equal(summary.opened, true);
  assert.equal(summary.clicked, true);
  assert.equal(summary.bounced, false);
  assert.deepEqual(summary.suppress, { address: false, reason: null });
});

test('a click with images blocked still counts as opened', () => {
  const summary = summarize([ev('delivered', '2026-11-20T15:00:01Z'), ev('click', '2026-11-20T17:00:00Z', { url: 'https://x.test' })], { sentAt });
  assert.equal(summary.opened, true);
  assert.equal(summary.humanOpens, 0);
  assert.equal(summary.firstOpenAt.toISOString(), '2026-11-20T17:00:00.000Z');
});

test('only machine opens: not opened', () => {
  const summary = summarize([ev('open', '2026-11-20T15:00:03Z'), ev('open', '2026-11-20T18:00:00Z', { sg_machine_open: true })], { sentAt });
  assert.equal(summary.opened, false);
  assert.equal(summary.machineOpens, 2);
});

test('bounce vs sender block vs drop', () => {
  const bounced = summarize([ev('bounce', '2026-11-20T15:00:02Z', { type: 'bounce', reason: '550 no such user' })]);
  assert.equal(bounced.bounced, true);
  assert.equal(bounced.bounceReason, '550 no such user');
  assert.deepEqual(bounced.suppress, { address: true, reason: 'bounce' });

  const blocked = summarize([ev('bounce', '2026-11-20T15:00:02Z', { type: 'blocked', reason: '554 reputation' })]);
  assert.equal(blocked.bounced, false);
  assert.equal(blocked.senderBlocked, true);
  assert.equal(blocked.senderBlockReason, '554 reputation');
  assert.equal(blocked.suppress.address, false);

  const dropped = summarize([ev('dropped', '2026-11-20T15:00:00Z', { reason: 'Unsubscribed Address' })]);
  assert.equal(dropped.dropped, true);
  assert.equal(dropped.dropReason, 'Unsubscribed Address');
  assert.deepEqual(dropped.suppress, { address: true, reason: 'unsubscribe' });
});

test('the strongest suppression wins: spam report over bounce over unsubscribe', () => {
  const summary = summarize([
    ev('unsubscribe', '2026-11-20T16:00:00Z'),
    ev('spamreport', '2026-11-20T17:00:00Z'),
    ev('dropped', '2026-11-20T18:00:00Z', { reason: 'Bounced Address' })
  ]);
  assert.equal(summary.unsubscribed, true);
  assert.equal(summary.spamReported, true);
  assert.deepEqual(summary.suppress, { address: true, reason: 'spam_report' });
});

test('duplicate deliveries of the same event are counted once; test and junk events are skipped', () => {
  const open = ev('open', '2026-11-20T16:00:00Z');
  const summary = summarize([open, { ...open }, ev('bounce', '2026-11-20T16:00:00Z', { test: '1' }), null], { sentAt });
  assert.equal(summary.humanOpens, 1);
  assert.equal(summary.events, 1);
  assert.equal(summary.bounced, false);
});

test('applyEvent works as a reducer over interpreted results, and deferrals are counted', () => {
  const results = [ev('deferred', '2026-11-20T15:00:00Z'), ev('deferred', '2026-11-20T15:05:00Z'), ev('delivered', '2026-11-20T15:10:00Z')]
    .map((event) => interpretEvent(event));
  const summary = results.reduce(applyEvent, emptySummary());
  assert.equal(summary.deferrals, 2);
  assert.equal(summary.deliveredAt.toISOString(), '2026-11-20T15:10:00.000Z');
  // summarize also accepts already-interpreted results
  assert.equal(summarize(results).delivered, true);
});

test('summarizeBy groups by message id with per-message send times', () => {
  const events = [
    ev('open', '2026-11-20T15:00:05Z', { sg_message_id: 'a.1', email: 'a@x.test' }),
    ev('open', '2026-11-20T15:00:05Z', { sg_message_id: 'b.1', email: 'b@x.test' }),
    ev('click', '2026-11-20T15:30:00Z', { sg_message_id: 'b.1', email: 'b@x.test', url: 'https://x.test' }),
    ev('open', '2026-11-20T15:00:05Z', { sg_message_id: 'c.1', test: '1' })
  ];
  const sends = { a: sentAt, b: new Date('2026-11-19T00:00:00Z') };
  const byMessage = summarizeBy(events, { options: (event) => ({ sentAt: sends[event.sg_message_id.split('.')[0]] }) });
  assert.deepEqual([...byMessage.keys()], ['a', 'b']);
  assert.equal(byMessage.get('a').machineOpens, 1);
  assert.equal(byMessage.get('a').opened, false);
  assert.equal(byMessage.get('b').humanOpens, 1);
  assert.equal(byMessage.get('b').clicks, 1);

  const byEmail = summarizeBy(events, { key: (r) => r.email });
  assert.deepEqual([...byEmail.keys()], ['a@x.test', 'b@x.test']);
});
