import type Stripe from 'stripe';

import type { VerifiedEvent } from '@flintdev/core';

/**
 * Stable provider identifier emitted on every {@link StripeVerifiedEvent}.
 *
 * Application code consuming events from multiple providers branches on
 * the `provider` field of {@link VerifiedEvent} — this constant is the
 * value Stripe-originated events carry.
 *
 * @public
 */
export const STRIPE_PROVIDER_ID = 'stripe' as const;

/**
 * A verified webhook event whose payload is typed as Stripe's official
 * event union.
 *
 * Re-export of the core {@link VerifiedEvent} type specialized for
 * Stripe — user handlers registered in the `on:` map receive this shape
 * and get autocomplete on `event.payload.data.object` because Stripe's
 * own types are propagated through.
 *
 * @public
 */
export type StripeVerifiedEvent = VerifiedEvent<Stripe.Event>;

/**
 * Handler callback signature for Stripe events.
 *
 * Convenience alias so consumers can write
 * `const onPaid: StripeEventHandler = async (event, ctx) => …` without
 * repeating the generic.
 *
 * @public
 */
export type StripeEventHandler = (
  event: StripeVerifiedEvent,
  ctx: import('@flintdev/core').HandlerContext,
) => Promise<void>;