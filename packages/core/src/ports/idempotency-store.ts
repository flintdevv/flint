/**
 * Outcome of attempting to claim an event ID in the {@link IdempotencyStore}.
 *
 * Three states, ordered by how the handler should react:
 *
 * - `'fresh'` — first time seeing this ID. The caller now owns processing
 *   it and must eventually call {@link IdempotencyStore.markCompleted} or
 *   {@link IdempotencyStore.release}.
 * - `'duplicate'` — this ID has already been fully processed. The caller
 *   short-circuits with success and never invokes user logic.
 * - `'in_flight'` — another worker (different process, different replica)
 *   is currently processing this ID. The caller short-circuits to avoid
 *   double work; the in-flight worker will eventually complete or release.
 *
 * @beta
 */
export type ClaimResult = 'fresh' | 'duplicate' | 'in_flight';

/**
 * Contract for deduplicating webhook events across one or many processes.
 *
 * Implementations must guarantee that for any given `eventId`, at most one
 * concurrent caller observes {@link ClaimResult} `'fresh'`. All others must
 * observe `'duplicate'` (if processing already finished) or `'in_flight'`
 * (if processing is still underway).
 *
 * This atomicity is the single critical invariant — it is what makes Flint
 * safe against the inherent at-least-once delivery of every webhook
 * provider. Adapter authors who cannot guarantee atomic claims must not
 * implement this interface.
 *
 * @example
 * ```ts
 * // Inside Flint's handler (illustrative)
 * const result = await store.tryClaim(event.id, signal);
 * switch (result) {
 *   case 'duplicate':
 *   case 'in_flight':
 *     return { status: 200 };
 *   case 'fresh':
 *     try {
 *       await userHandler(event, ctx);
 *       await store.markCompleted(event.id, signal);
 *     } catch (err) {
 *       await store.release(event.id, signal);
 *       throw err;
 *     }
 * }
 * ```
 *
 * @beta
 */
export interface IdempotencyStore {
  /**
   * Attempts to claim exclusive processing rights for an event.
   *
   * Adapters implement this as a single atomic operation against their
   * backend — `INSERT … ON CONFLICT DO NOTHING RETURNING status` for
   * Postgres, `SET NX EX` for Redis, a guarded `Map` mutation for the
   * in-memory adapter. The atomicity is what defends against the race
   * where two webhook deliveries arrive at two replicas simultaneously.
   *
   * @param eventId - The provider's stable event identifier
   *   ({@link VerifiedEvent.id}). Adapters treat it as an opaque string;
   *   no parsing, no normalization.
   * @param signal - Cancellation signal honored by network-backed adapters
   *   (Postgres, Redis). In-memory adapters ignore it.
   * @returns The claim outcome. `'fresh'` transfers ownership to the
   *   caller; `'duplicate'` and `'in_flight'` indicate the caller should
   *   short-circuit.
   * @throws {IdempotencyStoreError} When the underlying storage is
   *   unreachable, returns an unexpected error, or violates the atomicity
   *   contract. Never thrown for valid `'duplicate'` or `'in_flight'`
   *   outcomes — those are normal results, not errors.
   */
  tryClaim(eventId: string, signal: AbortSignal): Promise<ClaimResult>;

  /**
   * Finalizes a successful claim, marking the event as processed.
   *
   * Called after the user handler returns without throwing. Subsequent
   * calls to {@link IdempotencyStore.tryClaim} with the same `eventId`
   * must return `'duplicate'`. Implementations may set a TTL on the
   * record; the TTL must be longer than the provider's maximum retry
   * window (Stripe's is roughly 3 days; 7 days is a safe minimum).
   *
   * @param eventId - The event ID previously claimed.
   * @param signal - Cancellation signal.
   * @throws {IdempotencyStoreError} When the storage operation fails.
   *   The handler treats this as a 500 — the claim is in limbo, the
   *   provider will retry, and the next attempt will see `'in_flight'`
   *   until the original record either completes or expires.
   */
  markCompleted(eventId: string, signal: AbortSignal): Promise<void>;

  /**
   * Releases an in-flight claim so it can be retried.
   *
   * Called after the user handler throws and Flint decides the failure
   * is retryable. The next call to {@link IdempotencyStore.tryClaim} for
   * this `eventId` must return `'fresh'` again, transferring ownership
   * to whichever worker the provider retries against.
   *
   * Critically: implementations must distinguish a deliberate release
   * from an abandoned claim. A worker that crashes mid-handler leaves
   * its claim in `'in_flight'`; adapters should expire stale claims
   * after a bounded TTL (typically 60–120 seconds) so retries are not
   * blocked indefinitely.
   *
   * @param eventId - The event ID previously claimed.
   * @param signal - Cancellation signal.
   * @throws {IdempotencyStoreError} When the storage operation fails.
   */
  release(eventId: string, signal: AbortSignal): Promise<void>;
}