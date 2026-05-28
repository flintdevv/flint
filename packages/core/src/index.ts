// @flintdev/core
// Provider-agnostic webhook handling kernel.
export type { RawHttpRequest, VerifiedEvent, HandlerContext } from './types.js';
export type { FlintErrorCode } from './errors.js';
export {
  FlintError,
  WebhookSignatureError,
  WebhookTimestampError,
  WebhookPayloadError,
  IdempotencyStoreError,
  HandlerExecutionError,
  HandlerTimeoutError,
} from './errors.js';
export type { ClaimResult, IdempotencyStore } from './ports/idempotency-store.js';
export type { DeadLetterEntry, DeadLetterQueue } from './ports/dead-letter-queue.js';
export {
  createWebhookHandler,
  type FlintHandler,
  type HandlerConfig,
  type HandlerDecision,
  type EventHandler,
  type RetryPolicy,
  type TimeoutPolicy,
} from './handler.js';
export {
  InMemoryIdempotencyStore,
  type InMemoryIdempotencyStoreOptions,
} from './adapters/in-memory.js';