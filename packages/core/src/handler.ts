import type {
  HandlerContext,
  RawHttpRequest,
  VerifiedEvent,
} from './types.js';
import {
  FlintError,
  HandlerExecutionError,
  HandlerTimeoutError,
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
  type FlintErrorCode,
} from './errors.js';
import type { WebhookProvider } from './ports/webhook-provider.js';
import type { IdempotencyStore } from './ports/idempotency-store.js';
import type { DeadLetterEntry, DeadLetterQueue } from './ports/dead-letter-queue.js';

/**
 * User-supplied callback invoked when an event of a given type is verified
 * and claimed.
 *
 * Handlers are called with the typed event and a fresh per-attempt
 * {@link HandlerContext}. Throwing from this function triggers Flint's retry
 * logic; honoring `ctx.signal` is required for clean cancellation on
 * timeout.
 *
 * @typeParam TPayload - Provider-specific event payload type.
 *
 * @beta
 */
export type EventHandler<TPayload = unknown> = (
  event: VerifiedEvent<TPayload>,
  ctx: HandlerContext,
) => Promise<void>;

/**
 * Retry policy applied to handler failures and handler timeouts.
 *
 * Backoff formula is exponential with full jitter:
 *
 * ```
 * delay = min(maxDelayMs, random(0, baseDelayMs * 2 ** (attempt - 1)))
 * ```
 *
 * Full jitter is chosen deliberately over equal or decorrelated jitter — it
 * produces the best load distribution under retry storms (AWS Architecture
 * Blog, "Exponential Backoff and Jitter"). At our scale the choice between
 * jitter variants is statistical noise; full jitter wins on simplicity.
 *
 * @beta
 */
export interface RetryPolicy {
  /**
   * Maximum total attempts including the first one. `1` disables retries.
   *
   * @defaultValue 3
   */
  readonly maxAttempts: number;

  /**
   * Base delay for the first retry, in milliseconds.
   *
   * @defaultValue 200
   */
  readonly baseDelayMs: number;

  /**
   * Hard cap on any single backoff delay, in milliseconds. The exponential
   * formula is capped at this value before jitter is applied.
   *
   * @defaultValue 5000
   */
  readonly maxDelayMs: number;
}

/**
 * Per-phase timeout budgets.
 *
 * Two distinct timeouts, not a single outer budget:
 *
 * - `verifyTimeoutMs` bounds the provider's verification work.
 * - `handlerTimeoutMs` bounds each individual handler attempt — retries get
 *   fresh budgets, so a slow attempt 1 doesn't reduce attempt 2's chances.
 *
 * Total wall time across the seven-gate pipeline is approximately
 * `verifyTimeoutMs + sum(attempts) * handlerTimeoutMs + sum(backoffs)`.
 * Callers wanting a hard outer bound enforce it at the framework layer.
 *
 * @beta
 */
export interface TimeoutPolicy {
  /**
   * Timeout for the provider's `verify()` call, in milliseconds. Defends
   * against providers that perform network I/O during verification (JWKS,
   * remote key rotation) and hang.
   *
   * @defaultValue 5000
   */
  readonly verifyTimeoutMs: number;

  /**
   * Timeout for each handler attempt, in milliseconds.
   *
   * Chosen at 25s by default to leave headroom under Stripe's 30s outer
   * webhook timeout. The handler's `AbortSignal` aborts when this elapses;
   * handlers that honor the signal terminate cleanly.
   *
   * @defaultValue 25000
   */
  readonly handlerTimeoutMs: number;
}

/**
 * Possible outcomes of running an inbound webhook through the pipeline.
 *
 * Returned by {@link FlintHandler.process}. Framework adapters translate
 * `status` to HTTP and optionally surface `code` in response bodies or
 * structured logs. The handler never throws out of `process()`; every
 * failure mode is reified here.
 *
 * - `200` — event accepted (either fully processed, deduplicated, or
 *   acknowledged-without-handler).
 * - `400` — request invalid (signature, timestamp, or payload). Providers
 *   should not retry; retrying a forged request does not authenticate it.
 * - `500` — our system failed (idempotency store down, handler exhausted
 *   retries, DLQ unavailable). Providers retry on their own schedule.
 *
 * @beta
 */
export type HandlerDecision =
  | { readonly status: 200; readonly code: 'processed' | 'duplicate' | 'in_flight' | 'no_handler' }
  | { readonly status: 400; readonly code: Extract<FlintErrorCode, 'invalid_signature' | 'stale_timestamp' | 'malformed_payload'> }
  | { readonly status: 500; readonly code: Extract<FlintErrorCode, 'store_unavailable' | 'handler_failed' | 'handler_timeout'> | 'dlq_unavailable' };

/**
 * Configuration accepted by {@link createWebhookHandler}.
 *
 * @typeParam TPayload - Provider-specific event payload type. Inferred from
 *   the `provider` field; user handlers receive the same typed payload.
 *
 * @beta
 */
export interface HandlerConfig<TPayload = unknown> {
  /**
   * Provider implementation that verifies inbound requests and produces
   * typed events. The only mandatory port.
   */
  readonly provider: WebhookProvider<TPayload>;

