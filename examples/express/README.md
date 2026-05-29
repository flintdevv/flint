# Flint × Express example

Minimal working Express server demonstrating Flint with the Stripe provider.

## What it does

- Listens on `POST /webhooks/stripe`
- Verifies the incoming Stripe signature
- Deduplicates events via the in-memory idempotency store
- Routes two event types to demo handlers:
  - `payment_intent.succeeded`
  - `customer.subscription.deleted`
- Exposes `GET /health` for liveness checks

## Run it locally

You need Node 20.18+ and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```bash
# From this directory
cp .env.example .env

# Install deps (run once)
pnpm install

# Start the server
pnpm dev
```

In another terminal, forward Stripe events to your local server:

```bash
stripe login
stripe listen --forward-to localhost:3000/webhooks/stripe
```

The CLI prints a `whsec_...` secret. Paste that into `.env` and restart the server.

Then trigger a test event:

```bash
stripe trigger payment_intent.succeeded
```

You should see Flint verify, dedupe, and dispatch the event in the server logs.

## What this example is not

- **Production-ready.** The in-memory idempotency store does not coordinate across replicas. For multi-process deployments use a Postgres or Redis adapter (coming in v0.2).
- **A full app.** No database, no DLQ wired up, minimal logging. The point is to show Flint's surface, not to teach Express.
- **A signature-verification tutorial.** The Stripe provider handles every byte of that for you.

## License

MIT — same as the rest of the Flint repo.