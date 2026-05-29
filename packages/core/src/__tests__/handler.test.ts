import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createWebhookHandler,
  HandlerExecutionError,
  HandlerTimeoutError,
  IdempotencyStoreError,
  WebhookPayloadError,
  WebhookSignatureError,
  WebhookTimestampError,
  type DeadLetterEntry,
} from '../index.js';

import {
  fakeDlq,
  fakeHandler,
  fakeProvider,
  fakeStore,
  makeEvent,
  makeRawRequest,
} from './test-helpers.js';

describe('createWebhookHandler', () => {
  beforeEach(() => {
    // Backoff uses Math.random; pin it so retry delays are deterministic.
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  describe('happy path', () => {
    it('processes a fresh event end to end', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const handler = fakeHandler({ script: ['ok'] });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 200, code: 'processed' });
      expect(provider.calls).toHaveLength(1);
      expect(store.tryClaimCalls).toEqual(['evt_001']);
      expect(store.markCompletedCalls).toEqual(['evt_001']);
      expect(store.releaseCalls).toEqual([]);
      expect(handler.calls).toHaveLength(1);
      expect(handler.calls[0]?.attempt).toBe(1);
    });
  });

  describe('gate 5 — idempotency outcomes', () => {
    it('returns 200/duplicate without invoking the handler', async () => {
      const event = makeEvent({ type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore({ claims: ['duplicate'] });
      const handler = fakeHandler();

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 200, code: 'duplicate' });
      expect(handler.calls).toHaveLength(0);
      expect(store.markCompletedCalls).toEqual([]);
    });

    it('returns 200/in_flight without invoking the handler', async () => {
      const event = makeEvent({ type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore({ claims: ['in_flight'] });
      const handler = fakeHandler();

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 200, code: 'in_flight' });
      expect(handler.calls).toHaveLength(0);
    });

    it('returns 500/store_unavailable when tryClaim throws', async () => {
      const event = makeEvent({ type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore({
        tryClaimThrows: new IdempotencyStoreError('backend down'),
      });
      const handler = fakeHandler();

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 500, code: 'store_unavailable' });
      expect(handler.calls).toHaveLength(0);
    });
  });

  describe('gate 6 — route lookup', () => {
    it('returns 200/no_handler for unmatched event types', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'invoice.created' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const handler = fakeHandler();

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 200, code: 'no_handler' });

      // Critical: the idempotency store must NOT be touched. Unmatched events
      // never consume a slot — keeps the door open for future handlers.
      expect(store.tryClaimCalls).toEqual([]);
      expect(store.markCompletedCalls).toEqual([]);
      expect(handler.calls).toHaveLength(0);
    });
  });

  describe('gates 2-4 — provider verification failures', () => {
    it('returns 400/invalid_signature when provider throws WebhookSignatureError', async () => {
      const provider = fakeProvider({
        throws: new WebhookSignatureError('forged signature'),
      });
      const flint = createWebhookHandler({
        provider,
        idempotency: fakeStore(),
        on: {},
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 400, code: 'invalid_signature' });
    });

    it('returns 400/stale_timestamp when provider throws WebhookTimestampError', async () => {
      const provider = fakeProvider({
        throws: new WebhookTimestampError('too old', {
          eventTimestamp: 1_000,
          toleranceSeconds: 300,
        }),
      });
      const flint = createWebhookHandler({
        provider,
        idempotency: fakeStore(),
        on: {},
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 400, code: 'stale_timestamp' });
    });

    it('returns 400/malformed_payload when provider throws WebhookPayloadError', async () => {
      const provider = fakeProvider({
        throws: new WebhookPayloadError('bad JSON'),
      });
      const flint = createWebhookHandler({
        provider,
        idempotency: fakeStore(),
        on: {},
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 400, code: 'malformed_payload' });
    });

    it('returns 500/handler_failed when provider throws an arbitrary error', async () => {
      const provider = fakeProvider({
        throws: new Error('something exploded'),
      });
      const flint = createWebhookHandler({
        provider,
        idempotency: fakeStore(),
        on: {},
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 500, code: 'handler_failed' });
    });
  });

  describe('gate 7 — retry semantics', () => {
    it('retries after a handler throw and succeeds on attempt 2', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const handler = fakeHandler({
        script: [new Error('transient'), 'ok'],
      });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 200, code: 'processed' });
      expect(handler.calls.map((c) => c.attempt)).toEqual([1, 2]);
      expect(store.markCompletedCalls).toEqual(['evt_001']);
      expect(store.releaseCalls).toEqual([]);
    });

    it('exhausts retries and returns 500/handler_failed without a DLQ', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const handler = fakeHandler({
        script: [new Error('permanent'), new Error('permanent'), new Error('permanent')],
      });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 500, code: 'handler_failed' });
      expect(handler.calls.map((c) => c.attempt)).toEqual([1, 2, 3]);
      expect(store.markCompletedCalls).toEqual([]);
      // Critical: release before any DLQ logic, so re-drives work cleanly.
      expect(store.releaseCalls).toEqual(['evt_001']);
    });

    it('parks a DLQ entry after exhausting retries when DLQ is configured', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const dlq = fakeDlq();
      const handler = fakeHandler({
        script: [
          new Error('boom 1'),
          new Error('boom 2'),
          new Error('boom 3'),
        ],
      });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        dlq,
        on: { 'payment_intent.succeeded': handler.fn },
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 500, code: 'handler_failed' });
      expect(dlq.parked).toHaveLength(1);

      const entry = dlq.parked[0] as DeadLetterEntry;
      expect(entry.event.id).toBe('evt_001');
      expect(entry.attempts).toBe(3);
      expect(entry.lastErrorCode).toBe('handler_failed');
      expect(entry.lastErrorMessage).toContain('attempt 3');
      expect(entry.failedAt).toBeInstanceOf(Date);

      // Release must happen before park — DLQ re-drive depends on this.
      expect(store.releaseCalls).toEqual(['evt_001']);
    });

    it('returns 500/dlq_unavailable when DLQ park itself fails', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const dlq = fakeDlq({ parkThrows: new Error('queue offline') });
      const handler = fakeHandler({
        script: [new Error('a'), new Error('b'), new Error('c')],
      });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        dlq,
        on: { 'payment_intent.succeeded': handler.fn },
        retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 5 },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision).toEqual({ status: 500, code: 'dlq_unavailable' });
      // Release still happened — the failure is in the DLQ layer, not idempotency.
      expect(store.releaseCalls).toEqual(['evt_001']);
    });
  });

  describe('gate 7 — handler timeout', () => {
    it('aborts a slow handler and produces 500/handler_failed after retries', async () => {
      const event = makeEvent({ id: 'evt_001', type: 'payment_intent.succeeded' });
      const provider = fakeProvider({ event });
      const store = fakeStore();
      const handler = fakeHandler({ delayMs: 50 });

      const flint = createWebhookHandler({
        provider,
        idempotency: store,
        on: { 'payment_intent.succeeded': handler.fn },
        retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 5 },
        timeouts: { verifyTimeoutMs: 1_000, handlerTimeoutMs: 5 },
      });

      const decision = await flint.process(makeRawRequest());

      expect(decision.status).toBe(500);
      expect(decision.code).toBe('handler_timeout');
      expect(handler.calls.length).toBeGreaterThanOrEqual(1);
      // Each attempt got its own signal — confirm they were distinct objects.
      const signals = handler.calls.map((c) => c.signal);
      const unique = new Set(signals);
      expect(unique.size).toBe(signals.length);
    });
  });

  describe('configuration', () => {
    it('exposes resolved retry and timeout policies for observability', () => {
      const flint = createWebhookHandler({
        provider: fakeProvider({ event: makeEvent() }),
        idempotency: fakeStore(),
        on: {},
        retry: { maxAttempts: 5 },
        timeouts: { handlerTimeoutMs: 10_000 },
      });

      expect(flint.retry.maxAttempts).toBe(5);
      expect(flint.retry.baseDelayMs).toBe(200);
      expect(flint.retry.maxDelayMs).toBe(5_000);
      expect(flint.timeouts.handlerTimeoutMs).toBe(10_000);
      expect(flint.timeouts.verifyTimeoutMs).toBe(5_000);
    });
  });
});