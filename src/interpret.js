/**
 * Turn one SendGrid Event Webhook event into a normalized, storage-agnostic result.
 */

// An "open" this soon after sending is a machine loading the tracking image on arrival (Gmail's image proxy
// prefetching, company mail scanners), not a person: in real campaign data they land 2-19 seconds after the send
export const DEFAULT_MACHINE_OPEN_WINDOW_MS = 30 * 1000;

// SendGrid event timestamps are whole seconds, so an instant open can be stamped up to 1s before the send time
const CLOCK_SLACK_MS = 1000;

// Mail providers that fetch images for their users: the IP is the provider's, not the reader's
export const MAIL_PROXY_AGENTS = /GoogleImageProxy|ggpht\.com|YahooMailProxy|Yahoo Mail Proxy/i;

// Fields SendGrid itself puts on events. Every other top-level key is one of your custom_args / unique_args.
export const STANDARD_FIELDS = new Set([
  'asm_group_id', 'attempt', 'bounce_classification', 'category', 'cert_err', 'custom_args', 'email', 'event',
  'ip', 'marketing_campaign_id', 'marketing_campaign_name', 'marketing_campaign_split_id',
  'marketing_campaign_version', 'mc_auto_id', 'mc_pod_id', 'mc_stats', 'phase_id', 'pool', 'reason', 'response',
  'send_at', 'sg_content_type', 'sg_event_id', 'sg_machine_open', 'sg_message_id', 'sg_template_id',
  'sg_template_name', 'sg_user_id', 'singlesend_id', 'singlesend_name', 'smtp-id', 'status', 'template_id',
  'template_version_id', 'timestamp', 'tls', 'type', 'unique_args', 'url', 'url_offset', 'useragent'
]);

const TEST_FLAGS = new Set(['1', 'true', 'yes']);

const toTime = (value) => {
  if (value === null || value === undefined || value === '') return NaN;
  return value instanceof Date ? value.getTime() : new Date(value).getTime();
};

/**
 * The event time. SendGrid sends UNIX seconds; a 13-digit value is taken as milliseconds.
 * @returns {Date|null}
 */
export const eventTime = (event) => {
  const raw = Number(event?.timestamp);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  return new Date(raw > 1e12 ? raw : raw * 1000);
};

/**
 * The reader's own IP from an open or click event, or null when it's missing or belongs to a mail proxy
 */
export const readerIp = (event) => {
  const ip = typeof event?.ip === 'string' ? event.ip.trim() : '';
  if (!ip || ip.length > 64 || MAIL_PROXY_AGENTS.test(event.useragent || '')) return null;
  return ip;
};

/**
 * Whether an open at `at` came too soon after `sentAt` to be a person.
 * An open stamped before the send (beyond one second of rounding) belongs to an earlier email, so it's not ruled a machine.
 */
export const isMachineOpenTime = (sentAt, at, windowMs = DEFAULT_MACHINE_OPEN_WINDOW_MS) => {
  const sent = toTime(sentAt);
  const open = toTime(at);
  if (Number.isNaN(sent) || Number.isNaN(open)) return false;
  const diff = open - sent;
  return diff >= -CLOCK_SLACK_MS && diff < windowMs;
};

/**
 * The id SendGrid returned as X-Message-Id when you sent: sg_message_id up to the first dot
 */
export const messageIdOf = (event) => {
  const id = typeof event?.sg_message_id === 'string' ? event.sg_message_id : '';
  return id ? id.split('.')[0] : null;
};

/**
 * Your custom_args / unique_args: every non-standard top-level key, plus any nested unique_args or custom_args object
 */
export const customArgsOf = (event) => {
  const args = {};
  if (!event || typeof event !== 'object') return args;
  for (const nested of [event.unique_args, event.custom_args]) {
    if (nested && typeof nested === 'object' && !Array.isArray(nested)) Object.assign(args, nested);
  }
  for (const [key, value] of Object.entries(event)) {
    if (!STANDARD_FIELDS.has(key)) args[key] = value;
  }
  return args;
};

