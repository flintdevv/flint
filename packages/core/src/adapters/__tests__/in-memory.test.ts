import { beforeEach, describe, expect, it } from 'vitest';

import { IdempotencyStoreError } from '../../errors.js';
import { InMemoryIdempotencyStore } from '../in-memory.js';

/**
 * Manually advanceable clock. Each test constructs its own so time
 * starts at zero and moves forward only when the test says so —
 * no real timers, no flakiness, no ordering between tests.
 */
function makeClock(start = 0) {
    let now = start;
    return {
        now: () => now,
        advance: (ms: number) => {
            now += ms;
        },
        set: (ms: number) => {
            now = ms;
        },
    };
}

describe('InMemoryIdempotencyStore', () => {
    describe('three-state lifecycle', () => {
        it('returns "fresh" for a brand-new event id', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            const result = await store.tryClaim('evt_001');

            expect(result).toBe('fresh');
        });

        it('returns "in_flight" while a claim is held', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            await store.tryClaim('evt_001');
            const second = await store.tryClaim('evt_001');

            expect(second).toBe('in_flight');
        });

        it('returns "duplicate" after markCompleted', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            await store.tryClaim('evt_001');
            await store.markCompleted('evt_001');

            expect(await store.tryClaim('evt_001')).toBe('duplicate');
        });

        it('returns "fresh" again after release', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            await store.tryClaim('evt_001');
            await store.release('evt_001');

            expect(await store.tryClaim('evt_001')).toBe('fresh');
        });

        it('does not turn a completed entry into "fresh" via release', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            await store.tryClaim('evt_001');
            await store.markCompleted('evt_001');
            await store.release('evt_001');

            // Completion is a one-way trip; release only clears in-flight.
            expect(await store.tryClaim('evt_001')).toBe('duplicate');
        });
    });

    describe('lazy TTL expiration', () => {
        it('expires a completed entry once past completedTtlMs', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({
                completedTtlMs: 1_000,
                clock: clock.now,
            });

            await store.tryClaim('evt_001');
            await store.markCompleted('evt_001');

            clock.advance(999);
            expect(await store.tryClaim('evt_001')).toBe('duplicate');

            clock.advance(2); // total elapsed 1001ms > 1000ms TTL
            expect(await store.tryClaim('evt_001')).toBe('fresh');
        });

        it('expires an abandoned in-flight claim once past inFlightTtlMs', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({
                inFlightTtlMs: 1_000,
                clock: clock.now,
            });

            await store.tryClaim('evt_001');

            clock.advance(999);
            expect(await store.tryClaim('evt_001')).toBe('in_flight');

            clock.advance(2);
            expect(await store.tryClaim('evt_001')).toBe('fresh');
        });

        it('touches a completed entry on lookup so it stays warm in LRU', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({
                maxEntries: 2,
                clock: clock.now,
            });

            await store.tryClaim('evt_old');
            await store.markCompleted('evt_old');

            await store.tryClaim('evt_new');
            await store.markCompleted('evt_new');

            // Touch evt_old by looking it up — moves it to most-recently-used.
            expect(await store.tryClaim('evt_old')).toBe('duplicate');

            // Now insert a third completed entry. evt_new is the oldest now, not evt_old.
            await store.tryClaim('evt_third');
            await store.markCompleted('evt_third');

            // evt_new (the older of the two) got evicted; evt_old survived.
            expect(await store.tryClaim('evt_old')).toBe('duplicate');
            expect(await store.tryClaim('evt_new')).toBe('fresh');
        });
    });

    describe('LRU eviction under capacity pressure', () => {
        it('evicts the oldest in-flight entry once maxEntries is reached', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({
                maxEntries: 2,
                clock: clock.now,
            });

            await store.tryClaim('evt_a');
            await store.tryClaim('evt_b');
            expect(store.size).toBe(2);

            await store.tryClaim('evt_c');
            expect(store.size).toBe(2);

            await store.tryClaim('evt_d');
            expect(store.size).toBe(2);
        });

        it('evicts the oldest completed entry independently of in-flight', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({
                maxEntries: 2,
                clock: clock.now,
            });

            await store.tryClaim('evt_a');
            await store.markCompleted('evt_a');
            await store.tryClaim('evt_b');
            await store.markCompleted('evt_b');

            await store.tryClaim('evt_c');
            await store.markCompleted('evt_c'); // evicts evt_a from completed map

            expect(await store.tryClaim('evt_a')).toBe('fresh');
            expect(await store.tryClaim('evt_b')).toBe('duplicate');
            expect(await store.tryClaim('evt_c')).toBe('duplicate');
        });
    });

    describe('observability', () => {
        it('exposes total size across both maps', async () => {
            const clock = makeClock();
            const store = new InMemoryIdempotencyStore({ clock: clock.now });

            expect(store.size).toBe(0);

            await store.tryClaim('evt_001');
            expect(store.size).toBe(1);

            await store.markCompleted('evt_001');
            expect(store.size).toBe(1); // moved between maps, not added

            await store.tryClaim('evt_002');
            expect(store.size).toBe(2);
        });
    });

    describe('construction guards', () => {
        let invalid: ReadonlyArray<{ label: string; opts: Record<string, unknown> }>;

        beforeEach(() => {
            invalid = [
                { label: 'maxEntries = 0', opts: { maxEntries: 0 } },
                { label: 'maxEntries = -1', opts: { maxEntries: -1 } },
                { label: 'maxEntries = Infinity', opts: { maxEntries: Number.POSITIVE_INFINITY } },
                { label: 'maxEntries = NaN', opts: { maxEntries: Number.NaN } },
                { label: 'completedTtlMs = 0', opts: { completedTtlMs: 0 } },
                { label: 'completedTtlMs = -1', opts: { completedTtlMs: -1 } },
                { label: 'inFlightTtlMs = 0', opts: { inFlightTtlMs: 0 } },
                { label: 'inFlightTtlMs = -1', opts: { inFlightTtlMs: -1 } },
            ];
        });

        it('throws IdempotencyStoreError for every invalid option', () => {
            for (const { label, opts } of invalid) {
                expect(
                    () => new InMemoryIdempotencyStore(opts),
                    `expected throw for ${label}`,
                ).toThrow(IdempotencyStoreError);
            }
        });

        it('accepts an empty options object and applies defaults', () => {
            const store = new InMemoryIdempotencyStore();
            expect(store.size).toBe(0);
        });
    });
});