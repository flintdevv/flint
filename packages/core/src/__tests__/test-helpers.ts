import type {
  ClaimResult,
  DeadLetterEntry,
  DeadLetterQueue,
  HandlerContext,
  IdempotencyStore,
  RawHttpRequest,
  VerifiedEvent,
  WebhookProvider,
} from '../index.js';

/**
 * Builds a minimal {@link VerifiedEvent} suitable for handler tests.
 *
 * Tests rarely care about the entire shape — they only assert on a couple
 * of fields. This helper fills in the rest with sensible defaults so each
 * test stays focused on the behavior it's exercising.
 *
 * @internal
 */
export function makeEvent<TPayload = unknown>(
  overrides: Partial<VerifiedEvent<TPayload>> = {},
): VerifiedEvent<TPayload> {
  return Object.freeze({
    id: 'evt_test_default',
    type: 'test.event',
    provider: 'fake',
    payload: {} as TPayload,
    receivedAt: new Date('2026-01-01T00:00:00Z'),
    livemode: false,
    ...overrides,
  });
}

/**
 * Builds a minimal {@link RawHttpRequest} for tests that need one but
 * don't care about its contents (e.g. handler tests where the fake
 * provider ignores the request and returns a pre-built event).
 *
 * @internal
 */
export function makeRawRequest(
  overrides: Partial<RawHttpRequest> = {},
): RawHttpRequest {
  return Object.freeze({
    body: Buffer.from('{}'),
    headers: {},
    ...overrides,
  });
}

/**
 * Configuration accepted by {@link fakeProvider}.
 *
 * @internal
 */
export interface FakeProviderOptions<TPayload = unknown> {
  /**
   * Event to return from `verify`. If omitted, the provider throws — pass
   * `throws` to control what.
   */
  readonly event?: VerifiedEvent<TPayload>;

  /**
   * Error to throw from `verify` instead of returning the event.
   */
  readonly throws?: unknown;

  /**
   * Provider identifier. Defaults to `'fake'`.
   */
  readonly id?: string;
}

/**
 * Builds a {@link WebhookProvider} that returns a pre-built event or
 * throws a pre-built error. Records every call for assertions.
 *
 * @internal
 */
export interface FakeProvider<TPayload = unknown>
  extends WebhookProvider<TPayload> {
  readonly calls: readonly RawHttpRequest[];
}

export function fakeProvider<TPayload = unknown>(
  options: FakeProviderOptions<TPayload> = {},
): FakeProvider<TPayload> {
  const calls: RawHttpRequest[] = [];
  return {
    id: options.id ?? 'fake',
    get calls() {
      return calls;
    },
    async verify(req: RawHttpRequest): Promise<VerifiedEvent<TPayload>> {
      calls.push(req);
      if (options.throws !== undefined) throw options.throws;
      if (options.event !== undefined) return options.event;
      throw new Error('fakeProvider: neither event nor throws provided');
    },
  } as FakeProvider<TPayload>;
}

/**
 * Configuration accepted by {@link fakeStore}.
 *
 * @internal
 */
export interface FakeStoreOptions {
  /**
   * Scripted sequence of {@link ClaimResult} values to return from
   * successive `tryClaim` calls. After the script is exhausted, the
   * store falls back to behaving as a real bounded in-memory store
   * (Map-backed) — `markCompleted` flips future claims to `'duplicate'`,
   * `release` flips them back to `'fresh'`.
   *
   * Leave undefined for fully realistic Map-backed behavior.
   */
  readonly claims?: readonly ClaimResult[];

  /**
   * If set, `tryClaim` throws this on every call. Used to test
   * `IdempotencyStoreError` handling in the handler.
   */
  readonly tryClaimThrows?: unknown;

  /**
   * If set, `markCompleted` throws this on every call.
   */
  readonly markCompletedThrows?: unknown;

  /**
   * If set, `release` throws this on every call.
   */
  readonly releaseThrows?: unknown;
}

/**
 * Builds an {@link IdempotencyStore} with scriptable or realistic
 * behavior. Records every operation for assertions.
 *
 * @internal
 */
export interface FakeStore extends IdempotencyStore {
  readonly tryClaimCalls: readonly string[];
  readonly markCompletedCalls: readonly string[];
  readonly releaseCalls: readonly string[];
}

