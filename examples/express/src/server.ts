import express, { type Request, type Response } from 'express';

import {
  InMemoryIdempotencyStore,
  createWebhookHandler,
  type RawHttpRequest,
} from '@flintdev/core';
import { createStripeProvider } from '@flintdev/stripe';

const secret = process.env.STRIPE_WHSEC;
if (!secret) {
  console.error('Missing STRIPE_WHSEC. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const port = Number.parseInt(process.env.PORT ?? '3000', 10);

const flint = createWebhookHandler({
  provider: createStripeProvider({ secrets: [secret] }),
  idempotency: new InMemoryIdempotencyStore(),
  on: {
    'payment_intent.succeeded': async (event, ctx) => {
      const intent = event.payload.data.object as { id: string; amount: number };
      console.log(
        `[handler] payment_intent.succeeded · attempt ${ctx.attempt} · ${intent.id} · ${intent.amount}`,
      );
    },
    'customer.subscription.deleted': async (event, ctx) => {
      const sub = event.payload.data.object as { id: string; customer: string };
      console.log(
        `[handler] customer.subscription.deleted · attempt ${ctx.attempt} · ${sub.id} · ${sub.customer}`,
      );
    },
  },
});

const app = express();

app.get('/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.post(
  '/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req: Request, res: Response) => {
    const flintReq: RawHttpRequest = {
      body: req.body as Buffer,
      headers: req.headers,
    };

    const decision = await flint.process(flintReq);
    res.status(decision.status).json({ code: decision.code });
  },
);

app.listen(port, () => {
  console.log(`[flint-example] listening on http://localhost:${port}`);
  console.log(`[flint-example] webhook endpoint: POST /webhooks/stripe`);
});