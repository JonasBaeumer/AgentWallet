/**
 * Rate limiting tests — verify that global and per-route rate limits are enforced.
 *
 * The global @fastify/rate-limit plugin is only registered when NODE_ENV !== 'test'.
 * These tests override NODE_ENV to 'development' and mock getRedisClient to return
 * undefined so the plugin falls back to its built-in in-memory store.
 */

// ─── Environment override (must be before any app imports) ──────────────────
const originalNodeEnv = process.env.NODE_ENV;
process.env.NODE_ENV = 'development';

// ─── Service mocks (same pattern as wiring.test.ts) ─────────────────────────

jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'test-worker-key',
    PORT: 3000,
    NODE_ENV: 'development',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
    TELEGRAM_BOT_TOKEN: '',
    TELEGRAM_WEBHOOK_SECRET: 'test-telegram-secret',
    TELEGRAM_TEST_CHAT_ID: '',
    TELEGRAM_TEST_CHANNEL_ID: '',
    TELEGRAM_MOCK: false,
    PAYMENT_PROVIDER: 'stripe',
  },
}));

// Mock Redis to return undefined — @fastify/rate-limit falls back to in-memory store
jest.mock('@/config/redis', () => ({
  getRedisClient: () => undefined,
}));

jest.mock('@/orchestrator/intentService', () => ({
  startSearching: jest.fn().mockResolvedValue({ newStatus: 'SEARCHING' }),
  receiveQuote: jest.fn().mockResolvedValue(undefined),
  requestApproval: jest.fn().mockResolvedValue(undefined),
  markCardIssued: jest.fn().mockResolvedValue(undefined),
  startCheckout: jest.fn().mockResolvedValue(undefined),
  completeCheckout: jest.fn().mockResolvedValue(undefined),
  failCheckout: jest.fn().mockResolvedValue(undefined),
  getIntentWithHistory: jest.fn(),
}));

jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/approval/approvalService', () => ({
  recordDecision: jest.fn().mockResolvedValue({ decision: 'APPROVED' }),
}));

jest.mock('@/ledger/potService', () => ({
  reserveForIntent: jest.fn().mockResolvedValue({ id: 'pot-1', reservedAmount: 10000 }),
  settleIntent: jest.fn().mockResolvedValue(undefined),
  returnIntent: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/payments', () => {
  const mockProvider = {
    metadata: { id: 'STRIPE', currency: 'eur' },
    issueCard: jest.fn().mockResolvedValue({
      id: 'vc-1',
      intentId: 'intent-1',
      providerCardId: 'ic_test',
      last4: '4242',
    }),
    revealCard: jest.fn().mockResolvedValue({
      number: '4242424242424242',
      cvc: '123',
      expMonth: 12,
      expYear: 2027,
      last4: '4242',
    }),
    freezeCard: jest.fn().mockResolvedValue(undefined),
    cancelCard: jest.fn().mockResolvedValue(undefined),
    handleWebhookEvent: jest.fn().mockResolvedValue(undefined),
    getIssuingBalance: jest.fn().mockResolvedValue({ available: 999_999_99, currency: 'eur' }),
  };
  return {
    getPaymentProvider: () => mockProvider,
    getProviderForIntent: () => Promise.resolve(mockProvider),
    getProviderForUser: () => Promise.resolve(mockProvider),
  };
});

jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));

jest.mock('@/payments/providers/stripe/checkoutSimulator', () => ({
  runSimulatedCheckout: jest.fn().mockResolvedValue({
    success: true,
    chargeId: 'pi_rate_test',
    amount: 5000,
    currency: 'eur',
  }),
}));

jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/telegram/callbackHandler', () => ({
  handleTelegramCallback: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@/telegram/signupHandler', () => ({
  handleTelegramMessage: jest.fn().mockResolvedValue(undefined),
}));

// DB mock — lightweight, enough for rate-limit testing
import bcrypt from 'bcryptjs';
const TEST_RAW_KEY = 'test-api-key-for-rate-limit-tests';
const TEST_KEY_PREFIX = TEST_RAW_KEY.slice(0, 16);
let TEST_KEY_HASH: string;

const dbUsers: Record<string, any> = {
  'user-rl': {
    id: 'user-rl',
    email: 'ratelimit@agentpay.dev',
    mainBalance: 100000,
    maxBudgetPerIntent: 50000,
    merchantAllowlist: [],
    mccAllowlist: [],
    apiKeyHash: null,
    apiKeyPrefix: TEST_KEY_PREFIX,
    paymentProvider: 'STRIPE',
  },
};
const dbIntents: Record<string, any> = {};
const dbIdempotency: Record<string, any> = {};
const dbPairingCodes: Record<string, any> = {};

