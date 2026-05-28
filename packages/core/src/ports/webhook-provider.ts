import type { RawHttpRequest, VerifiedEvent } from '../types.js';

/**
 * Contract every webhook provider implementation must fulfill.
 *
 * Concrete adapters (`@flintdev/stripe`, future `@flintdev/paypal`, etc.)
 * implement this interface. The core handler depends only on this contract —
 * it never imports provider-specific code.
 *
 * @typeParam TPayload - The provider's typed event payload union. The Stripe
 *   adapter sets this to its event type; other providers ship their own.
 *
 * @example
 * ```ts
 * import type { WebhookProvider } from '@flintdev/core';
 * import type Stripe from 'stripe';
 *
 * export class StripeWebhookProvider implements WebhookProvider<Stripe.Event> {
 *   readonly id = 'stripe';
 *   async verify(req) { ... }
 * }
 * ```
 *
 * @beta
 */
export interface WebhookProvider<TPayload = unknown> {
  /**
   * Stable identifier for this provider.
   *
   * Set once per provider package, exported alongside the adapter as a named
   * constant (`STRIPE_PROVIDER_ID = 'stripe'`). Used by the handler to
   * populate {@link VerifiedEvent.provider} and by application code that
   * branches on event source.
   */
  readonly id: string;

  /**
   * Verifies an inbound request and produces a typed event.
   *
   * Implementations perform exactly the security-critical work that the
   * provider documents: signature verification (HMAC, RSA, etc.), timestamp
   * tolerance check, and any provider-specific replay defenses. They then
   * parse the body and produce a {@link VerifiedEvent}.
   *
   * @param req - The normalized inbound request. The `body` field carries
   *   the exact bytes received off the network; implementations must not
   *   re-serialize or mutate them before verification.
   * @param signal - Cancellation signal honored by long-running checks
   *   (e.g. fetching a remote JWKS for providers that rotate keys). Pure
   *   HMAC implementations may ignore this — verification is synchronous and
   *   sub-millisecond.
   * @returns A verified event whose existence is proof of authenticity.
   *   Code accepting a `VerifiedEvent` parameter is statically guaranteed
   *   not to be processing unverified data.
   * @throws {WebhookSignatureError} When the signature is missing, malformed,
   *   or does not match the expected value.
   * @throws {WebhookTimestampError} When the event's timestamp is outside the
   *   provider's configured tolerance window.
   * @throws {WebhookPayloadError} When the body passes signature verification
   *   but cannot be parsed into the provider's event shape.
   */
  verify(req: RawHttpRequest, signal: AbortSignal): Promise<VerifiedEvent<TPayload>>;
}