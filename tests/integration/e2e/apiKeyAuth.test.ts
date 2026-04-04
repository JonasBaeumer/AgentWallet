/**
 * Integration test: API key authentication flow
 *
 * Verifies that user-facing routes enforce Bearer token auth,
 * reject invalid keys, and enforce intent ownership.
 *
 * Uses real PostgreSQL via Prisma — no jest.mock on prisma.
 *
 * Requires: docker compose up -d (Postgres + Redis)
 *
 * Run: npm run test:integration -- --testPathPattern=apiKeyAuth
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { disconnectRedis } from '@/config/redis';

// Mock Telegram outbound — we don't send real Telegram messages during tests
jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: () => ({
    api: {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      editMessageText: jest.fn().mockResolvedValue(undefined),
    },
  }),
}));

// Mock BullMQ producers — no running Redis worker needed
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

const hasStripeKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');

let app: FastifyInstance;

// User A credentials
let rawKeyA: string;
let authHeaderA: string;

// User B credentials
let rawKeyB: string;
let authHeaderB: string;

let userAId: string;
let userBId: string;

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  disconnectRedis();
});

beforeEach(async () => {
  // Clean slate — delete in dependency order
  await prisma.auditEvent.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.pot.deleteMany();
  await prisma.virtualCard.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.purchaseIntent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.pairingCode.deleteMany();
  await prisma.user.deleteMany();

  // Generate real API keys
  rawKeyA = crypto.randomBytes(32).toString('hex');
  rawKeyB = crypto.randomBytes(32).toString('hex');
  const hashA = await bcrypt.hash(rawKeyA, 10);
  const hashB = await bcrypt.hash(rawKeyB, 10);

  // Create real users in DB
  const userA = await prisma.user.create({
    data: {
      email: 'user-a@agentpay.dev',
      mainBalance: 100000,
      maxBudgetPerIntent: 50000,
      apiKeyHash: hashA,
      apiKeyPrefix: rawKeyA.slice(0, 16),
    },
  });
  const userB = await prisma.user.create({
    data: {
      email: 'user-b@agentpay.dev',
      mainBalance: 100000,
      maxBudgetPerIntent: 50000,
      apiKeyHash: hashB,
      apiKeyPrefix: rawKeyB.slice(0, 16),
    },
  });

  userAId = userA.id;
  userBId = userB.id;
  authHeaderA = `Bearer ${rawKeyA}`;
  authHeaderB = `Bearer ${rawKeyB}`;

  jest.clearAllMocks();
});

// ─── Only run when real DB is available (same guard as onboarding.test.ts) ────
const testSuite = hasStripeKey ? describe : describe.skip;

// ─── 1. Unauthenticated access ──────────────────────────────────────────────

testSuite('Unauthenticated access is rejected', () => {
  it('POST /v1/intents without Authorization header -> 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'noauth-1' },
      payload: { query: 'test item', maxBudget: 1000 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/users/me with no key -> 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/users/me' });
    expect(res.statusCode).toBe(401);
  });

  it('POST /v1/approvals/:id/decision without auth -> 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/any-intent/decision',
      headers: { 'content-type': 'application/json', 'x-idempotency-key': 'noauth-2' },
      payload: { decision: 'APPROVED', actorId: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── 2. Wrong API key ───────────────────────────────────────────────────────

testSuite('Wrong API key is rejected', () => {
  it('POST /v1/intents with wrong key -> 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'wrongkey-1',
        authorization: 'Bearer totally-wrong-key-that-does-not-match-anything',
      },
      payload: { query: 'test item', maxBudget: 1000 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /v1/users/me with wrong key -> 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: 'Bearer totally-wrong-key-that-does-not-match-anything' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ─── 3. Valid key: intent creation and retrieval ────────────────────────────

testSuite('Authenticated intent creation', () => {
  it('POST /v1/intents with valid key -> 201, intent created for authenticated user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `auth-intent-${Date.now()}`,
        authorization: authHeaderA,
      },
      payload: { query: 'Sony WH-1000XM5', maxBudget: 30000, currency: 'eur' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.intentId).toBeDefined();
    expect(body.status).toBe('SEARCHING');

    // Verify the intent in DB belongs to user A
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: body.intentId } });
    expect(intent).not.toBeNull();
    expect(intent!.userId).toBe(userAId);
  });

  it('GET /v1/intents/:id with valid key for own intent -> 200', async () => {
    // Create an intent first
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `auth-get-own-${Date.now()}`,
        authorization: authHeaderA,
      },
      payload: { query: 'Sony WH-1000XM5', maxBudget: 30000, currency: 'eur' },
    });
    const intentId = createRes.json().intentId;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/intents/${intentId}`,
      headers: { authorization: authHeaderA },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().intent.id).toBe(intentId);
  });

  it("GET /v1/intents/:id with valid key for another user's intent -> 403", async () => {
    // Create an intent owned by user A
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `auth-get-other-${Date.now()}`,
        authorization: authHeaderA,
      },
      payload: { query: 'Sony WH-1000XM5', maxBudget: 30000, currency: 'eur' },
    });
    const intentId = createRes.json().intentId;

    // User B tries to access user A's intent
    const res = await app.inject({
      method: 'GET',
      url: `/v1/intents/${intentId}`,
      headers: { authorization: authHeaderB },
    });
    expect(res.statusCode).toBe(403);
  });
});

// ─── 4. GET /v1/users/me ────────────────────────────────────────────────────

testSuite('GET /v1/users/me', () => {
  it('returns correct user profile with valid key', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/users/me',
      headers: { authorization: authHeaderA },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(userAId);
    expect(body.email).toBe('user-a@agentpay.dev');
    expect(body.mainBalance).toBe(100000);
  });
});

// ─── 5. Approval ownership enforcement ──────────────────────────────────────

testSuite('Approval ownership enforcement', () => {
  let intentId: string;

  beforeEach(async () => {
    // Create an intent owned by user A
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `auth-approval-setup-${Date.now()}`,
        authorization: authHeaderA,
      },
      payload: { query: 'test approval ownership', maxBudget: 5000, currency: 'eur' },
    });
    intentId = res.json().intentId;

    // Manually move to AWAITING_APPROVAL in DB
    await prisma.purchaseIntent.update({
      where: { id: intentId },
      data: { status: 'AWAITING_APPROVAL' },
    });
  });

  it("POST /v1/approvals/:id/decision for another user's intent -> 403", async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${intentId}/decision`,
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': `auth-approval-403-${Date.now()}`,
        authorization: authHeaderB,
      },
      payload: { decision: 'APPROVED', actorId: userBId },
    });
    expect(res.statusCode).toBe(403);
  });
});
