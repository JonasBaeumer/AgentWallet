/**
 * Test A — Real signature verification end-to-end
 *
 * Unlike webhookHandler.test.ts (which mocks constructEvent) and
 * stripeWebhook.test.ts (which mocks handleWebhookEvent entirely), this file
 * exercises the full path:
 *
 *   real Stripe-signed payload
 *     → Fastify raw-body parser
 *     → stripe.webhooks.constructEvent (NOT mocked)
 *     → handleStripeEvent switch
 *     → HTTP response body
 *
 * This proves that signature verification, raw-body preservation, and the
 * { approved: true } response all work together before any real Stripe infra
 * is involved.
 */

jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'test-worker-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
  },
}));

jest.mock('@/db/client', () => ({
  prisma: {
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
    idempotencyRecord: { findUnique: jest.fn().mockResolvedValue(null) },
  },
}));

// Force the route to use StripePaymentProvider (not MockPaymentProvider).
// NODE_ENV=test normally forces the mock; we override that here so the real
// handleStripeEvent (with real constructEvent) runs end-to-end.
jest.mock('@/payments', () => {
  const { StripePaymentProvider } = require('@/payments/providers/stripe');
  return { getPaymentProvider: () => new StripePaymentProvider() };
});

// stripeClient is NOT mocked — constructEvent runs for real

import Stripe from 'stripe';
import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

const WEBHOOK_SECRET = 'whsec_unit_test_signing_secret_32chars';

// Minimal Stripe instance used only for HMAC signing — no real API calls.
const stripeForSigning = new Stripe('sk_test_fake_key_for_signing_only', {
  apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
});

function makeSignedPayload(type: string, object: Record<string, unknown>) {
  const payload = JSON.stringify({
    id: `evt_test_${Date.now()}`,
    object: 'event',
    api_version: '2024-06-20',
    type,
    data: { object },
  });
  const signature = stripeForSigning.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET,
  });
  return { payload, signature };
}

let app: FastifyInstance;

beforeAll(async () => {
  process.env.STRIPE_SECRET_KEY = 'sk_test_fake_key_for_unit_test';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

// ─── Signature path ───────────────────────────────────────────────────────────

describe('real signature verification', () => {
  it('rejects a tampered payload (wrong signature)', async () => {
    const { payload } = makeSignedPayload('issuing_authorization.request', {
      id: 'iauth_1',
      amount: 5000,
      metadata: {},
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'bad_sig' },
      body: payload,
    });
    // Route catches the throw and returns 200 { received: true } (never 5xx to Stripe)
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });

  it('rejects when payload is altered after signing', async () => {
    const { signature } = makeSignedPayload('issuing_authorization.request', {
      id: 'iauth_1',
      amount: 5000,
      metadata: {},
    });
    const tamperedPayload = JSON.stringify({ tampered: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: tamperedPayload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });
});

// ─── issuing_authorization.request ───────────────────────────────────────────

describe('issuing_authorization.request with real signature', () => {
  it('returns { approved: true } with Stripe-Version header', async () => {
    const { payload, signature } = makeSignedPayload('issuing_authorization.request', {
      id: 'iauth_2',
      amount: 5000,
      metadata: { intentId: 'intent-real-sig-1' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ approved: true });
    expect(res.headers['stripe-version']).toBe('2024-06-20');
  });

  it('raw body is preserved (signature still valid after content-type parser)', async () => {
    // If the body were re-serialized (e.g. whitespace changed), constructEvent would throw.
    // Formatting the payload with extra whitespace to stress-test raw-body preservation.
    const object = { id: 'iauth_3', amount: 1000, metadata: {} };
    const payload =
      '{\n  "id": "evt_ws_test",\n  "object": "event",\n  "api_version": "2024-06-20",\n' +
      '  "type": "issuing_authorization.request",\n  "data": { "object": ' +
      JSON.stringify(object) +
      ' }\n}';
    const signature = stripeForSigning.webhooks.generateTestHeaderString({
      payload,
      secret: WEBHOOK_SECRET,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ approved: true });
  });
});

// ─── Other event types ────────────────────────────────────────────────────────

describe('other event types with real signature', () => {
  it('returns { received: true } for issuing_authorization.created', async () => {
    const { payload, signature } = makeSignedPayload('issuing_authorization.created', {
      id: 'iauth_4',
      amount: 5000,
      metadata: { intentId: 'intent-real-sig-2' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });

  it('returns { received: true } for issuing_transaction.created', async () => {
    const { payload, signature } = makeSignedPayload('issuing_transaction.created', {
      id: 'itxn_1',
      amount: 3000,
      metadata: { intentId: 'intent-real-sig-3' },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });

  it('returns { received: true } for unhandled event types', async () => {
    const { payload, signature } = makeSignedPayload('customer.created', { id: 'cus_1' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': signature },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });
});
