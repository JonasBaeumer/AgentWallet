import bcrypt from 'bcryptjs';

const RAW_API_KEY = 'test-api-key-for-error-paths';
let API_KEY_HASH: string;
const TEST_USER: Record<string, any> = {
  id: 'user-err-test',
  email: 'errtest@agentpay.dev',
  mainBalance: 100000,
  maxBudgetPerIntent: 50000,
  merchantAllowlist: [],
  mccAllowlist: [],
  apiKeyHash: '', // populated in beforeAll
  apiKeyPrefix: '', // populated in beforeAll
};

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

jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));

const mockRevealCard = jest.fn().mockResolvedValue({
  number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2027, last4: '4242',
});
const mockCancelCard = jest.fn().mockResolvedValue(undefined);
const mockIssueCard = jest.fn().mockResolvedValue({
  id: 'vc-1', intentId: 'i1', stripeCardId: 'ic_test', last4: '4242',
});
jest.mock('@/payments', () => ({
  getPaymentProvider: () => ({
    issueCard: mockIssueCard,
    revealCard: mockRevealCard,
    freezeCard: jest.fn().mockResolvedValue(undefined),
    cancelCard: mockCancelCard,
    handleWebhookEvent: jest.fn().mockResolvedValue(undefined),
  }),
}));

const mockDb = {
  purchaseIntent: {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
    findMany: jest.fn().mockResolvedValue([]),
  },
  user: {
    findUnique: jest.fn(({ where }: any) => {
      if (where?.id === TEST_USER.id) return Promise.resolve(TEST_USER);
      if (where?.apiKeyPrefix && where.apiKeyPrefix === TEST_USER.apiKeyPrefix) return Promise.resolve(TEST_USER);
      return Promise.resolve(null);
    }),
    findMany: jest.fn(() => {
      if (TEST_USER.apiKeyHash) {
        return Promise.resolve([TEST_USER]);
      }
      return Promise.resolve([]);
    }),
    update: jest.fn(),
  },
  virtualCard: { findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
  auditEvent: { create: jest.fn().mockResolvedValue({}), findMany: jest.fn().mockResolvedValue([]) },
  idempotencyRecord: {
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  },
  approvalDecision: { findUnique: jest.fn(), upsert: jest.fn(), create: jest.fn() },
  pot: { findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
  ledgerEntry: { create: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  $transaction: jest.fn(),
};

jest.mock('@/db/client', () => ({ prisma: mockDb }));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let authHeader: string;

beforeAll(async () => {
  API_KEY_HASH = await bcrypt.hash(RAW_API_KEY, 10);
  TEST_USER.apiKeyHash = API_KEY_HASH;
  TEST_USER.apiKeyPrefix = RAW_API_KEY.slice(0, 16);
  authHeader = `Bearer ${RAW_API_KEY}`;

  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => jest.clearAllMocks());

describe('Auth: X-Worker-Key enforcement', () => {
  it('401 on /v1/agent/quote without key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ intentId: 'x', merchantName: 'T', merchantUrl: 'https://t.com', price: 100, currency: 'gbp' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on /v1/agent/result with wrong key', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'wrong' },
      body: JSON.stringify({ intentId: 'x', success: true }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on GET /v1/agent/card without key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agent/card/intent-1' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Auth: user API key enforcement', () => {
  it('401 on POST /v1/intents without Authorization header', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/intents',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'noauth-1' },
      body: JSON.stringify({ query: 'test', maxBudget: 1000 }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on GET /v1/intents/:id without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/intents/some-id' });
    expect(res.statusCode).toBe(401);
  });

  it('401 on POST /v1/approvals/:id/decision without Authorization header', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/approvals/i1/decision',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'noauth-2' },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'u1' }),
    });
    expect(res.statusCode).toBe(401);
  });

  it('401 on GET /v1/users/me without Authorization header', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('Idempotency replay', () => {
  it('200 with stored body on duplicate key', async () => {
    const stored = { intentId: 'old-id', status: 'RECEIVED' };
    mockDb.idempotencyRecord.findUnique.mockResolvedValueOnce({ key: 'dup', responseBody: stored });

    const res = await app.inject({
      method: 'POST', url: '/v1/intents',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'dup', authorization: authHeader },
      body: JSON.stringify({ query: 'test', maxBudget: 1000 }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual(stored);
  });
});

describe('Card reveal enforcement', () => {
  it('409 on second card reveal', async () => {
    const { CardAlreadyRevealedError } = require('@/contracts');
    mockRevealCard.mockRejectedValueOnce(new CardAlreadyRevealedError('i1'));
    const res = await app.inject({
      method: 'GET', url: '/v1/agent/card/i1',
      headers: { 'x-worker-key': 'test-worker-key' },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('State transition guards', () => {
  it('409 when posting quote to non-SEARCHING intent', async () => {
    mockDb.purchaseIntent.findUnique.mockResolvedValueOnce({ id: 'i1', status: 'DONE' });
    const res = await app.inject({
      method: 'POST', url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'i1', merchantName: 'T', merchantUrl: 'https://t.com', price: 100, currency: 'gbp' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('409 when approving non-AWAITING_APPROVAL intent', async () => {
    mockDb.purchaseIntent.findUnique.mockResolvedValueOnce({
      id: 'i1', status: 'DONE', userId: TEST_USER.id, user: TEST_USER,
    });
    const res = await app.inject({
      method: 'POST', url: '/v1/approvals/i1/decision',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'err-idem-1', authorization: authHeader },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'u1' }),
    });
    expect(res.statusCode).toBe(409);
  });

  it('409 when posting result to non-CHECKOUT_RUNNING intent', async () => {
    mockDb.purchaseIntent.findUnique.mockResolvedValueOnce({ id: 'i1', status: 'APPROVED' });
    const res = await app.inject({
      method: 'POST', url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'i1', success: true }),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('Input validation', () => {
  it('400 when X-Idempotency-Key missing on POST /v1/intents', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/intents',
      headers: { 'content-type': 'application/json', authorization: authHeader },
      body: JSON.stringify({ query: 'test', maxBudget: 1000 }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 for invalid decision value', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/approvals/i1/decision',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'val-1', authorization: authHeader },
      body: JSON.stringify({ decision: 'MAYBE', actorId: 'u1' }),
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 for missing query on POST /v1/intents', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/intents',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'val-2', authorization: authHeader },
      body: JSON.stringify({ maxBudget: 1000 }),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('Not found', () => {
  it('404 for unknown intent', async () => {
    mockDb.purchaseIntent.findUnique.mockResolvedValueOnce(null);
    const res = await app.inject({
      method: 'GET', url: '/v1/intents/does-not-exist',
      headers: { authorization: authHeader },
    });
    expect(res.statusCode).toBe(404);
  });
});