/**
 * Whether the event comes from a test send, flagged with a custom arg `test` of '1' / 'true' / 'yes' / 1 / true
 */
export const isTestEvent = (event, customArgs = customArgsOf(event)) => {
  const flag = customArgs.test ?? event?.test;
  return flag === true || flag === 1 || TEST_FLAGS.has(String(flag ?? '').trim().toLowerCase());
};

const NO_SUPPRESS = Object.freeze({ address: false, reason: null });
const suppressFor = (reason, extra) => ({ address: true, reason, ...extra });

/**
 * Why SendGrid dropped a message, as the suppression it implies (or none)
 */
const dropSuppression = (reason) => {
  const text = reason.toLowerCase();
  if (text.includes('bounce')) return suppressFor('bounce');
  // "Invalid" is the address; "Invalid SMTPAPI header" and "Invalid Template" are your request
  if (text.includes('invalid') && !/smtpapi|template/.test(text)) return suppressFor('bounce');
  // "Spam Reporting Address", not "Spam Content" (that's the email, not the address)
  if (/spam\s*report/.test(text)) return suppressFor('spam_report');
  if (text.includes('unsubscribe')) return suppressFor('unsubscribe');
  return NO_SUPPRESS;
};

// Replies about the recipient's address. SendGrid files some of these under "blocked" when it doesn't know the
// receiver's wording (Proofpoint's "550 #5.1.0 Address rejected."), though the mailbox simply doesn't exist.
// X.1.0-X.1.3, X.1.6 and X.1.10 are destination address codes (RFC 3463, RFC 7505); X.1.7 / X.1.8 are the sender's.
const RECIPIENT_ADDRESS_CODE = /\b5\.1\.(?:[0-36]|10)\b/;
const RECIPIENT_ADDRESS_TEXT = /\b(?:user|recipient|mailbox|address|account)\s+(?:unknown|not\s+found|does\s*n[o']t\s+exist|unavailable|disabled)\b|\bunknown\s+(?:user|recipient)\b|\bno\s+such\s+(?:user|mailbox|recipient)\b|\b(?:recipient|address)\s+rejected\b|\binvalid\s+(?:recipient|mailbox)\b|\bundeliverable\s+address\b|\bdoes\s*n[o']t\s+exist\b/i;
// ...unless the reply is really about the sender or the message
const ABOUT_THE_SENDER = /\bsender\b|reputation|\bspam|\bblock(?:ed|list)|blacklist|\blisted\b|spamhaus|\brbl\b|\bspf\b|\bdkim\b|\bdmarc\b|\bpolicy\b|\bcontent\b|rate\s*limit|too\s+many/i;

/**
 * Whether a rejection says the recipient's address doesn't exist (as opposed to the receiver refusing the sender).
 * @param {string|null} reason the SMTP reply
 * @param {string|null} [classification] SendGrid's bounce_classification
 */
export const isUnknownRecipient = (reason, classification = null) => {
  if (classification === 'Invalid Address') return true;
  const text = String(reason || '');
  if (!text || ABOUT_THE_SENDER.test(text)) return false;
  return RECIPIENT_ADDRESS_CODE.test(text) || RECIPIENT_ADDRESS_TEXT.test(text);
};

/**
 * Interpret one SendGrid Event Webhook event.
 *
 * @param {object} event a single element of the webhook's JSON array
 * @param {object} [options]
 * @param {Date|string|number} [options.sentAt] when this message was sent (for machine-open detection)
 * @param {Date|string|number} [options.followUpSentAt] when a follow-up in the same thread was sent
 * @param {number} [options.machineOpenWindowMs=30000] opens sooner than this after a send are machines
 * @param {(event: object) => boolean} [options.isTest] override test-send detection
 * @param {Date} [options.now] time used when the event has no timestamp
 */
export const interpretEvent = (event, options = {}) => {
  const {
    sentAt = null,
    followUpSentAt = null,
    machineOpenWindowMs = DEFAULT_MACHINE_OPEN_WINDOW_MS,
    isTest = isTestEvent,
    now = new Date()
  } = options;

  const valid = !!event && typeof event === 'object' && !Array.isArray(event);
  const source = valid ? event : {};
  const customArgs = customArgsOf(source);
  const reason = String(source.reason || source.response || '').trim() || null;

  const result = {
    type: 'ignored',
    event: typeof source.event === 'string' ? source.event : null,
    at: eventTime(source) || new Date(now),
    email: typeof source.email === 'string' ? source.email.trim().toLowerCase() || null : null,
    messageId: messageIdOf(source),
    eventId: typeof source.sg_event_id === 'string' ? source.sg_event_id : null,
    ip: null,
    url: null,
    reason: null,
    suppress: NO_SUPPRESS,
    customArgs
  };
  const ignore = (why) => ({ ...result, reason: why });

  if (!valid || !result.event) return ignore('not an event');
  // Test sends often reuse a real recipient's details - never let them suppress or count against anyone
  if (isTest(source, customArgs)) return ignore('test event');

  switch (source.event) {
    case 'processed':
    case 'deferred':
      return { ...result, type: source.event, reason };
    case 'delivered':
      return { ...result, type: 'delivered', reason };
    case 'open': {
      // Apple Mail Privacy Protection (flagged by SendGrid), and opens seconds after the send, aren't people
      const mpp = source.sg_machine_open === true || source.sg_machine_open === 'true';
      const tooSoon = !mpp && (isMachineOpenTime(sentAt, result.at, machineOpenWindowMs)
        || isMachineOpenTime(followUpSentAt, result.at, machineOpenWindowMs));
      if (mpp || tooSoon) return { ...result, type: 'machine_open', reason: mpp ? 'apple_mpp' : 'too_soon_after_send' };
      return { ...result, type: 'open', ip: readerIp(source) };
    }
    case 'click':
      // A click proves the email was opened even when images were blocked and the open pixel never loaded
      return { ...result, type: 'click', ip: readerIp(source), url: typeof source.url === 'string' ? source.url : null, impliesOpen: true };
    case 'bounce':
      // "blocked" is a rejection of the sender (reputation, content, volume), not proof the address is bad -
      // unless the reply itself says the address doesn't exist
      if (source.type === 'blocked' && !isUnknownRecipient(reason, source.bounce_classification)) {
        return { ...result, type: 'sender_block', reason: reason || 'rejected by the receiving server', classification: source.bounce_classification || null };
      }
      return { ...result, type: 'bounce', reason: reason || 'bounced', classification: source.bounce_classification || null, suppress: suppressFor('bounce') };
    case 'dropped':
      // SendGrid didn't send it: often because the address is already on a suppression list
      return { ...result, type: 'dropped', reason, suppress: dropSuppression(reason || '') };
    case 'spamreport':
      return { ...result, type: 'spam_report', suppress: suppressFor('spam_report') };
    case 'unsubscribe':
      return { ...result, type: 'unsubscribe', suppress: suppressFor('unsubscribe', { group: null }) };
    case 'group_unsubscribe':
      // Only covers one unsubscribe group: `suppress.group` says which
      return { ...result, type: 'unsubscribe', suppress: suppressFor('unsubscribe', { group: source.asm_group_id ?? null }) };
    default:
      return ignore(`unsupported event "${source.event}"`);
  }
};

/**
 * Interpret a whole webhook payload. `options` may be a function of the event, to look up each message's send time.
 */
export const interpretEvents = (events, options = {}) =>
  (Array.isArray(events) ? events : []).map((event) =>
    interpretEvent(event, typeof options === 'function' ? options(event) : options));
