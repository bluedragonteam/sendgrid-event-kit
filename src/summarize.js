/**
 * Fold interpreted events into per-message engagement.
 */
import { interpretEvent } from './interpret.js';

const MAX_KEPT = 20;

/**
 * An empty engagement summary
 */
export const emptySummary = () => ({
  email: null,
  messageId: null,
  processedAt: null,
  deliveredAt: null,
  firstOpenAt: null,
  lastOpenAt: null,
  humanOpens: 0,
  machineOpens: 0,
  firstClickAt: null,
  clicks: 0,
  urls: [],
  readerIps: [],
  deferrals: 0,
  bouncedAt: null,
  bounceReason: null,
  senderBlockedAt: null,
  senderBlockReason: null,
  droppedAt: null,
  dropReason: null,
  spamReportedAt: null,
  unsubscribedAt: null,
  suppress: { address: false, reason: null },
  events: 0,
  seenEventIds: []
});

const earliest = (current, at) => (!current || at < current ? at : current);
const latest = (current, at) => (!current || at > current ? at : current);
const remember = (list, value) => (value && !list.includes(value) ? [...list, value].slice(-MAX_KEPT) : list);

// Which suppression wins when several apply: a complaint outranks a bounce outranks an unsubscribe
const SUPPRESS_RANK = { spam_report: 3, bounce: 2, unsubscribe: 1 };

/**
 * Reducer: apply one result of `interpretEvent` to a summary, returning a new summary.
 * Results with an `eventId` already seen are skipped, since SendGrid delivers events at least once.
 */
export const applyEvent = (summary, result) => {
  if (!result || result.type === 'ignored') return summary;
  if (result.eventId && summary.seenEventIds.includes(result.eventId)) return summary;

  const next = {
    ...summary,
    email: summary.email || result.email,
    messageId: summary.messageId || result.messageId,
    events: summary.events + 1,
    seenEventIds: result.eventId ? [...summary.seenEventIds, result.eventId] : summary.seenEventIds
  };
  const { at } = result;

  switch (result.type) {
    case 'processed':
      next.processedAt = earliest(next.processedAt, at);
      break;
    case 'deferred':
      next.deferrals += 1;
      break;
    case 'delivered':
      next.deliveredAt = earliest(next.deliveredAt, at);
      break;
    case 'open':
      next.humanOpens += 1;
      next.firstOpenAt = earliest(next.firstOpenAt, at);
      next.lastOpenAt = latest(next.lastOpenAt, at);
      next.readerIps = remember(next.readerIps, result.ip);
      break;
    case 'machine_open':
      next.machineOpens += 1;
      break;
    case 'click':
      next.clicks += 1;
      next.firstClickAt = earliest(next.firstClickAt, at);
      // A click is an open too, but not an extra one: humanOpens counts open events only
      next.firstOpenAt = earliest(next.firstOpenAt, at);
      next.lastOpenAt = latest(next.lastOpenAt, at);
      next.urls = remember(next.urls, result.url);
      next.readerIps = remember(next.readerIps, result.ip);
      break;
    case 'bounce':
      next.bouncedAt = earliest(next.bouncedAt, at);
      next.bounceReason = next.bounceReason || result.reason;
      break;
    case 'sender_block':
      next.senderBlockedAt = earliest(next.senderBlockedAt, at);
      next.senderBlockReason = next.senderBlockReason || result.reason;
      break;
    case 'dropped':
      next.droppedAt = earliest(next.droppedAt, at);
      next.dropReason = next.dropReason || result.reason;
      break;
    case 'spam_report':
      next.spamReportedAt = earliest(next.spamReportedAt, at);
      break;
    case 'unsubscribe':
      next.unsubscribedAt = earliest(next.unsubscribedAt, at);
      break;
    default:
      break;
  }

  const incoming = result.suppress;
  if (incoming?.address && (SUPPRESS_RANK[incoming.reason] || 0) > (SUPPRESS_RANK[next.suppress.reason] || 0)) {
    next.suppress = { ...incoming };
  }
  return next;
};

/**
 * Derived flags for a summary
 */
const withFlags = (summary) => ({
  ...summary,
  delivered: !!summary.deliveredAt,
  opened: !!summary.firstOpenAt,
  clicked: summary.clicks > 0,
  bounced: !!summary.bouncedAt,
  senderBlocked: !!summary.senderBlockedAt,
  dropped: !!summary.droppedAt,
  spamReported: !!summary.spamReportedAt,
  unsubscribed: !!summary.unsubscribedAt
});

const toResult = (item, options) =>
  item && typeof item === 'object' && typeof item.type === 'string' && item.at instanceof Date
    ? item
    : interpretEvent(item, typeof options === 'function' ? options(item) : options);

/**
 * Engagement for one message, from its raw SendGrid events or results of `interpretEvent`.
 * Events are applied in time order. `options` are passed to `interpretEvent` (or a function of the event returning them).
 */
export const summarize = (events, options = {}) => {
  const results = (Array.isArray(events) ? events : [])
    .map((item) => toResult(item, options))
    .sort((a, b) => a.at - b.at);
  return withFlags(results.reduce(applyEvent, emptySummary()));
};

/**
 * Engagement per message: a Map from `key(result)` (default: the message id, else the email) to its summary.
 * `options` are the `interpretEvent` options, or a function of the raw event returning them.
 */
export const summarizeBy = (events, { key = (result) => result.messageId || result.email, options = {} } = {}) => {
  const groups = new Map();
  for (const item of Array.isArray(events) ? events : []) {
    const result = toResult(item, options);
    if (result.type === 'ignored') continue;
    const id = key(result);
    if (!groups.has(id)) groups.set(id, []);
    groups.get(id).push(result);
  }
  return new Map([...groups].map(([id, results]) => [id, summarize(results)]));
};
