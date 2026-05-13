jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'test-worker-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
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

jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
  enqueueCancelCard: jest.fn().mockResolvedValue(undefined),
}));

const mockHandleWebhookEvent = jest.fn();
jest.mock('@/payments', () => ({
  getPaymentProvider: () => ({ handleWebhookEvent: mockHandleWebhookEvent }),
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  mockHandleWebhookEvent.mockResolvedValue({ received: true });
});

describe('Stripe webhook endpoint', () => {
  it('400 when stripe-signature header is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'issuing_authorization.created' }),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('stripe-signature');
  });

  it('200 with received:true when handleWebhookEvent throws', async () => {
    mockHandleWebhookEvent.mockRejectedValueOnce(new Error('bad sig'));
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-test' },
      body: JSON.stringify({ type: 'issuing_authorization.created' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
  });

  it('passes response body from handleWebhookEvent to caller', async () => {
    mockHandleWebhookEvent.mockResolvedValueOnce({ approved: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-test' },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ approved: true });
  });

  it('passes raw body and signature to handleWebhookEvent', async () => {
    const rawBody = JSON.stringify({ type: 'issuing_authorization.created' });
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-abc' },
      body: rawBody,
    });
    expect(mockHandleWebhookEvent).toHaveBeenCalledWith(expect.any(Buffer), 'sig-abc');
  });
});

describe('Health check', () => {
  it('GET /health returns ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});
