/**
 * Core shared vocabulary used across the Flint runtime.
 *
 * Three types live here: {@link RawHttpRequest}, {@link VerifiedEvent}, and
 * {@link HandlerContext}. They are intentionally minimal — every other module
 * in `@flintdev/core` references them, so churn here cascades.
 */

/**
 * Normalized view of an inbound HTTP request, framework-agnostic.
 *
 * Framework adapters (Express, Fastify, Hono, Next.js Route Handlers) convert
 * their native request objects into this shape before handing them to the
 * Flint handler. Core code never imports framework types.
 *
 * The body **must** be the exact bytes received off the network. Any JSON
 * parsing or whitespace normalization before this point invalidates the
 * provider's HMAC signature and verification will reject the event.
 *
 * @example
 * ```ts
 * // Express adapter (illustrative — the real adapter lives in @flintdev/express)
 * app.post(
 *   '/webhooks/stripe',
 *   express.raw({ type: 'application/json' }),
 *   async (req, res) => {
 *     const flintReq: RawHttpRequest = {
 *       body: req.body,            // Buffer from express.raw()
 *       headers: req.headers,      // Express lowercases header names
 *     };
 *     // pass flintReq to the Flint handler...
 *   },
 * );
 * ```
 *
 * @beta
 */
export interface RawHttpRequest {
    /**
     * Raw request body, exactly as received from the network socket.
     *
     * `Buffer` is the canonical Node shape (Express `raw`, Fastify `rawBody`,
     * `http.IncomingMessage` chunks). `string` is permitted for runtimes that
     * surface the body as UTF-8 text (Next.js Route Handlers via `req.text()`).
     *
     * Never pass a parsed object here. The provider signed the bytes, not the
     * shape.
     */
    readonly body: Buffer | string;

    /**
     * Request headers as a plain object.
     *
     * Keys are expected lowercase — Node's `http` module and every major
     * framework deliver headers this way. Providers that need a specific header
     * (e.g. `stripe-signature`) look it up by its documented lowercase name.
     *
     * Multi-value headers (rare on webhook endpoints) arrive as `string[]`;
     * single-value headers as `string`. `undefined` entries are tolerated and
     * treated as missing.
     */
    readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

/**
 * A webhook event whose signature has been verified by a {@link WebhookProvider}.
 *
 * This is the shape user handlers receive. It carries only fields every
 * provider can deliver — provider-specific extensions live inside
 * {@link VerifiedEvent.payload}, which is typed by the provider package.
 *
 * @typeParam TPayload - The provider's typed event payload. Stripe's package
 *   sets this to its event union; PayPal's would set its own.
 *
 * @beta
 */
export interface VerifiedEvent<TPayload = unknown> {
    /**
     * Provider's stable event identifier.
     *
     * For Stripe this is the `evt_...` ID. Used as the idempotency key — two
     * inbound requests with the same `id` must be processed at most once across
     * the entire system.
     */
    readonly id: string;

    /**
     * Provider's event type discriminator.
     *
     * Examples: `payment_intent.succeeded`, `customer.subscription.updated`.
     * Used by the handler to route to the correct user-supplied callback.
     */
    readonly type: string;

    /**
     * Provider identifier this event came from.
     *
     * Convention: provider packages export a constant
     * (`@flintdev/stripe` exports `STRIPE_PROVIDER_ID`) and set this field
     * themselves. Application code that consumes events from multiple providers
     * uses this to branch.
     */
    readonly provider: string;

    /**
     * Parsed event body. Typed by the provider package via {@link TPayload}.
     *
     * For `@flintdev/stripe`, this is a discriminated union of Stripe.Event
     * shapes. For other providers, whatever they ship.
     */
    readonly payload: TPayload;

    /**
     * Wall-clock time the event arrived at the Flint handler.
     *
     * Recorded once at the top of the handler pipeline (after verification,
     * before dispatch). Useful for observability — comparing this against
     * `payload.created` tells you ingestion lag.
     */
    readonly receivedAt: Date;

    /**
     * Whether the event came from the provider's live environment.
     *
     * `true` for production webhooks, `false` for test-mode. Application code
     * should branch on this before performing live-world side effects (charging
     * cards, sending email).
     */
    readonly livemode: boolean;
}

/**
 * Context object passed alongside the event to every user handler.
 *
 * Carries runtime metadata the handler needs but the event itself doesn't
 * encode: retry attempt number and a cancellation signal.
 *
 * @beta
 */
export interface HandlerContext {
    /**
     * 1-indexed retry attempt number.
     *
     * `1` on the first delivery, `2`+ on retries. Handlers that perform
     * non-idempotent side effects can branch on this to avoid duplicate work —
     * though correctly designed handlers should be idempotent regardless.
     */
    readonly attempt: number;

    /**
     * Cancellation signal honoring the handler's configured timeout.
     *
     * Aborts when the per-event budget elapses. Handlers performing async work
     * (database queries, outbound HTTP) should pass this signal to their
     * libraries so partial work is cancelled cleanly on timeout.
     */
    readonly signal: AbortSignal;
}