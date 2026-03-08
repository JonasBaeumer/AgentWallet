/**
 * Unit tests for POST /v1/agent/register security hardening (issue #15):
 * - TTL shortened to 10 minutes
 * - Per-agentId renewal cooldown (429 within 5 min of last issuance)
 */

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

// Stub all modules that agentRoutes depends on but are irrelevant to this test
jest.mock('@/orchestrator/intentService', () => ({
  receiveQuote: jest.fn(),
  requestApproval: jest.fn(),
  completeCheckout: jest.fn(),
  failCheckout: jest.fn(),
  getIntentWithHistory: jest.fn(),
}));
jest.mock('@/ledger/potService', () => ({
  settleIntent: jest.fn(),
  returnIntent: jest.fn(),
}));
jest.mock('@/payments', () => ({
  getPaymentProvider: () => ({
    issueCard: jest.fn(),
    revealCard: jest.fn(),
    cancelCard: jest.fn(),
    handleWebhookEvent: jest.fn(),
    getIssuingBalance: jest.fn(),
  }),
}));
jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));
jest.mock('@/approval/approvalService', () => ({ recordDecision: jest.fn() }));
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn(),
  enqueueCheckout: jest.fn(),
}));

// Minimal DB mock — only pairingCode matters for this test
const dbPairingCodes: Record<string, any> = {};

jest.mock('@/db/client', () => ({
  prisma: {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    purchaseIntent: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    auditEvent: { create: jest.fn() },
    pairingCode: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbPairingCodes[where.agentId] ?? null)),
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
  Object.keys(dbPairingCodes).forEach((k) => delete dbPairingCodes[k]);
});

const WORKER_HEADERS = { 'x-worker-key': 'test-worker-key' };

// ─── TTL tests ─────────────────────────────────────────────────────────────────

describe('POST /v1/agent/register — TTL', () => {
  it('issues code with expiry ~10 minutes in the future (not 30)', async () => {
    const before = Date.now();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: WORKER_HEADERS,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const { expiresAt } = res.json();
    const expiresMs = new Date(expiresAt).getTime();
    const ttlMs = expiresMs - before;

    // Should be close to 10 minutes (±1 s tolerance)
    expect(ttlMs).toBeGreaterThanOrEqual(9 * 60 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(11 * 60 * 1000);
  });
});

// ─── Per-agentId renewal cooldown tests ───────────────────────────────────────

describe('POST /v1/agent/register — per-agentId cooldown', () => {
  it('returns 429 when a renewal is requested within 5 minutes of last issuance', async () => {
    // Seed a record where the code was just issued (expiresAt = now + 10 min, so issuedAt ≈ now)
    dbPairingCodes['ag_cool'] = {
      id: 'pc-cool',
      agentId: 'ag_cool',
      code: 'COOLTEST',
      claimedByUserId: null,
      // expiresAt in the future, implying the code was just issued moments ago
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: WORKER_HEADERS,
      payload: { agentId: 'ag_cool' },
    });

    expect(res.statusCode).toBe(429);
    expect(res.json().error).toContain('Too many renewal requests');
  });

  it('allows renewal once the 5-minute cooldown has passed', async () => {
    // Seed a record where the code was issued 6 minutes ago
    const sixMinutesAgo = Date.now() - 6 * 60 * 1000;
    dbPairingCodes['ag_cool2'] = {
      id: 'pc-cool2',
      agentId: 'ag_cool2',
      code: 'OLDCOOL1',
      claimedByUserId: null,
      expiresAt: new Date(Date.now() + 4 * 60 * 1000),
      createdAt: new Date(sixMinutesAgo), // cooldown reads createdAt directly
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: WORKER_HEADERS,
      payload: { agentId: 'ag_cool2' },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.pairingCode).not.toBe('OLDCOOL1');
  });

  it('still returns 409 for already-claimed agents regardless of cooldown', async () => {
    dbPairingCodes['ag_claimed2'] = {
      id: 'pc-claimed2',
      agentId: 'ag_claimed2',
      code: 'CLMD1234',
      claimedByUserId: 'user-already',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      createdAt: new Date(),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: WORKER_HEADERS,
      payload: { agentId: 'ag_claimed2' },
    });

    expect(res.statusCode).toBe(409);
  });
});