export function fakeStore(options: FakeStoreOptions = {}): FakeStore {
  const tryClaimCalls: string[] = [];
  const markCompletedCalls: string[] = [];
  const releaseCalls: string[] = [];

  const completed = new Set<string>();
  const inFlight = new Set<string>();
  const script = options.claims ? [...options.claims] : null;

  return {
    get tryClaimCalls() {
      return tryClaimCalls;
    },
    get markCompletedCalls() {
      return markCompletedCalls;
    },
    get releaseCalls() {
      return releaseCalls;
    },
    async tryClaim(eventId: string): Promise<ClaimResult> {
      tryClaimCalls.push(eventId);
      if (options.tryClaimThrows !== undefined) throw options.tryClaimThrows;

      if (script !== null && script.length > 0) {
        return script.shift()!;
      }

      if (completed.has(eventId)) return 'duplicate';
      if (inFlight.has(eventId)) return 'in_flight';
      inFlight.add(eventId);
      return 'fresh';
    },
    async markCompleted(eventId: string): Promise<void> {
      markCompletedCalls.push(eventId);
      if (options.markCompletedThrows !== undefined) throw options.markCompletedThrows;
      inFlight.delete(eventId);
      completed.add(eventId);
    },
    async release(eventId: string): Promise<void> {
      releaseCalls.push(eventId);
      if (options.releaseThrows !== undefined) throw options.releaseThrows;
      inFlight.delete(eventId);
    },
  };
}

/**
 * Configuration accepted by {@link fakeDlq}.
 *
 * @internal
 */
export interface FakeDlqOptions {
  /**
   * If set, `park` throws this on every call. Used to test the
   * `dlq_unavailable` failure mode in the handler.
   */
  readonly parkThrows?: unknown;
}

/**
 * Builds a {@link DeadLetterQueue} that records every parked entry.
 *
 * @internal
 */
export interface FakeDlq extends DeadLetterQueue {
  readonly parked: readonly DeadLetterEntry[];
}

export function fakeDlq(options: FakeDlqOptions = {}): FakeDlq {
  const parked: DeadLetterEntry[] = [];
  return {
    get parked() {
      return parked;
    },
    async park(entry: DeadLetterEntry): Promise<void> {
      if (options.parkThrows !== undefined) throw options.parkThrows;
      parked.push(entry);
    },
  };
}

/**
 * Builds a scriptable user handler. Records every invocation along with
 * its {@link HandlerContext} so tests can assert on `attempt` and
 * `signal` behavior.
 *
 * @internal
 */
export interface FakeHandlerOptions {
  /**
   * Outcomes per attempt in order. `'ok'` resolves; an `Error` instance
   * causes the handler to throw that error. After the script is
   * exhausted, the handler resolves cleanly.
   */
  readonly script?: readonly ('ok' | Error)[];

  /**
   * If set, the handler waits this many milliseconds before resolving
   * (or rejecting). Used to test timeout behavior — pair with a small
   * `handlerTimeoutMs` in the handler config.
   */
  readonly delayMs?: number;
}

/**
 * Result type for {@link fakeHandler}.
 *
 * @internal
 */
export interface FakeHandlerCall<TPayload = unknown> {
  readonly event: VerifiedEvent<TPayload>;
  readonly attempt: number;
  readonly signal: AbortSignal;
}

export function fakeHandler<TPayload = unknown>(
  options: FakeHandlerOptions = {},
): {
  readonly fn: (event: VerifiedEvent<TPayload>, ctx: HandlerContext) => Promise<void>;
  readonly calls: readonly FakeHandlerCall<TPayload>[];
} {
  const calls: FakeHandlerCall<TPayload>[] = [];
  const script = options.script ? [...options.script] : [];

  const fn = async (
    event: VerifiedEvent<TPayload>,
    ctx: HandlerContext,
  ): Promise<void> => {
    calls.push({ event, attempt: ctx.attempt, signal: ctx.signal });

    if (options.delayMs !== undefined) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, options.delayMs);
        ctx.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            reject(new Error('aborted'));
          },
          { once: true },
        );
      });
    }

    const next = script.shift();
    if (next instanceof Error) throw next;
  };

  return { fn, calls };
}