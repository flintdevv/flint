import type Stripe from 'stripe';

import type {
  RawHttpRequest,
  VerifiedEvent,
  WebhookProvider,
} from '@flintdev/core';
import { WebhookPayloadError } from '@flintdev/core';

import { STRIPE_PROVIDER_ID, type StripeVerifiedEvent } from './events.js';
import {
  DEFAULT_SIGNATURE_TOLERANCE_SECONDS,
  verifyStripeSignature,
} from './signature.js';

/**
 * Configuration accepted by {@link createStripeProvider}.
 *
 * @public
 */
export interface StripeWebhookProviderOptions {
  /**
   * One or more endpoint signing secrets (`whsec_…`) issued by Stripe.
   *
   * During key rotation, pass both the new and the previous secret —
   * verification succeeds against any of them. After deploying the
   * rotated secret and confirming traffic, drop the old one.
   */
  readonly secrets: readonly string[];

  /**
   * Maximum permitted age, in seconds, of inbound events according to
   * their signature timestamp. Defaults to Stripe's recommendation.
   *
   * @defaultValue 300
   */
  readonly toleranceSeconds?: number;

  /**
   * Clock function returning the current Unix time in seconds. Injected
   * for deterministic tests; production uses
   * `() => Math.floor(Date.now() / 1000)`.
   *
   * @defaultValue Wall-clock seconds via `Date.now`.
   */
  readonly clock?: () => number;
}

/**
 * Constructs a {@link WebhookProvider} that verifies and parses Stripe
 * webhook requests.
 *
 * Performs every operation Stripe documents for safe webhook handling:
 * signature verification with timing-safe comparison, timestamp
 * tolerance enforcement, multi-secret rotation, and structured payload
 * parsing. Throws typed Flint errors for every failure mode.
 *
 * The returned provider is stateless and safe to share across
 * concurrent requests — secret material is captured in the closure
 * once at construction.
 *
 * @param options - Secret material and verification tuning.
 * @returns A provider satisfying {@link WebhookProvider} with
 *   `payload` typed as `Stripe.Event`. Hand this to
 *   `createWebhookHandler` from `@flintdev/core`.
 * @throws {Error} Synchronously, at construction time, when `secrets`
 *   is empty or any secret is not a non-empty string. Misconfiguration
 *   is surfaced loudly at boot rather than silently at first request.
 *
 * @example
 * ```ts
 * import { createWebhookHandler, InMemoryIdempotencyStore } from '@flintdev/core';
 * import { createStripeProvider } from '@flintdev/stripe';
 *
 * const provider = createStripeProvider({
 *   secrets: [process.env.STRIPE_WHSEC!],
 * });
 *
 * const flint = createWebhookHandler({
 *   provider,
 *   idempotency: new InMemoryIdempotencyStore(),
 *   on: {
 *     'payment_intent.succeeded': async (event, ctx) => {
 *       await db.charges.markPaid(event.payload.data.object.id, { signal: ctx.signal });
 *     },
 *   },
 * });
 * ```
 *
 * @public
 */
export function createStripeProvider(
  options: StripeWebhookProviderOptions,
): WebhookProvider<Stripe.Event> {
  if (!Array.isArray(options.secrets) || options.secrets.length === 0) {
    throw new Error('createStripeProvider: at least one signing secret is required');
  }
  for (const secret of options.secrets) {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new Error('createStripeProvider: every secret must be a non-empty string');
    }
  }

  const secrets = Object.freeze([...options.secrets]);
  const toleranceSeconds =
    options.toleranceSeconds ?? DEFAULT_SIGNATURE_TOLERANCE_SECONDS;
  const clock = options.clock ?? (() => Math.floor(Date.now() / 1000));

  return Object.freeze({
    id: STRIPE_PROVIDER_ID,

    async verify(req: RawHttpRequest): Promise<VerifiedEvent<Stripe.Event>> {
      verifyStripeSignature(
        req.body,
        req.headers['stripe-signature'],
        secrets,
        clock(),
        toleranceSeconds,
      );

      const raw = typeof req.body === 'string' ? req.body : req.body.toString('utf8');
      let parsed: Stripe.Event;
      try {
        parsed = JSON.parse(raw) as Stripe.Event;
      } catch (err) {
        throw new WebhookPayloadError('Stripe webhook body is not valid JSON', { cause: err });
      }

      if (
        typeof parsed !== 'object' ||
        parsed === null ||
        typeof parsed.id !== 'string' ||
        typeof parsed.type !== 'string' ||
        typeof parsed.livemode !== 'boolean'
      ) {
        throw new WebhookPayloadError('Stripe webhook body missing required event fields');
      }

      const event: StripeVerifiedEvent = {
        id: parsed.id,
        type: parsed.type,
        provider: STRIPE_PROVIDER_ID,
        payload: parsed,
        receivedAt: new Date(),
        livemode: parsed.livemode,
      };
      return event;
    },
  });
}