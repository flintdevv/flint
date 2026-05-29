import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  WebhookSignatureError,
  WebhookTimestampError,
} from '@flintdev/core';

/**
 * Parsed components of a `Stripe-Signature` header.
 *
 * Stripe's header is a comma-separated list of `key=value` pairs. The
 * timestamp appears once under `t`; signature digests can repeat under
 * `v1` (HMAC-SHA256, the only scheme Stripe currently emits) — multiple
 * `v1` entries arise during secret rotation when Stripe signs with both
 * the old and the new secret.
 *
 * @internal
 */
interface ParsedSignatureHeader {
  readonly timestamp: number;
  readonly v1: readonly string[];
}

/**
 * Default tolerance window between Stripe's signature timestamp and the
 * receiving server's clock, in seconds. Five minutes matches Stripe's
 * official recommendation and balances clock-skew tolerance against
 * replay-attack exposure.
 *
 * @public
 */
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;

/**
 * Verifies a Stripe webhook signature against the raw request body.
 *
 * Performs every check Stripe documents as required for production
 * webhooks:
 *
 * 1. Parses the `Stripe-Signature` header into its timestamp and v1
 *    digest components.
 * 2. Rejects events whose timestamp is outside the tolerance window —
 *    defends against replay attacks where a captured webhook is resent
 *    hours later.
 * 3. Recomputes HMAC-SHA256 over `${timestamp}.${body}` using each
 *    candidate secret.
 * 4. Compares each candidate digest against every `v1` entry from the
 *    header using `crypto.timingSafeEqual` — the byte-by-byte
 *    constant-time comparison required to defend against
 *    timing-side-channel attacks.
 *
 * Multiple secrets are accepted so callers can perform zero-downtime
 * key rotation: configure both the old and the new secret, rotate the
 * dashboard setting, then drop the old secret on the next deploy.
 *
 * @param body - Raw request body as received from the network. Must be
 *   the exact bytes Stripe signed; any parsing or re-serialization
 *   breaks the digest. Passed verbatim to HMAC `update`.
 * @param signatureHeader - Value of the `Stripe-Signature` request
 *   header. Pass `string` for the single-value case; `string[]` is
 *   tolerated for frameworks that surface repeated headers as arrays
 *   (only the first non-empty entry is considered).
 * @param secrets - One or more endpoint signing secrets (`whsec_…`).
 *   Verification succeeds if any secret produces a digest matching any
 *   `v1` entry. Empty arrays are rejected at construction time by the
 *   provider, not here.
 * @param now - Current wall-clock time as Unix seconds. Injected so
 *   tests can pin time; production callers pass `Math.floor(Date.now()
 *   / 1000)`.
 * @param toleranceSeconds - Maximum permitted age, in seconds, of the
 *   event according to its `t` timestamp. Defaults to
 *   {@link DEFAULT_SIGNATURE_TOLERANCE_SECONDS}.
 * @throws {WebhookSignatureError} When the header is missing, malformed,
 *   carries no `v1` entry, or when no candidate digest matches any
 *   `v1` entry under any provided secret.
 * @throws {WebhookTimestampError} When the event's timestamp falls
 *   outside the tolerance window (event in the future or too far in
 *   the past).
 *
 * @example
 * ```ts
 * verifyStripeSignature(
 *   req.body,
 *   req.headers['stripe-signature'],
 *   [process.env.STRIPE_WHSEC_CURRENT, process.env.STRIPE_WHSEC_PREVIOUS],
 *   Math.floor(Date.now() / 1000),
 * );
 * ```
 *
 * @public
 */
export function verifyStripeSignature(
  body: Buffer | string,
  signatureHeader: string | string[] | undefined,
  secrets: readonly string[],
  now: number,
  toleranceSeconds: number = DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
): void {
  const headerValue = normalizeHeader(signatureHeader);
  if (headerValue === null) {
    throw new WebhookSignatureError('missing Stripe-Signature header');
  }

  const parsed = parseSignatureHeader(headerValue);

  const skew = now - parsed.timestamp;
  if (skew > toleranceSeconds || skew < -toleranceSeconds) {
    throw new WebhookTimestampError(
      `event timestamp outside ${toleranceSeconds}s tolerance window`,
      { eventTimestamp: parsed.timestamp, toleranceSeconds },
    );
  }

  const signedPayload = `${parsed.timestamp}.${typeof body === 'string' ? body : body.toString('utf8')}`;

  for (const secret of secrets) {
    const expected = createHmac('sha256', secret).update(signedPayload).digest();
    for (const received of parsed.v1) {
      if (constantTimeHexEqual(expected, received)) return;
    }
  }

  throw new WebhookSignatureError('no signature matched any configured secret');
}

function normalizeHeader(value: string | string[] | undefined): string | null {
  if (typeof value === 'string') return value.length > 0 ? value : null;
  if (Array.isArray(value)) {
    for (const v of value) {
      if (typeof v === 'string' && v.length > 0) return v;
    }
  }
  return null;
}

function parseSignatureHeader(header: string): ParsedSignatureHeader {
  let timestamp: number | null = null;
  const v1: string[] = [];

  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) timestamp = parsed;
    } else if (key === 'v1' && /^[0-9a-f]+$/i.test(value)) {
      v1.push(value);
    }
  }

  if (timestamp === null) {
    throw new WebhookSignatureError('Stripe-Signature missing timestamp (t=)');
  }
  if (v1.length === 0) {
    throw new WebhookSignatureError('Stripe-Signature missing v1 entry');
  }
  return { timestamp, v1 };
}

function constantTimeHexEqual(expected: Buffer, receivedHex: string): boolean {
  if (receivedHex.length !== expected.length * 2) return false;
  let receivedBuf: Buffer;
  try {
    receivedBuf = Buffer.from(receivedHex, 'hex');
  } catch {
    return false;
  }
  if (receivedBuf.length !== expected.length) return false;
  return timingSafeEqual(expected, receivedBuf);
}