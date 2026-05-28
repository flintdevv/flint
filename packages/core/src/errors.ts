/**
 * Typed error hierarchy for the Flint runtime.
 *
 * Every failure mode the SDK can surface is one of these classes. Application
 * code branches on `instanceof FlintError` first, then on the subclass or
 * the stable `code` string. Framework adapters map `httpStatus` to the
 * outbound HTTP response.
 *
 * Error messages are intentionally English and technical — these are
 * developer-facing diagnostics, not end-user copy.
 */

/**
 * Machine-readable identifiers for every {@link FlintError} subclass.
 *
 * Stable across versions: once shipped, a code is never repurposed. New
 * failure modes get new codes. Used by log aggregators and `switch`
 * statements that need to branch without `instanceof` checks.
 *
 * @beta
 */
export type FlintErrorCode =
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'malformed_payload'
  | 'store_unavailable'
  | 'handler_failed'
  | 'handler_timeout';

/**
 * Base class for every error thrown or returned by Flint.
 *
 * Use `err instanceof FlintError` to distinguish Flint errors from arbitrary
 * runtime errors (network, database, third-party libraries). Each subclass
 * fixes its own `code` and `httpStatus`; this base never produces a useful
 * instance on its own, so it is `abstract`.
 *
 * @beta
 */
export abstract class FlintError extends Error {
  /**
   * Stable machine-readable identifier for the failure mode.
   */
  abstract readonly code: FlintErrorCode;

  /**
   * HTTP status code the framework adapter should respond with.
   *
   * Drives retry behavior at the provider end: 4xx tells the provider the
   * request was invalid (don't retry); 5xx tells them our system failed
   * (do retry, per their schedule).
   */
  abstract readonly httpStatus: 400 | 500;

  /**
   * Constructs a Flint error and preserves the stack trace.
   *
   * @param message - Developer-facing diagnostic. Should describe the failure
   *   precisely enough to debug from logs alone.
   * @param options - Standard `ErrorOptions`. `cause` chains an underlying
   *   error and is preserved through serialization.
   */
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/**
 * The HMAC signature on an incoming webhook did not match the expected value.
 *
 * Indicates a forged request, a tampered body, a missing or malformed
 * signature header, or a misconfigured signing secret. Always returns HTTP
 * 400 — the provider should not retry, because retrying a forged request
 * does not make it authentic.
 *
 * @example
 * ```ts
 * try {
 *   await flintHandler(req);
 * } catch (err) {
 *   if (err instanceof WebhookSignatureError) {
 *     logger.warn({ code: err.code }, 'rejected forged or tampered webhook');
 *   }
 * }
 * ```
 *
 * @beta
 */
export class WebhookSignatureError extends FlintError {
  readonly code = 'invalid_signature' as const;
  readonly httpStatus = 400 as const;
}

/**
 * The webhook event's timestamp is outside the accepted tolerance window.
 *
 * Defends against replay attacks: an attacker who captured a valid webhook
 * cannot resend it hours later. Tolerance is typically 5 minutes (matches
 * Stripe's recommendation). Always HTTP 400 — replays should not be retried.
 *
 * @beta
 */
export class WebhookTimestampError extends FlintError {
  readonly code = 'stale_timestamp' as const;
  readonly httpStatus = 400 as const;

  /**
   * Event timestamp as reported by the provider, in seconds since epoch.
   */
  readonly eventTimestamp: number;

  /**
   * Configured tolerance window, in seconds.
   */
  readonly toleranceSeconds: number;

  /**
   * @param message - Developer-facing diagnostic.
   * @param details - The event timestamp and configured tolerance, used by
   *   logs and tests to assert on specifics.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(
    message: string,
    details: { eventTimestamp: number; toleranceSeconds: number },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.eventTimestamp = details.eventTimestamp;
    this.toleranceSeconds = details.toleranceSeconds;
  }
}

/**
 * The webhook body passed signature verification but could not be parsed
 * into the provider's event shape.
 *
 * Distinct from {@link WebhookSignatureError}: signature failure suggests an
 * attacker; payload failure suggests the provider sent something unexpected
 * (a new event shape, a schema change, an upstream bug). Different alerting
 * thresholds apply.
 *
 * @beta
 */
export class WebhookPayloadError extends FlintError {
  readonly code = 'malformed_payload' as const;
  readonly httpStatus = 400 as const;
}

/**
 * The configured {@link IdempotencyStore} could not service a request.
 *
 * Thrown by storage adapters (Postgres, Redis, custom backends) when their
 * underlying connection fails. HTTP 500 — the provider should retry, because
 * this is a transient infrastructure problem, not a malformed request.
 *
 * Custom adapter authors throw this from their `tryClaim` implementations.
 *
 * @example
 * ```ts
 * // Inside a custom adapter
 * try {
 *   await pgClient.query('INSERT INTO seen_events ...');
 * } catch (err) {
 *   throw new IdempotencyStoreError('postgres tryClaim failed', { cause: err });
 * }
 * ```
 *
 * @beta
 */
export class IdempotencyStoreError extends FlintError {
  readonly code = 'store_unavailable' as const;
  readonly httpStatus = 500 as const;
}

/**
 * A user-supplied handler in the `on:` map threw an error.
 *
 * Flint catches whatever the handler threw, wraps it in this class, and
 * places the original on `cause`. The framework adapter sees a single
 * `FlintError` shape regardless of which user library failed.
 *
 * Retry logic inside the handler reads {@link HandlerExecutionError.attempt}
 * to know how many tries have been spent; the DLQ receives the final
 * instance after retries exhaust.
 *
 * @beta
 */
export class HandlerExecutionError extends FlintError {
  readonly code = 'handler_failed' as const;
  readonly httpStatus = 500 as const;

  /**
   * 1-indexed attempt number at which the handler threw.
   */
  readonly attempt: number;

  /**
   * Event ID the handler was processing. Useful for DLQ correlation.
   */
  readonly eventId: string;

  /**
   * @param message - Developer-facing diagnostic.
   * @param details - Attempt number and event ID for downstream correlation.
   * @param options - Standard `ErrorOptions`; pass the user's original error
   *   as `cause` to preserve the underlying stack.
   */
  constructor(
    message: string,
    details: { attempt: number; eventId: string },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.attempt = details.attempt;
    this.eventId = details.eventId;
  }
}

/**
 * A user-supplied handler exceeded its configured per-event timeout.
 *
 * Distinct from {@link HandlerExecutionError}: a timeout means the handler
 * was still running when the budget elapsed, not that it threw. The
 * `AbortSignal` on the handler's context was triggered; handlers that
 * honored it bailed out cleanly. Handlers that ignored it may still be
 * running in the background — they should be fixed to respect the signal.
 *
 * @beta
 */
export class HandlerTimeoutError extends FlintError {
  readonly code = 'handler_timeout' as const;
  readonly httpStatus = 500 as const;

  /**
   * Configured timeout budget in milliseconds.
   */
  readonly timeoutMs: number;

  /**
   * Event ID the handler was processing when it timed out.
   */
  readonly eventId: string;

  /**
   * @param message - Developer-facing diagnostic.
   * @param details - Timeout budget and event ID.
   * @param options - Standard `ErrorOptions`.
   */
  constructor(
    message: string,
    details: { timeoutMs: number; eventId: string },
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.timeoutMs = details.timeoutMs;
    this.eventId = details.eventId;
  }
}