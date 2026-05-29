import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  WebhookSignatureError,
  WebhookTimestampError,
} from '@flintdev/core';

import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from '../signature.js';

/**
 * Computes a valid `Stripe-Signature` header value for a given body,
 * secret, and timestamp. Mirrors exactly what Stripe's signing
 * infrastructure does on their side — used inside tests to produce
 * legitimate signatures we can mutate one byte at a time.
 */
function signStripeBody(body: string | Buffer, secret: string, timestamp: number): string {
  const payload = `${timestamp}.${typeof body === 'string' ? body : body.toString('utf8')}`;
  const v1 = createHmac('sha256', secret).update(payload).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

const BODY = '{"id":"evt_test","type":"payment_intent.succeeded","livemode":false}';
const SECRET = 'whsec_test_secret_one';
const SECRET_ROTATED = 'whsec_test_secret_two';
const NOW = 1_780_000_000; // Unix seconds, well inside any tolerance window

describe('verifyStripeSignature', () => {
  describe('valid inputs', () => {
    it('accepts a correctly signed request', () => {
      const header = signStripeBody(BODY, SECRET, NOW);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW)).not.toThrow();
    });

    it('accepts when the body is a Buffer', () => {
      const bodyBuf = Buffer.from(BODY, 'utf8');
      const header = signStripeBody(bodyBuf, SECRET, NOW);

      expect(() => verifyStripeSignature(bodyBuf, header, [SECRET], NOW)).not.toThrow();
    });

    it('accepts when a rotated secret matches (second in array)', () => {
      const header = signStripeBody(BODY, SECRET_ROTATED, NOW);

      expect(() =>
        verifyStripeSignature(BODY, header, [SECRET, SECRET_ROTATED], NOW),
      ).not.toThrow();
    });

    it('accepts when the header carries multiple v1 entries and one matches', () => {
      const ts = NOW;
      const goodPayload = `${ts}.${BODY}`;
      const goodV1 = createHmac('sha256', SECRET).update(goodPayload).digest('hex');
      const fakeV1 = 'a'.repeat(64);
      const header = `t=${ts},v1=${fakeV1},v1=${goodV1}`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW)).not.toThrow();
    });

    it('tolerates a single-element header[] from frameworks that surface arrays', () => {
      const header = signStripeBody(BODY, SECRET, NOW);

      expect(() => verifyStripeSignature(BODY, [header], [SECRET], NOW)).not.toThrow();
    });
  });

  describe('signature mismatch', () => {
    it('rejects when the body has been mutated by a single byte', () => {
      const header = signStripeBody(BODY, SECRET, NOW);
      const tamperedBody = BODY.replace('false', 'true');

      expect(() => verifyStripeSignature(tamperedBody, header, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects when the v1 digest has been tampered with', () => {
      const header = signStripeBody(BODY, SECRET, NOW);
      const tamperedHeader = header.slice(0, -1) + (header.endsWith('0') ? '1' : '0');

      expect(() => verifyStripeSignature(BODY, tamperedHeader, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects when the secret is wrong', () => {
      const header = signStripeBody(BODY, SECRET, NOW);

      expect(() => verifyStripeSignature(BODY, header, ['whsec_wrong'], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects when no secrets match against any v1 entry', () => {
      const ts = NOW;
      const fakeV1 = 'a'.repeat(64);
      const header = `t=${ts},v1=${fakeV1}`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET, SECRET_ROTATED], NOW))
        .toThrow(WebhookSignatureError);
    });
  });

  describe('malformed headers', () => {
    it('rejects a missing header (undefined)', () => {
      expect(() => verifyStripeSignature(BODY, undefined, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects an empty string header', () => {
      expect(() => verifyStripeSignature(BODY, '', [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects an empty array header', () => {
      expect(() => verifyStripeSignature(BODY, [], [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects a header missing the timestamp (no t=)', () => {
      const v1 = createHmac('sha256', SECRET).update(`${NOW}.${BODY}`).digest('hex');
      const header = `v1=${v1}`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects a header missing any v1 entry', () => {
      const header = `t=${NOW}`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects a non-hex v1 value (defense against bad input)', () => {
      const header = `t=${NOW},v1=not_hex_data`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });

    it('rejects a v1 value of wrong length (32 hex chars, not 64)', () => {
      const header = `t=${NOW},v1=${'a'.repeat(32)}`;

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookSignatureError);
    });
  });

  describe('timestamp tolerance', () => {
    it('rejects an event older than the tolerance window', () => {
      const eventTime = NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1;
      const header = signStripeBody(BODY, SECRET, eventTime);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookTimestampError);
    });

    it('rejects an event timestamp too far in the future', () => {
      const eventTime = NOW + DEFAULT_SIGNATURE_TOLERANCE_SECONDS + 1;
      const header = signStripeBody(BODY, SECRET, eventTime);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookTimestampError);
    });

    it('accepts an event exactly at the tolerance boundary', () => {
      const eventTime = NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
      const header = signStripeBody(BODY, SECRET, eventTime);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW)).not.toThrow();
    });

    it('honors a custom tolerance window', () => {
      const eventTime = NOW - 30;
      const header = signStripeBody(BODY, SECRET, eventTime);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW, 10))
        .toThrow(WebhookTimestampError);

      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW, 60)).not.toThrow();
    });

    it('attaches the event timestamp and tolerance to the thrown error', () => {
      const eventTime = NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 100;
      const header = signStripeBody(BODY, SECRET, eventTime);

      try {
        verifyStripeSignature(BODY, header, [SECRET], NOW);
        throw new Error('expected verifyStripeSignature to throw');
      } catch (err) {
        expect(err).toBeInstanceOf(WebhookTimestampError);
        const typed = err as WebhookTimestampError;
        expect(typed.eventTimestamp).toBe(eventTime);
        expect(typed.toleranceSeconds).toBe(DEFAULT_SIGNATURE_TOLERANCE_SECONDS);
      }
    });
  });

  describe('checks in order', () => {
    it('rejects on timestamp before checking signature digest', () => {
      const eventTime = NOW - DEFAULT_SIGNATURE_TOLERANCE_SECONDS - 1;
      const fakeV1 = 'a'.repeat(64);
      const header = `t=${eventTime},v1=${fakeV1}`;

      // Even though v1 is garbage, the timestamp gate fires first.
      expect(() => verifyStripeSignature(BODY, header, [SECRET], NOW))
        .toThrow(WebhookTimestampError);
    });
  });
});