jest.mock('@/db/client', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(dbUsers[where.id] ?? null);
        if (where.apiKeyPrefix) {
          const found = Object.values(dbUsers).find(
            (u: any) => u.apiKeyPrefix === where.apiKeyPrefix,
          );
          return Promise.resolve(found ?? null);
        }
        return Promise.resolve(null);
      }),
      update: jest.fn().mockResolvedValue({}),
    },
    purchaseIntent: {
      create: jest.fn(({ data }: any) => {
        const intent = {
          id: `intent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbIntents[intent.id] = intent;
        return Promise.resolve(intent);
      }),
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbIntents[where.id] ?? null)),
      update: jest.fn(({ where, data }: any) => {
        dbIntents[where.id] = { ...dbIntents[where.id], ...data };
        return Promise.resolve(dbIntents[where.id]);
      }),
    },
    idempotencyRecord: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbIdempotency[where.key] ?? null)),
      upsert: jest.fn(({ where, create }: any) => {
        if (!dbIdempotency[where.key]) dbIdempotency[where.key] = create;
        return Promise.resolve(dbIdempotency[where.key]);
      }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
    pairingCode: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.agentId) return Promise.resolve(dbPairingCodes[where.agentId] ?? null);
        const found = Object.values(dbPairingCodes).find((r: any) => r.code === where.code);
        return Promise.resolve(found ?? null);
      }),
      create: jest.fn(({ data }: any) => {
        const record = { id: `pc-${Date.now()}`, ...data, createdAt: new Date() };
        dbPairingCodes[record.agentId] = record;
        return Promise.resolve(record);
      }),
      update: jest.fn(({ where, data }: any) => {
        if (dbPairingCodes[where.agentId]) {
          dbPairingCodes[where.agentId] = { ...dbPairingCodes[where.agentId], ...data };
          return Promise.resolve(dbPairingCodes[where.agentId]);
        }
        return Promise.resolve(null);
      }),
    },
  },
}));

// ─── App + test setup ───────────────────────────────────────────────────────

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

const AUTH_HEADER = `Bearer ${TEST_RAW_KEY}`;

let app: FastifyInstance;

beforeAll(async () => {
  TEST_KEY_HASH = await bcrypt.hash(TEST_RAW_KEY, 10);
  dbUsers['user-rl'].apiKeyHash = TEST_KEY_HASH;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  process.env.NODE_ENV = originalNodeEnv;
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(dbIntents).forEach((k) => delete dbIntents[k]);
  Object.keys(dbIdempotency).forEach((k) => delete dbIdempotency[k]);
  Object.keys(dbPairingCodes).forEach((k) => delete dbPairingCodes[k]);
});

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Fire N requests to a route and return all responses. */
async function fireRequests(
  method: 'GET' | 'POST',
  url: string,
  count: number,
  opts: {
    headers?: Record<string, string> | ((i: number) => Record<string, string>);
    body?: any;
    ip?: string;
  } = {},
) {
  const responses = [];
  for (let i = 0; i < count; i++) {
    const dynamicHeaders =
      typeof opts.headers === 'function' ? opts.headers(i) : (opts.headers ?? {});
    const injectOpts: any = {
      method,
      url,
      headers: {
        'content-type': 'application/json',
        ...dynamicHeaders,
      },
    };
    if (opts.ip) {
      injectOpts.headers['x-forwarded-for'] = opts.ip;
    }
    if (opts.body) {
      const bodyObj = typeof opts.body === 'function' ? opts.body(i) : opts.body;
      injectOpts.body = JSON.stringify(bodyObj);
    }
    responses.push(await app.inject(injectOpts));
  }
  return responses;
}

// ─── Global rate limit ──────────────────────────────────────────────────────

describe('Global rate limit (60 req/min per IP)', () => {
  it('returns 429 on the 61st request from the same IP', async () => {
    const ip = '10.0.0.1';
    const responses = await fireRequests('GET', '/health', 61, { ip });

    // First 60 should succeed
    for (let i = 0; i < 60; i++) {
      expect(responses[i].statusCode).toBe(200);
    }
    // 61st should be rate limited
    expect(responses[60].statusCode).toBe(429);
  });
});

// ─── 429 response shape ─────────────────────────────────────────────────────

describe('429 response shape', () => {
  it('has error: "rate_limit_exceeded" and retryAfter field', async () => {
    const ip = '10.0.1.1';
    // Exhaust the global limit
    await fireRequests('GET', '/health', 60, { ip });
    const responses = await fireRequests('GET', '/health', 1, { ip });
    const res = responses[0];

    expect(res.statusCode).toBe(429);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('rate_limit_exceeded');
    expect(body.retryAfter).toBeDefined();
    expect(typeof body.retryAfter).toBe('number');
    expect(body.message).toMatch(/Too many requests/);
  });
});

// ─── Rate limit headers ─────────────────────────────────────────────────────

describe('Rate limit headers', () => {
  it('includes x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset on normal response', async () => {
    const ip = '10.0.2.1';
    const responses = await fireRequests('GET', '/health', 1, { ip });
    const res = responses[0];

    expect(res.statusCode).toBe(200);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  it('includes rate limit headers on 429 response', async () => {
    const ip = '10.0.3.1';
    await fireRequests('GET', '/health', 60, { ip });
    const responses = await fireRequests('GET', '/health', 1, { ip });
    const res = responses[0];

    expect(res.statusCode).toBe(429);
    expect(res.headers['x-ratelimit-limit']).toBeDefined();
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
    expect(res.headers['retry-after']).toBeDefined();
  });
});

// ─── Key isolation ──────────────────────────────────────────────────────────

describe('Key isolation — different IPs do not share limits', () => {
  it('IP A being rate-limited does not affect IP B', async () => {
    const ipA = '10.1.0.1';
    const ipB = '10.1.0.2';

    // Exhaust limit for IP A
    await fireRequests('GET', '/health', 60, { ip: ipA });
    const blockedRes = await fireRequests('GET', '/health', 1, { ip: ipA });
    expect(blockedRes[0].statusCode).toBe(429);

    // IP B should still be allowed
    const freeRes = await fireRequests('GET', '/health', 1, { ip: ipB });
    expect(freeRes[0].statusCode).toBe(200);
  });
});

// ─── Per-route: POST /v1/intents (max 10) ───────────────────────────────────

describe('Per-route: POST /v1/intents (max 10 per auth:ip)', () => {
  it('returns 429 after 10 requests from same auth+ip', async () => {
    const ip = '10.2.0.1';
    const responses = await fireRequests('POST', '/v1/intents', 11, {
      ip,
      headers: (i: number) => ({
        authorization: AUTH_HEADER,
        'x-idempotency-key': `idem-intents-${i}`,
      }),
      body: (i: number) => ({
        query: `headphones ${i}`,
        maxBudget: 10000,
        currency: 'eur',
      }),
    });

    // First 10 should succeed (201)
    for (let i = 0; i < 10; i++) {
      expect(responses[i].statusCode).toBe(201);
    }
    // 11th should be rate limited
    expect(responses[10].statusCode).toBe(429);
  });
});

// ─── Per-route: POST /v1/agent/register (max 3) ────────────────────────────

describe('Per-route: POST /v1/agent/register (max 3 per IP)', () => {
  it('returns 429 after 3 requests from same IP', async () => {
    const ip = '10.3.0.1';
    const responses = await fireRequests('POST', '/v1/agent/register', 4, {
      ip,
      headers: { 'x-worker-key': 'test-worker-key' },
      body: {},
    });

    // First 3 should succeed (200)
    for (let i = 0; i < 3; i++) {
      expect(responses[i].statusCode).toBe(200);
    }
    // 4th should be rate limited
    expect(responses[3].statusCode).toBe(429);
  });
});

// ─── Per-route: GET /v1/agent/card/:intentId (max 2) ────────────────────────

describe('Per-route: GET /v1/agent/card/:intentId (max 2 per intentId)', () => {
  it('returns 429 after 2 requests with same worker-key and intentId', async () => {
    const ip = '10.4.0.1';
    const responses = await fireRequests('GET', '/v1/agent/card/intent-card-rl', 3, {
      ip,
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    // First 2 should succeed (200 or service error, but not 429)
    expect(responses[0].statusCode).not.toBe(429);
    expect(responses[1].statusCode).not.toBe(429);
    // 3rd should be rate limited
    expect(responses[2].statusCode).toBe(429);
  });

  it('different intentIds do not share the limit', async () => {
    const ip = '10.4.1.1';
    // 2 requests for intent-A
    const resA = await fireRequests('GET', '/v1/agent/card/intent-A', 2, {
      ip,
      headers: { 'x-worker-key': 'test-worker-key' },
    });
    expect(resA[0].statusCode).not.toBe(429);
    expect(resA[1].statusCode).not.toBe(429);

    // intent-B should still be allowed
    const resB = await fireRequests('GET', '/v1/agent/card/intent-B', 1, {
      ip,
      headers: { 'x-worker-key': 'test-worker-key' },
    });
    expect(resB[0].statusCode).not.toBe(429);
  });
});
