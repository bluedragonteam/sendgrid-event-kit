import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, toPublicKey, verifyEventWebhookSignature } from '../src/index.js';

const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
// As SendGrid shows it: base64 of the DER SubjectPublicKeyInfo
const publicKeyBase64 = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
const payload = `${JSON.stringify([{ email: 'ada@example.com', event: 'open', timestamp: 1763650000 }])}\r\n`;
const timestamp = '1763650005';
const signature = sign('sha256', Buffer.from(timestamp + payload), { key: privateKey, dsaEncoding: 'der' }).toString('base64');

test('a signature over timestamp + raw payload verifies', () => {
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload, signature, timestamp }), true);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload: Buffer.from(payload), signature, timestamp: Number(timestamp) }), true);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKey.export({ format: 'pem', type: 'spki' }), payload, signature, timestamp }), true);
  assert.equal(verifyEventWebhookSignature({ publicKey, payload, signature, timestamp }), true);
});

test('tampered payload, timestamp or signature is rejected', () => {
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload: payload.replace('open', 'click'), signature, timestamp }), false);
  // Re-serialized JSON loses the trailing \r\n SendGrid signed
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload: JSON.stringify(JSON.parse(payload)), signature, timestamp }), false);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload, signature, timestamp: '1763650006' }), false);
  const flipped = Buffer.from(signature, 'base64');
  flipped[flipped.length - 1] ^= 1;
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload, signature: flipped.toString('base64'), timestamp }), false);
});

test('another key, or bad input, is rejected without throwing', () => {
  const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  assert.equal(verifyEventWebhookSignature({ publicKey: other, payload, signature, timestamp }), false);
  assert.equal(verifyEventWebhookSignature({ publicKey: 'not a key', payload, signature, timestamp }), false);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload, signature: '', timestamp }), false);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload, signature, timestamp: 'soon' }), false);
  assert.equal(verifyEventWebhookSignature({ publicKey: publicKeyBase64, payload: { parsed: true }, signature, timestamp }), false);
  assert.equal(verifyEventWebhookSignature(), false);
});

test('only EC P-256 keys are accepted', () => {
  const p384 = generateKeyPairSync('ec', { namedCurve: 'secp384r1' }).publicKey;
  assert.throws(() => toPublicKey(p384), /P-256/);
  assert.throws(() => toPublicKey(privateKey), /P-256/);
  assert.equal(toPublicKey(publicKeyBase64).asymmetricKeyDetails.namedCurve, 'prime256v1');
});

test('optional timestamp tolerance rejects old or future requests', () => {
  const signedAt = new Date(Number(timestamp) * 1000);
  const input = { publicKey: publicKeyBase64, payload, signature, timestamp, toleranceSeconds: 300 };
  assert.equal(verifyEventWebhookSignature({ ...input, now: new Date(signedAt.getTime() + 299_000) }), true);
  assert.equal(verifyEventWebhookSignature({ ...input, now: new Date(signedAt.getTime() + 301_000) }), false);
  assert.equal(verifyEventWebhookSignature({ ...input, now: new Date(signedAt.getTime() - 301_000) }), false);
});

test("SendGrid's own published test vector verifies", () => {
  // From sendgrid/sendgrid-nodejs packages/eventwebhook/src/eventwebhook.spec.js
  const sgKey = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE83T4O/n84iotIvIW4mdBgQ/7dAfSmpqIM8kF9mN1flpVKS3GRqe62gw+2fNNRaINXvVpiglSI8eNEc6wEA3F+g==';
  const sgSignature = 'MEUCIGHQVtGj+Y3LkG9fLcxf3qfI10QysgDWmMOVmxG0u6ZUAiEAyBiXDWzM+uOe5W0JuG+luQAbPIqHh89M15TluLtEZtM=';
  const sgPayload = `${JSON.stringify([{
    email: 'hello@world.com',
    event: 'dropped',
    reason: 'Bounced Address',
    sg_event_id: 'ZHJvcC0xMDk5NDkxOS1MUnpYbF9OSFN0T0doUTRrb2ZTbV9BLTA',
    sg_message_id: 'LRzXl_NHStOGhQ4kofSm_A.filterdrecv-p3mdw1-756b745b58-kmzbl-18-5F5FC76C-9.0',
    'smtp-id': '<LRzXl_NHStOGhQ4kofSm_A@ismtpd0039p1iad1.sendgrid.net>',
    timestamp: 1600112492
  }])}\r\n`;
  assert.equal(verifyEventWebhookSignature({ publicKey: sgKey, payload: sgPayload, signature: sgSignature, timestamp: '1600112502' }), true);
  assert.equal(verifyEventWebhookSignature({ publicKey: sgKey, payload: sgPayload, signature: sgSignature, timestamp: '1600112501' }), false);
});

test('header names', () => {
  assert.equal(SIGNATURE_HEADER, 'x-twilio-email-event-webhook-signature');
  assert.equal(TIMESTAMP_HEADER, 'x-twilio-email-event-webhook-timestamp');
});
