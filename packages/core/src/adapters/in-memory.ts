import { IdempotencyStoreError } from '../errors.js';
import type {
  ClaimResult,
  IdempotencyStore,
} from '../ports/idempotency-store.js';

/**
 * Configuration accepted by {@link InMemoryIdempotencyStore}.
 *
 * All fields are optional — defaults are tuned for a small-to-mid Node
 * service processing thousands of webhooks per day.
 *
 * @beta
 */
export interface InMemoryIdempotencyStoreOptions {
  /**
   * Maximum total entries held across both in-flight and completed maps.
   *
   * Once reached, the least-recently-used entry from the affected map is
   * evicted to make room. At ~64 bytes per entry the default of 10 000
   * caps memory at roughly 640 KB.
   *
   * @defaultValue 10_000
   */
  readonly maxEntries?: number;

  /**
   * Lifetime of a completed claim, in milliseconds.
   *
   * Must exceed the longest provider retry window. Stripe retries for
   * approximately three days; the seven-day default provides a four-day
   * safety margin against clock drift, manual replays, and time-zone
   * delivery edge cases.
   *
   * @defaultValue 7 days (604_800_000 ms)
   */
  readonly completedTtlMs?: number;

  /**
   * Lifetime of an in-flight claim, in milliseconds.
   *
   * Defends against workers that crash mid-handler and leave their claim
   * orphaned forever. After this window the claim expires and the next
   * `tryClaim` returns `'fresh'`, unblocking the provider's retry.
   *
   * Set this longer than the slowest realistic handler execution. The
   * sixty-second default suits handlers that run in under thirty seconds.
   *
   * @defaultValue 60 000 ms
   */
  readonly inFlightTtlMs?: number;

  /**
   * Clock source returning the current time as milliseconds since epoch.
   *
   * Injected for deterministic testing — production uses `Date.now`.
   *
   * @defaultValue `Date.now`
   */
  readonly clock?: () => number;
}

/**
 * In-process implementation of {@link IdempotencyStore}.
 *
 * Suitable for single-process deployments, tests, and local development.
 * **Not safe for multi-replica deployments** — each process holds its own
 * map and they do not coordinate. Two replicas receiving the same event
 * via different load-balancer hops will each observe `'fresh'` and run
 * the handler twice. Production fleets must use a shared backend
 * (Postgres, Redis) implemented as a separate adapter against the same
 * port.
 *
 * ### Correctness model
 *
 * Atomicity is guaranteed by JavaScript's single-threaded execution
 * model. The {@link InMemoryIdempotencyStore.tryClaim} method performs
 * read-check-write with no `await` between steps, so no other call can
 * interleave. This holds within one Node process; it does not hold
 * across processes.
 *
 * ### Bounded memory
 *
 * Two maps are maintained — one for in-flight claims, one for completed.
 * Each is bounded by `maxEntries`. When a map reaches capacity, the
 * least-recently-used entry is evicted before the new one is inserted.
 *
 * LRU ordering is encoded directly in JavaScript `Map` insertion order
 * — the language specification guarantees that iteration order matches
 * insertion order. To mark an entry as recently used we delete and
 * re-insert it; the eviction target is then always `map.keys().next()`,
 * which is the oldest. Every map operation involved (`get`, `delete`,
 * `set`, `keys().next()`) is O(1), so the entire claim path runs in
 * constant time regardless of map size.
 *
 * This avoids pulling in a third-party LRU library and avoids the
 * pointer-shuffling that doubly-linked-list LRU implementations need —
 * the engine's hash-map plus insertion order already provides both
 * guarantees natively.
 *
 * ### Lazy expiration
 *
 * Entries carry a `claimedAt` or `completedAt` timestamp. On every
 * lookup, the entry's age is compared against the configured TTL and
 * the entry is dropped if expired. There is no background sweeper —
 * stale entries occupy slots until the capacity cap evicts them or
 * they are queried again. This trades a small bounded waste of slots
 * for zero idle CPU.
 *
 * @example
 * ```ts
 * const store = new InMemoryIdempotencyStore();
 * const flint = createWebhookHandler({ provider, idempotency: store, on: ... });
 * ```
 *
 * @example
 * ```ts
 * // Tuned for higher throughput
 * const store = new InMemoryIdempotencyStore({
 *   maxEntries: 100_000,
 *   completedTtlMs: 14 * 24 * 60 * 60 * 1000,
 * });
 * ```
 *
 * @beta
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  readonly #inFlight = new Map<string, number>();
  readonly #completed = new Map<string, number>();
  readonly #maxEntries: number;
  readonly #completedTtlMs: number;
  readonly #inFlightTtlMs: number;
  readonly #now: () => number;

  /**
   * @param options - Optional sizing and lifetime configuration. Any field
   *   omitted uses the documented default.
   * @throws {IdempotencyStoreError} When `maxEntries`, `completedTtlMs`,
   *   or `inFlightTtlMs` is non-positive. Catches misconfiguration at
   *   construction rather than at first request.
   */
  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000;
    const completedTtlMs = options.completedTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    const inFlightTtlMs = options.inFlightTtlMs ?? 60_000;

    if (maxEntries <= 0 || !Number.isFinite(maxEntries)) {
      throw new IdempotencyStoreError('maxEntries must be a positive finite number');
    }
    if (completedTtlMs <= 0 || !Number.isFinite(completedTtlMs)) {
      throw new IdempotencyStoreError('completedTtlMs must be a positive finite number');
    }
    if (inFlightTtlMs <= 0 || !Number.isFinite(inFlightTtlMs)) {
      throw new IdempotencyStoreError('inFlightTtlMs must be a positive finite number');
    }

    this.#maxEntries = maxEntries;
    this.#completedTtlMs = completedTtlMs;
    this.#inFlightTtlMs = inFlightTtlMs;
    this.#now = options.clock ?? Date.now;
  }

  /**
   * Number of entries currently held across both maps. Exposed for
   * observability and tests; not part of the {@link IdempotencyStore}
   * contract.
   *
   * @beta
   */
  get size(): number {
    return this.#inFlight.size + this.#completed.size;
  }

  async tryClaim(eventId: string): Promise<ClaimResult> {
    const now = this.#now();

    const completedAt = this.#completed.get(eventId);
    if (completedAt !== undefined) {
      if (now - completedAt < this.#completedTtlMs) {
        this.#touch(this.#completed, eventId, completedAt);
        return 'duplicate';
      }
      this.#completed.delete(eventId);
    }

    const claimedAt = this.#inFlight.get(eventId);
    if (claimedAt !== undefined) {
      if (now - claimedAt < this.#inFlightTtlMs) {
        return 'in_flight';
      }
      this.#inFlight.delete(eventId);
    }

    if (this.#inFlight.size >= this.#maxEntries) {
      const oldest = this.#inFlight.keys().next().value;
      if (oldest !== undefined) this.#inFlight.delete(oldest);
    }
    this.#inFlight.set(eventId, now);
    return 'fresh';
  }

  async markCompleted(eventId: string): Promise<void> {
    this.#inFlight.delete(eventId);

    if (this.#completed.size >= this.#maxEntries) {
      const oldest = this.#completed.keys().next().value;
      if (oldest !== undefined) this.#completed.delete(oldest);
    }
    this.#completed.set(eventId, this.#now());
  }

  async release(eventId: string): Promise<void> {
    this.#inFlight.delete(eventId);
  }

  #touch(map: Map<string, number>, key: string, value: number): void {
    map.delete(key);
    map.set(key, value);
  }
}