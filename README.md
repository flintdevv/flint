# Flint

Resilient webhook handlers for modern backends.

> 🚧 **Pre-release.** Active development. APIs are unstable. Don't use in production yet.

## What this is

Flint is a TypeScript SDK for handling incoming webhooks correctly: signature verification, idempotency, retries, dead-letter queues, and out-of-order delivery — implemented once, reused everywhere.

The first provider is Stripe. The architecture is designed so adding PayPal, Adyen, Square, GitHub, Shopify, and others is just a new adapter at the same interface.

## Status

Pre-0.1. Not yet published to npm.

## License

[MIT](./LICENSE)
