/**
 * SendGrid Signed Event Webhook verification.
 *
 * SendGrid signs `timestamp + raw request body` with ECDSA (P-256) and SHA-256, and sends the base64 of the
 * ASN.1/DER signature in X-Twilio-Email-Event-Webhook-Signature and the timestamp in
 * X-Twilio-Email-Event-Webhook-Timestamp. The verification key shown in SendGrid's settings is the base64 of a
 * DER SubjectPublicKeyInfo. See
 * https://www.twilio.com/docs/sendgrid/for-developers/tracking-events/getting-started-event-webhook-security-features
 */
import { createPublicKey, verify } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-twilio-email-event-webhook-signature';
export const TIMESTAMP_HEADER = 'x-twilio-email-event-webhook-timestamp';

/**
 * A node:crypto KeyObject from SendGrid's verification key: base64 DER (as copied from SendGrid), PEM, or a KeyObject.
 * Throws if it isn't an EC P-256 public key.
 */
export const toPublicKey = (publicKey) => {
  let key = publicKey;
  if (typeof publicKey === 'string') {
    const text = publicKey.trim();
    key = text.startsWith('-----BEGIN')
      ? createPublicKey(text)
      : createPublicKey({ key: Buffer.from(text.replace(/\s+/g, ''), 'base64'), format: 'der', type: 'spki' });
  } else if (Buffer.isBuffer(publicKey)) {
    key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
  }
  if (!key || key.type !== 'public' || key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new TypeError('Expected an EC P-256 public key');
  }
  return key;
};

/**
 * Verify a Signed Event Webhook request.
 *
 * @param {object} input
 * @param {string|Buffer|import('node:crypto').KeyObject} input.publicKey SendGrid's verification key
 * @param {string|Buffer} input.payload the raw request body, byte for byte (not re-serialized JSON)
 * @param {string} input.signature the X-Twilio-Email-Event-Webhook-Signature header
 * @param {string|number} input.timestamp the X-Twilio-Email-Event-Webhook-Timestamp header
 * @param {number} [input.toleranceSeconds] also reject timestamps further than this from `now` (off by default)
 * @param {Date} [input.now]
 * @returns {boolean} true only for a valid signature (never throws on bad input)
 */
export const verifyEventWebhookSignature = ({ publicKey, payload, signature, timestamp, toleranceSeconds, now = new Date() } = {}) => {
  try {
    if (typeof signature !== 'string' || !signature.trim()) return false;
    const stamp = String(timestamp ?? '').trim();
    if (!/^\d+$/.test(stamp)) return false;
    if (toleranceSeconds !== undefined && toleranceSeconds !== null) {
      if (Math.abs(now.getTime() / 1000 - Number(stamp)) > toleranceSeconds) return false;
    }
    if (typeof payload !== 'string' && !Buffer.isBuffer(payload)) return false;
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
    const data = Buffer.concat([Buffer.from(stamp, 'utf8'), body]);
    return verify('sha256', data, { key: toPublicKey(publicKey), dsaEncoding: 'der' }, Buffer.from(signature.trim(), 'base64'));
  } catch {
    return false;
  }
};