  /**
   * Idempotency store guarding against duplicate processing.
   *
   * Mandatory: without it, every provider retry would re-run the handler.
   * Use the in-memory adapter for tests and single-process deployments;
   * Postgres or Redis for production fleets.
   */
  readonly idempotency: IdempotencyStore;

  /**
   * Map from event type strings to handler callbacks.
   *
   * Keys must match {@link VerifiedEvent.type} values verbatim. Unmatched
   * event types short-circuit with `{ status: 200, code: 'no_handler' }`
   * and never touch the idempotency store — keeping the door open for
   * future handlers to claim those IDs cleanly.
   */
  readonly on: Readonly<Record<string, EventHandler<TPayload>>>;

  /**
   * Optional dead-letter queue receiving events that exhaust their retry
   * budget. Omit to disable DLQ — exhausted events will surface as
   * `{ status: 500, code: 'handler_failed' }` and the provider's own
   * redelivery becomes the last line of defense.
   */
  readonly dlq?: DeadLetterQueue;

  /**
   * Retry policy. Defaults: 3 attempts, 200ms base, 5s cap, full jitter.
   */
  readonly retry?: Partial<RetryPolicy>;

  /**
   * Timeout policy. Defaults: 5s for verify, 25s per handler attempt.
   */
  readonly timeouts?: Partial<TimeoutPolicy>;

  /**
   * Clock function returning the current time in milliseconds since epoch.
   * Injected for deterministic testing; production uses `Date.now`.
   *
   * @defaultValue `Date.now`
   */
  readonly clock?: () => number;
}

/**
 * The handler returned by {@link createWebhookHandler}.
 *
 * Holds no mutable state of its own — all state lives behind the injected
 * ports. Safe to reuse across concurrent requests.
 *
 * @beta
 */
export interface FlintHandler<TPayload = unknown> {
  /**
   * Runs an inbound request through the full seven-gate pipeline.
   *
   * Never throws. Every failure mode produces a typed
   * {@link HandlerDecision}. Internal retries happen before the decision
   * is returned — the caller (and the provider) sees one final outcome.
   *
   * @param req - Normalized request from the framework adapter.
   * @returns The decision the framework adapter should translate to HTTP.
   */
  process(req: RawHttpRequest): Promise<HandlerDecision>;

  /**
   * Resolved retry policy after defaults applied. Exposed read-only for
   * observability and tests.
   */
  readonly retry: RetryPolicy;

  /**
   * Resolved timeout policy after defaults applied. Exposed read-only for
   * observability and tests.
   */
  readonly timeouts: TimeoutPolicy;
}

const DEFAULT_RETRY: RetryPolicy = Object.freeze({
  maxAttempts: 3,
  baseDelayMs: 200,
  maxDelayMs: 5000,
});

const DEFAULT_TIMEOUTS: TimeoutPolicy = Object.freeze({
  verifyTimeoutMs: 5000,
  handlerTimeoutMs: 25000,
});

function createTimeoutSignal(ms: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    dispose: () => clearTimeout(timer),
  };
}

