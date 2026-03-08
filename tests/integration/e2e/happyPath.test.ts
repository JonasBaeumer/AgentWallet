/**
 * Happy path: full RECEIVED → DONE trace via Fastify inject (no real DB/Redis).
 */

import bcrypt from 'bcryptjs';

// A fixed raw API key and its bcrypt hash (computed once, reused for all tests)
const RAW_API_KEY = 'test-api-key-for-happy-path-integration';
let API_KEY_HASH: string;

// Mock env first
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
  getStripeClient: () => ({
    issuing: {
      cardholders: { create: jest.fn().mockResolvedValue({ id: 'ich_test' }) },
      cards: {
        create: jest.fn().mockResolvedValue({ id: 'ic_test', last4: '4242', exp_month: 12, exp_year: 2027 }),
        retrieve: jest.fn().mockResolvedValue({ id: 'ic_test', last4: '4242', exp_month: 12, exp_year: 2027 }),
      },
    },
    webhooks: { constructEvent: jest.fn() },
  }),
}));

// In-memory store for mock prisma
const store: {
  intents: Record<string, any>;
  users: Record<string, any>;
  cards: Record<string, any>;
  auditEvents: any[];
  idempotencyRecords: Record<string, any>;
  approvalDecisions: Record<string, any>;
  pots: Record<string, any>;
  ledgerEntries: any[];
} = {
  intents: {},
  users: {},
  cards: {},
  auditEvents: [],
  idempotencyRecords: {},
  approvalDecisions: {},
  pots: {},
  ledgerEntries: [],
};

jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: {
      create: jest.fn(({ data }: any) => {
        const intent = { id: `intent-${Date.now()}`, ...data, updatedAt: new Date(), createdAt: new Date() };
        store.intents[intent.id] = intent;
        return Promise.resolve(intent);
      }),
      findUnique: jest.fn(({ where, include }: any) => {
        const intent = store.intents[where.id] ?? null;
        if (!intent) return Promise.resolve(null);
        if (include) {
          return Promise.resolve({
            ...intent,
            auditEvents: store.auditEvents.filter((e) => e.intentId === intent.id),
            virtualCard: store.cards[intent.id] ?? null,
            user: store.users[intent.userId] ?? null,
          });
        }
        return Promise.resolve(intent);
      }),
      update: jest.fn(({ where, data }: any) => {
        store.intents[where.id] = { ...store.intents[where.id], ...data, updatedAt: new Date() };
        return Promise.resolve(store.intents[where.id]);
      }),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(store.users[where.id] ?? null);
        if (where.apiKeyPrefix) {
          const match = Object.values(store.users).find((u: any) => u.apiKeyPrefix === where.apiKeyPrefix);
          return Promise.resolve(match ?? null);
        }
        return Promise.resolve(null);
      }),
      findMany: jest.fn(({ where }: any) => {
        const all = Object.values(store.users);
        if (where?.apiKeyHash?.not === null) {
          return Promise.resolve(all.filter((u: any) => u.apiKeyHash != null));
        }
        return Promise.resolve(all);
      }),
      update: jest.fn(({ where, data }: any) => {
        store.users[where.id] = { ...store.users[where.id], ...data };
        return Promise.resolve(store.users[where.id]);
      }),
    },
    virtualCard: {
      create: jest.fn(({ data }: any) => {
        const card = { id: `card-${Date.now()}`, ...data, createdAt: new Date() };
        store.cards[data.intentId] = card;
        return Promise.resolve(card);
      }),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(store.cards[where.intentId] ?? null)),
      update: jest.fn(({ where, data }: any) => {
        if (store.cards[where.intentId]) {
          store.cards[where.intentId] = { ...store.cards[where.intentId], ...data };
        }
        return Promise.resolve(store.cards[where.intentId] ?? null);
      }),
    },
    auditEvent: {
      create: jest.fn(({ data }: any) => {
        const e = { id: `ae-${Date.now()}-${Math.random()}`, ...data, createdAt: new Date() };
        store.auditEvents.push(e);
        return Promise.resolve(e);
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(store.auditEvents.filter((e) => e.intentId === where?.intentId)),
      ),
    },
    idempotencyRecord: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(store.idempotencyRecords[where.key] ?? null)),
      upsert: jest.fn(({ where, create }: any) => {
        if (!store.idempotencyRecords[where.key]) store.idempotencyRecords[where.key] = create;
        return Promise.resolve(store.idempotencyRecords[where.key]);
      }),
    },
    approvalDecision: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(store.approvalDecisions[where.intentId] ?? null)),
      upsert: jest.fn(({ where, create }: any) => {
        if (!store.approvalDecisions[where.intentId]) store.approvalDecisions[where.intentId] = create;
        return Promise.resolve(store.approvalDecisions[where.intentId]);
      }),
      create: jest.fn(({ data }: any) => {
        store.approvalDecisions[data.intentId] = { id: `ad-${Date.now()}`, ...data };
        return Promise.resolve(store.approvalDecisions[data.intentId]);
      }),
    },
    pot: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(store.pots[where.intentId] ?? null)),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(({ data }: any) => {
        const pot = { id: `pot-${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
        store.pots[data.intentId] = pot;
        return Promise.resolve(pot);
      }),
      update: jest.fn(({ where, data }: any) => {
        store.pots[where.intentId] = { ...store.pots[where.intentId], ...data };
        return Promise.resolve(store.pots[where.intentId]);
      }),
    },
    ledgerEntry: {
      create: jest.fn(({ data }: any) => {
        const entry = { id: `le-${Date.now()}`, ...data, createdAt: new Date() };
        store.ledgerEntries.push(entry);
        return Promise.resolve(entry);
      }),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(store.ledgerEntries.filter((e) => e.userId === where?.userId)),
      ),
    },
    $transaction: jest.fn(async (fn: Function) => {
      const tx = {
        user: {
          findUnique: jest.fn(({ where }: any) => Promise.resolve(store.users[where.id] ?? null)),
          update: jest.fn(({ where, data }: any) => {
            if (data.mainBalance?.decrement !== undefined) {
              store.users[where.id].mainBalance -= data.mainBalance.decrement;
            } else if (data.mainBalance?.increment !== undefined) {
              store.users[where.id].mainBalance += data.mainBalance.increment;
            } else {
              store.users[where.id] = { ...store.users[where.id], ...data };
            }
            return Promise.resolve(store.users[where.id]);
          }),
        },
        purchaseIntent: {
          findUnique: jest.fn(({ where }: any) => Promise.resolve(store.intents[where.id] ?? null)),
          update: jest.fn(({ where, data }: any) => {
            store.intents[where.id] = { ...store.intents[where.id], ...data };
            return Promise.resolve(store.intents[where.id]);
          }),
        },
        pot: {
          findUnique: jest.fn(({ where }: any) => Promise.resolve(store.pots[where.intentId] ?? null)),
          create: jest.fn(({ data }: any) => {
            const pot = { id: `pot-${Date.now()}`, ...data, createdAt: new Date(), updatedAt: new Date() };
            store.pots[data.intentId] = pot;
            return Promise.resolve(pot);
          }),
          update: jest.fn(({ where, data }: any) => {
            store.pots[where.intentId] = { ...store.pots[where.intentId], ...data };
            return Promise.resolve(store.pots[where.intentId]);
          }),
        },
        ledgerEntry: {
          create: jest.fn(({ data }: any) => {
            const entry = { id: `le-${Date.now()}`, ...data, createdAt: new Date() };
            store.ledgerEntries.push(entry);
            return Promise.resolve(entry);
          }),
        },
        auditEvent: {
          create: jest.fn(({ data }: any) => {
            const e = { id: `ae-${Date.now()}`, ...data, createdAt: new Date() };
            store.auditEvents.push(e);
            return Promise.resolve(e);
          }),
        },
      };
      return fn(tx);
    }),
  },
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let intentId: string;
let authHeader: string;

beforeAll(async () => {
  // Pre-compute bcrypt hash and seed the demo user with an API key
  API_KEY_HASH = await bcrypt.hash(RAW_API_KEY, 10);
  store.users['user-demo'] = {
    id: 'user-demo',
    email: 'demo@agentpay.dev',
    mainBalance: 100000,
    maxBudgetPerIntent: 50000,
    merchantAllowlist: [],
    mccAllowlist: [],
    apiKeyHash: API_KEY_HASH,
    apiKeyPrefix: RAW_API_KEY.slice(0, 16),
  };
  authHeader = `Bearer ${RAW_API_KEY}`;

  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe('Happy path: RECEIVED → DONE', () => {
  it('POST /v1/intents — creates intent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'hp-idem-1', authorization: authHeader },
      body: JSON.stringify({ query: 'Sony WH-1000XM5', maxBudget: 30000, currency: 'gbp' }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.intentId).toBeDefined();
    intentId = body.intentId;
    expect(body.status).toBe('SEARCHING');
  });

  it('POST /v1/agent/quote — worker posts quote', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({
        intentId,
        merchantName: 'Amazon UK',
        merchantUrl: 'https://amazon.co.uk/dp/B09XS7JWHH',
        price: 27999,
        currency: 'gbp',
      }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('AWAITING_APPROVAL');
  });

  it('POST /v1/approvals/:id/decision — user approves', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${intentId}/decision`,
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'hp-approval-1', authorization: authHeader },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-demo' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).decision).toBe('APPROVED');
  });

  it('GET /v1/intents/:intentId — returns intent', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/intents/${intentId}`,
      headers: { authorization: authHeader },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).intent.id).toBe(intentId);
  });

  it('POST /v1/agent/result — worker posts success', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId, success: true, actualAmount: 27999, receiptUrl: 'https://amazon.co.uk/receipt/123' }),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('DONE');
  });

  it('GET /health — server is healthy', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('ok');
  });
});
