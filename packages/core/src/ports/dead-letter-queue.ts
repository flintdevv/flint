import type { VerifiedEvent } from '../types.js';
import type { FlintErrorCode } from '../errors.js';

/**
 * A single failed event preserved for human or automated inspection.
 *
 * Produced by Flint's handler after a user callback has exhausted its
 * retry budget. Carries the verified event itself plus the metadata
 * needed to diagnose why it ended up here.
 *
 * @beta
 */
export interface DeadLetterEntry {
  /**
   * The verified event that could not be processed.
   *
   * Re-driving a failed event is as simple as re-feeding this object
   * through the handler. Adapters that persist the entry should store
   * it verbatim — losing fields here makes re-drive impossible.
   */
  readonly event: VerifiedEvent;

  /**
   * Total number of attempts spent before giving up.
   *
   * `1` if the handler was configured with no retries and the first
   * attempt threw. Higher values indicate the configured retry policy
   * was fully exhausted.
   */
  readonly attempts: number;

  /**
   * Stable error code of the final failure, if it was a Flint error.
   *
   * `null` when the final failure was an arbitrary error from outside
   * Flint's vocabulary (a database driver, a third-party library).
   * Pair with {@link DeadLetterEntry.lastErrorMessage} for the full
   * picture.
   */
  readonly lastErrorCode: FlintErrorCode | null;

  /**
   * Final error's message string, captured at the moment of failure.
   *
   * Always populated, even when {@link DeadLetterEntry.lastErrorCode}
   * is `null`. Adapters store this verbatim; never truncate or rewrite.
   */
  readonly lastErrorMessage: string;

  /**
   * Wall-clock time the entry was created — i.e. the moment retries
   * exhausted, not the moment the original event arrived.
   *
   * For arrival time, read {@link VerifiedEvent.receivedAt}. The gap
   * between the two is the total time Flint spent fighting to process
   * this event.
   */
  readonly failedAt: Date;
}

/**
 * Contract for parking events that could not be successfully processed.
 *
 * Concrete adapters wrap SQS, RabbitMQ, Kafka, a database table, or any
 * other durable queue. Flint ships no built-in adapter in v0.1 — every
 * production system has opinions about its queueing infrastructure, and
 * we refuse to pick one for them.
 *
 * Implementations must be durable. A DLQ that drops entries is worse
 * than no DLQ at all: it converts visible failures into silent ones.
 *
 * @example
 * ```ts
 * import type { DeadLetterQueue, DeadLetterEntry } from '@flintdev/core';
 *
 * class SqsDeadLetterQueue implements DeadLetterQueue {
 *   async park(entry: DeadLetterEntry, signal: AbortSignal): Promise<void> {
 *     await this.sqs.sendMessage({
 *       QueueUrl: this.queueUrl,
 *       MessageBody: JSON.stringify(entry),
 *     }, { abortSignal: signal });
 *   }
 * }
 * ```
 *
 * @beta
 */
export interface DeadLetterQueue {
  /**
   * Parks a failed event for later inspection or re-drive.
   *
   * Called by Flint exactly once per event whose retry budget was
   * exhausted. Implementations must persist the entry durably before
   * resolving the returned promise — a resolved promise is interpreted
   * as a commitment that the entry survives a process crash.
   *
   * @param entry - The failed event plus failure metadata.
   * @param signal - Cancellation signal for the underlying network or
   *   I/O operation. Implementations propagate it to their transport.
   * @throws {Error} When the underlying queue is unreachable or rejects
   *   the entry. Flint logs the failure and surfaces a 500 to the
   *   provider so the original webhook is retried by the provider's
   *   own redelivery mechanism — a last line of defense when our DLQ
   *   itself is down.
   */
  park(entry: DeadLetterEntry, signal: AbortSignal): Promise<void>;
}