function computeBackoff(attempt: number, policy: RetryPolicy): number {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  return Math.floor(Math.random() * capped);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

/**
 * Constructs a Flint webhook handler from a provider, store, and route map.
 *
 * The returned handler is stateless — all durable state lives behind the
 * injected ports. One instance serves any number of concurrent requests.
 *
 * The pipeline walks seven gates in strict order: normalize → verify
 * signature → check timestamp → parse payload → claim event ID → route
 * by type → dispatch with retries. Each gate either advances the event or
 * short-circuits with a specific decision. Only the seventh gate ever
 * invokes user code.
 *
 * ### Retry semantics
 *
 * Failures inside the user handler are retried with exponential backoff
 * and full jitter, bounded by `retry.maxAttempts`. Retries happen
 * **internally** before {@link FlintHandler.process} returns — the
 * provider sees one final outcome, not N intermediate failures. Verify,
 * timestamp, payload, and idempotency failures are not retried by Flint;
 * they either reflect an invalid request (400) or an unavailable
 * dependency the provider's own redelivery will retry against (500).
 *
 * ### Release-before-park
 *
 * When retries exhaust and a {@link DeadLetterQueue} is configured, the
 * handler **releases** the idempotency claim before parking the entry.
 * The event is in the DLQ — durable, owned by humans. If we left the
 * claim as completed, a re-drive operator replaying the DLQ entry would
 * hit `'duplicate'` and skip the work entirely. By releasing, a re-drive
 * flows through the normal pipeline and runs cleanly.
 *
 * The trade-off: between exhausting retries and parking, a tiny window
 * exists where another provider retry could arrive and observe `'fresh'`,
 * starting parallel processing. This is acceptable — user handlers should
 * be idempotent on their own side effects (database writes, outbound API
 * calls). Flint does not promise to prevent double-processing across DLQ
 * re-drives; we promise to prevent it within a single delivery cycle.
 *
 * @example
 * ```ts
 * const flint = createWebhookHandler({
 *   provider: stripeProvider,
 *   idempotency: new InMemoryIdempotencyStore(),
 *   on: {
 *     'payment_intent.succeeded': async (event, ctx) => {
 *       await db.charges.markPaid(event.payload.data.object.id, { signal: ctx.signal });
 *     },
 *   },
 * });
 *
 * const decision = await flint.process(rawReq);
 * res.status(decision.status).end();
 * ```
 *
 * @param config - Provider, store, route map, and optional policies.
 * @returns A reusable handler. Stateless and safe to share across requests.
 *
 * @beta
 */
export function createWebhookHandler<TPayload = unknown>(
  config: HandlerConfig<TPayload>,
): FlintHandler<TPayload> {
  const retry: RetryPolicy = { ...DEFAULT_RETRY, ...config.retry };
  const timeouts: TimeoutPolicy = { ...DEFAULT_TIMEOUTS, ...config.timeouts };
  const clock = config.clock ?? Date.now;
  const { provider, idempotency, on, dlq } = config;

  async function dispatchWithRetry(
    event: VerifiedEvent<TPayload>,
    handler: EventHandler<TPayload>,
  ): Promise<HandlerDecision> {
    let lastError: HandlerExecutionError | HandlerTimeoutError | null = null;

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const { signal, dispose } = createTimeoutSignal(timeouts.handlerTimeoutMs);
      const ctx: HandlerContext = Object.freeze({ attempt, signal });

      try {
        await handler(event, ctx);
        dispose();
        await idempotency.markCompleted(event.id, signal);
        return { status: 200, code: 'processed' };
      } catch (err) {
        dispose();

        const wrapped = signal.aborted
          ? new HandlerTimeoutError(
              `handler exceeded ${timeouts.handlerTimeoutMs}ms budget on attempt ${attempt}`,
              { timeoutMs: timeouts.handlerTimeoutMs, eventId: event.id },
              { cause: err },
            )
          : new HandlerExecutionError(
              `handler threw on attempt ${attempt}`,
              { attempt, eventId: event.id },
              { cause: err },
            );
        lastError = wrapped;

        const isLastAttempt = attempt >= retry.maxAttempts;
        if (isLastAttempt) break;

        const backoffMs = computeBackoff(attempt, retry);
        console.warn(
          `[flint] handler attempt ${attempt}/${retry.maxAttempts} failed for event ${event.id} (${wrapped.code}); retrying in ${backoffMs}ms`,
        );
        await sleep(backoffMs, signal);
      }
    }

    const finalError = lastError as HandlerExecutionError | HandlerTimeoutError;
    await idempotency.release(event.id, AbortSignal.timeout(timeouts.handlerTimeoutMs));

    if (dlq) {
      const entry: DeadLetterEntry = Object.freeze({
        event,
        attempts: retry.maxAttempts,
        lastErrorCode: finalError.code,
        lastErrorMessage: finalError.message,
        failedAt: new Date(clock()),
      });
      try {
        await dlq.park(entry, AbortSignal.timeout(timeouts.handlerTimeoutMs));
      } catch (dlqErr) {
        console.error(`[flint] DLQ park failed for event ${event.id}`, dlqErr);
        return { status: 500, code: 'dlq_unavailable' };
      }
    }

    return { status: 500, code: finalError.code };
  }

  async function process(req: RawHttpRequest): Promise<HandlerDecision> {
    // Gate 1–4: verify (signature, timestamp, payload) under bounded timeout.
    const verifyCtl = createTimeoutSignal(timeouts.verifyTimeoutMs);
    let event: VerifiedEvent<TPayload>;
    try {
      event = await provider.verify(req, verifyCtl.signal);
    } catch (err) {
      verifyCtl.dispose();
      if (err instanceof WebhookSignatureError) return { status: 400, code: 'invalid_signature' };
      if (err instanceof WebhookTimestampError) return { status: 400, code: 'stale_timestamp' };
      if (err instanceof WebhookPayloadError) return { status: 400, code: 'malformed_payload' };
      if (err instanceof FlintError) return { status: 500, code: 'handler_failed' };
      console.error('[flint] unknown error during verify', err);
      return { status: 500, code: 'handler_failed' };
    }
    verifyCtl.dispose();

    // Gate 6: route lookup. We check this BEFORE claiming, so unmatched
    // event types don't consume an idempotency slot.
    const handler = on[event.type];
    if (!handler) {
      return { status: 200, code: 'no_handler' };
    }

    // Gate 5: idempotency claim.
    let claim;
    try {
      claim = await idempotency.tryClaim(event.id, AbortSignal.timeout(timeouts.handlerTimeoutMs));
    } catch (err) {
      console.error(`[flint] idempotency store error for event ${event.id}`, err);
      return { status: 500, code: 'store_unavailable' };
    }
    if (claim === 'duplicate') return { status: 200, code: 'duplicate' };
    if (claim === 'in_flight') return { status: 200, code: 'in_flight' };

    // Gate 7: dispatch with retries. Only claim === 'fresh' reaches here.
    return dispatchWithRetry(event, handler);
  }

  return Object.freeze({ process, retry, timeouts });
}