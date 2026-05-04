/**
 * Wiring tests — verify that API routes correctly call the service layer.
 *
 * These tests exist to catch regressions where a route starts bypassing a
 * service and doing its own inline state management. Each test asserts:
 *   1. The correct service function was called (via spies)
 *   2. It was called with the right arguments
 *   3. The route returns the expected HTTP status and body
 */

// ─── Service mocks ────────────────────────────────────────────────────────────

// checkout simulator
const mockRunSimulatedCheckout = jest.fn().mockResolvedValue({
  success: true,
  chargeId: 'pi_wiring_test',
  amount: 5000,
  currency: 'eur',
});
jest.mock('@/payments/providers/stripe/checkoutSimulator', () => ({
  runSimulatedCheckout: mockRunSimulatedCheckout,
}));

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

// orchestrator
const mockStartSearching = jest.fn().mockResolvedValue({ newStatus: 'SEARCHING' });
const mockReceiveQuote = jest.fn().mockResolvedValue({ newStatus: 'QUOTED' });
const mockRequestApproval = jest.fn().mockResolvedValue({ newStatus: 'AWAITING_APPROVAL' });
const mockMarkCardIssued = jest.fn().mockResolvedValue({ newStatus: 'CARD_ISSUED' });
const mockStartCheckout = jest.fn().mockResolvedValue({ newStatus: 'CHECKOUT_RUNNING' });
const mockCompleteCheckout = jest.fn().mockResolvedValue({ newStatus: 'DONE' });
const mockFailCheckout = jest.fn().mockResolvedValue({ newStatus: 'FAILED' });

jest.mock('@/orchestrator/intentService', () => ({
  startSearching: mockStartSearching,
  receiveQuote: mockReceiveQuote,
  requestApproval: mockRequestApproval,
  markCardIssued: mockMarkCardIssued,
  startCheckout: mockStartCheckout,
  completeCheckout: mockCompleteCheckout,
  failCheckout: mockFailCheckout,
  getIntentWithHistory: jest.fn(),
}));

// queue producers
const mockEnqueueSearch = jest.fn().mockResolvedValue(undefined);
const mockEnqueueCheckout = jest.fn().mockResolvedValue(undefined);
jest.mock('@/queue/producers', () => ({
  enqueueSearch: mockEnqueueSearch,
  enqueueCheckout: mockEnqueueCheckout,
}));

// approval service
const mockRecordDecision = jest.fn().mockResolvedValue({ decision: 'APPROVED' });
jest.mock('@/approval/approvalService', () => ({
  recordDecision: mockRecordDecision,
}));

// ledger
const mockReserveForIntent = jest.fn().mockResolvedValue({ id: 'pot-1', reservedAmount: 10000 });
const mockSettleIntent = jest.fn().mockResolvedValue(undefined);
const mockReturnIntent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/ledger/potService', () => ({
  reserveForIntent: mockReserveForIntent,
  settleIntent: mockSettleIntent,
  returnIntent: mockReturnIntent,
}));

// payments — mock the provider factory so callers get our spies
const mockIssueVirtualCard = jest.fn().mockResolvedValue({
  id: 'vc-1',
  intentId: 'intent-1',
  providerCardId: 'ic_test',
  last4: '4242',
});
const mockRevealCard = jest.fn().mockResolvedValue({
  number: '4242424242424242',
  cvc: '123',
  expMonth: 12,
  expYear: 2027,
  last4: '4242',
});
const mockCancelCard = jest.fn().mockResolvedValue(undefined);
const mockGetIssuingBalance = jest
  .fn()
  .mockResolvedValue({ available: 999_999_99, currency: 'eur' });
const mockPaymentProvider = {
  metadata: { id: 'STRIPE', currency: 'eur' },
  issueCard: mockIssueVirtualCard,
  revealCard: mockRevealCard,
  freezeCard: jest.fn().mockResolvedValue(undefined),
  cancelCard: mockCancelCard,
  handleWebhookEvent: jest.fn().mockResolvedValue({ received: true }),
  getIssuingBalance: mockGetIssuingBalance,
};
jest.mock('@/payments', () => ({
  getPaymentProvider: () => mockPaymentProvider,
  getProviderForIntent: () => Promise.resolve(mockPaymentProvider),
  getProviderForUser: () => Promise.resolve(mockPaymentProvider),
}));

// Stripe (needed by webhooks route import chain)
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));

// Telegram notification service
const mockSendApprovalRequest = jest.fn().mockResolvedValue(undefined);
jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: mockSendApprovalRequest,
}));

// DB — user-1 has a pre-hashed API key so userAuthMiddleware can authenticate requests
import bcrypt from 'bcryptjs';
const TEST_RAW_KEY = 'test-api-key-for-wiring-tests';
const TEST_KEY_PREFIX = TEST_RAW_KEY.slice(0, 16);
let TEST_KEY_HASH: string;

const dbUsers: Record<string, any> = {
  'user-1': {
    id: 'user-1',
    email: 'test@agentpay.dev',
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
const dbVirtualCards: Record<string, any> = {}; // keyed by intentId
const dbIdempotency: Record<string, any> = {};
const dbPairingCodes: Record<string, any> = {}; // keyed by agentId

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
    },
    purchaseIntent: {
      create: jest.fn(({ data }: any) => {
        const intent = {
          id: `intent-${Date.now()}`,
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        dbIntents[intent.id] = intent;
        return Promise.resolve(intent);
      }),
      findUnique: jest.fn(({ where, include }: any) => {
        const intent = dbIntents[where.id] ?? null;
        if (!intent || !include?.virtualCard) return Promise.resolve(intent);
        return Promise.resolve({ ...intent, virtualCard: dbVirtualCards[intent.id] ?? null });
      }),
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
        // lookup by code
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

// ─── Tests ────────────────────────────────────────────────────────────────────

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';
import { IntentStatus } from '@/contracts';

const AUTH_HEADER = `Bearer ${TEST_RAW_KEY}`;

let app: FastifyInstance;

beforeAll(async () => {
  TEST_KEY_HASH = await bcrypt.hash(TEST_RAW_KEY, 10);
  dbUsers['user-1'].apiKeyHash = TEST_KEY_HASH;
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  // Reset DB state
  Object.keys(dbIntents).forEach((k) => delete dbIntents[k]);
  Object.keys(dbVirtualCards).forEach((k) => delete dbVirtualCards[k]);
  Object.keys(dbIdempotency).forEach((k) => delete dbIdempotency[k]);
  Object.keys(dbPairingCodes).forEach((k) => delete dbPairingCodes[k]);
});

// ─── POST /v1/webhooks/stripe ─────────────────────────────────────────────────

describe('POST /v1/webhooks/stripe wiring', () => {
  it('calls handleWebhookEvent with raw body (Buffer) and signature', async () => {
    mockPaymentProvider.handleWebhookEvent.mockClear();
    const payload = JSON.stringify({ type: 'issuing_authorization.created' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 'sig-test' },
      body: payload,
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
    expect(mockPaymentProvider.handleWebhookEvent).toHaveBeenCalledTimes(1);
    const [bodyArg, sigArg] = mockPaymentProvider.handleWebhookEvent.mock.calls[0];
    expect(Buffer.isBuffer(bodyArg)).toBe(true);
    expect(bodyArg?.toString()).toBe(payload);
    expect(sigArg).toBe('sig-test');
  });
});

// ─── POST /v1/intents ─────────────────────────────────────────────────────────

describe('POST /v1/intents wiring', () => {
  it('calls startSearching after creating intent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'idem-1',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ query: 'headphones', maxBudget: 10000, currency: 'gbp' }),
    });

    expect(res.statusCode).toBe(201);
    expect(mockStartSearching).toHaveBeenCalledTimes(1);
    const intentId = mockStartSearching.mock.calls[0][0];
    expect(typeof intentId).toBe('string');
  });

  it('calls enqueueSearch with correct payload after creating intent', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'idem-2',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ query: 'Sony headphones', maxBudget: 30000, currency: 'gbp' }),
    });

    expect(res.statusCode).toBe(201);
    expect(mockEnqueueSearch).toHaveBeenCalledTimes(1);
    const [intentId, payload] = mockEnqueueSearch.mock.calls[0];
    expect(payload).toMatchObject({
      userId: 'user-1',
      query: 'Sony headphones',
      maxBudget: 30000,
      currency: 'eur',
    });
    expect(payload.intentId).toBe(intentId);
  });

  it('returns SEARCHING status (not RECEIVED)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'idem-3',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ query: 'test', maxBudget: 5000, currency: 'gbp' }),
    });

    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.body).status).toBe(IntentStatus.SEARCHING);
  });
});

// ─── POST /v1/agent/quote ─────────────────────────────────────────────────────

describe('POST /v1/agent/quote wiring', () => {
  function seedSearchingIntent(id: string) {
    dbIntents[id] = {
      id,
      userId: 'user-1',
      status: IntentStatus.SEARCHING,
      metadata: {},
      maxBudget: 10000,
      currency: 'gbp',
    };
  }

  it('calls receiveQuote then requestApproval via orchestrator', async () => {
    seedSearchingIntent('intent-q1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({
        intentId: 'intent-q1',
        merchantName: 'Amazon UK',
        merchantUrl: 'https://amazon.co.uk',
        price: 9999,
        currency: 'gbp',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockReceiveQuote).toHaveBeenCalledWith(
      'intent-q1',
      expect.objectContaining({
        merchantName: 'Amazon UK',
        merchantUrl: 'https://amazon.co.uk',
        price: 9999,
      }),
    );
    expect(mockRequestApproval).toHaveBeenCalledWith('intent-q1');
  });

  it('does NOT call receiveQuote for non-SEARCHING intent', async () => {
    dbIntents['intent-q2'] = { id: 'intent-q2', status: IntentStatus.DONE };

    await app.inject({
      method: 'POST',
      url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({
        intentId: 'intent-q2',
        merchantName: 'X',
        merchantUrl: 'https://x.com',
        price: 1,
        currency: 'gbp',
      }),
    });

    expect(mockReceiveQuote).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('fires sendApprovalRequest after requestApproval succeeds', async () => {
    seedSearchingIntent('intent-q3');

    await app.inject({
      method: 'POST',
      url: '/v1/agent/quote',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({
        intentId: 'intent-q3',
        merchantName: 'Amazon UK',
        merchantUrl: 'https://amazon.co.uk',
        price: 9999,
        currency: 'gbp',
      }),
    });

    // Allow the fire-and-forget promise to settle
    await new Promise((resolve) => setImmediate(resolve));

    expect(mockSendApprovalRequest).toHaveBeenCalledWith('intent-q3');
  });
});

// ─── POST /v1/approvals/:id/decision ─────────────────────────────────────────

describe('POST /v1/approvals/:id/decision wiring — APPROVED', () => {
  function seedAwaitingIntent(id: string) {
    dbIntents[id] = {
      id,
      userId: 'user-1',
      status: IntentStatus.AWAITING_APPROVAL,
      maxBudget: 10000,
      currency: 'eur',
      metadata: { merchantName: 'Amazon UK', merchantUrl: 'https://amazon.co.uk', price: 9999 },
      user: {
        id: 'user-1',
        email: 'test@agentpay.dev',
        mccAllowlist: [],
        paymentProvider: 'STRIPE',
      },
    };
  }

  it('calls recordDecision with correct args', async () => {
    seedAwaitingIntent('intent-a1');

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a1/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-1',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1', reason: 'looks good' }),
    });

    expect(mockRecordDecision).toHaveBeenCalledWith(
      'intent-a1',
      'APPROVED',
      'user-1',
      'looks good',
    );
  });

  it('calls reserveForIntent with userId and maxBudget', async () => {
    seedAwaitingIntent('intent-a2');

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a2/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-2',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(mockReserveForIntent).toHaveBeenCalledWith('user-1', 'intent-a2', 10000);
  });

  it('calls issueVirtualCard with intentId and maxBudget', async () => {
    seedAwaitingIntent('intent-a3');

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a3/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-3',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(mockIssueVirtualCard).toHaveBeenCalledWith('intent-a3', 10000, expect.any(Object));
  });

  it('calls markCardIssued and startCheckout via orchestrator', async () => {
    seedAwaitingIntent('intent-a4');

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a4/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-4',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(mockMarkCardIssued).toHaveBeenCalledWith('intent-a4');
    expect(mockStartCheckout).toHaveBeenCalledWith('intent-a4');
  });

  it('calls enqueueCheckout with card details from issueVirtualCard', async () => {
    seedAwaitingIntent('intent-a5');

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a5/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-5',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(mockEnqueueCheckout).toHaveBeenCalledWith(
      'intent-a5',
      expect.objectContaining({
        intentId: 'intent-a5',
        userId: 'user-1',
        providerCardId: 'ic_test',
        last4: '4242',
      }),
    );
  });

  it('returns returnIntent funds if card issuance fails', async () => {
    seedAwaitingIntent('intent-a6');
    mockIssueVirtualCard.mockRejectedValueOnce(new Error('Stripe unavailable'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a6/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-6',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(mockReserveForIntent).toHaveBeenCalledWith('user-1', 'intent-a6', 10000);
    expect(mockReturnIntent).toHaveBeenCalledWith('intent-a6');
    expect(res.statusCode).toBe(500);
  });

  it('returns 422 when InsufficientFundsError is thrown', async () => {
    seedAwaitingIntent('intent-a7');
    const { InsufficientFundsError } = await import('@/contracts');
    mockReserveForIntent.mockRejectedValueOnce(new InsufficientFundsError(500, 10000));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a7/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-7',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toContain('Insufficient funds');
  });

  it('calls getIssuingBalance before recordDecision and reserveForIntent', async () => {
    seedAwaitingIntent('intent-a9');
    const order: string[] = [];
    mockGetIssuingBalance.mockImplementationOnce(() => {
      order.push('getIssuingBalance');
      return Promise.resolve({ available: 999_999_99, currency: 'gbp' });
    });
    mockRecordDecision.mockImplementationOnce(() => {
      order.push('recordDecision');
      return Promise.resolve({ decision: 'APPROVED' });
    });
    mockReserveForIntent.mockImplementationOnce(() => {
      order.push('reserveForIntent');
      return Promise.resolve({ id: 'pot-1', reservedAmount: 10000 });
    });

    await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a9/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-9',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(order).toEqual(['getIssuingBalance', 'recordDecision', 'reserveForIntent']);
  });

  it('returns 422 when Stripe Issuing balance is insufficient — no recordDecision or reserve', async () => {
    seedAwaitingIntent('intent-a10');
    mockGetIssuingBalance.mockResolvedValueOnce({ available: 500, currency: 'gbp' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a10/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-10',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.body).error).toContain('Insufficient Stripe Issuing balance');
    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockReserveForIntent).not.toHaveBeenCalled();
    expect(mockIssueVirtualCard).not.toHaveBeenCalled();
  });

  it('response status is CHECKOUT_RUNNING when approved', async () => {
    seedAwaitingIntent('intent-a8');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-a8/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'appr-8',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'APPROVED', actorId: 'user-1' }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(IntentStatus.CHECKOUT_RUNNING);
  });
});

describe('POST /v1/approvals/:id/decision wiring — DENIED', () => {
  it('does NOT call reserveForIntent, issueVirtualCard, or enqueueCheckout when denied', async () => {
    dbIntents['intent-d1'] = {
      id: 'intent-d1',
      userId: 'user-1',
      status: IntentStatus.AWAITING_APPROVAL,
      maxBudget: 10000,
      currency: 'gbp',
      metadata: {},
      user: { id: 'user-1', email: 'test@agentpay.dev', mccAllowlist: [] },
    };
    mockRecordDecision.mockResolvedValueOnce({ decision: 'DENIED' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/approvals/intent-d1/decision',
      headers: {
        'content-type': 'application/json',
        'x-idempotency-key': 'deny-1',
        authorization: AUTH_HEADER,
      },
      body: JSON.stringify({ decision: 'DENIED', actorId: 'user-1', reason: 'too expensive' }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockReserveForIntent).not.toHaveBeenCalled();
    expect(mockIssueVirtualCard).not.toHaveBeenCalled();
    expect(mockEnqueueCheckout).not.toHaveBeenCalled();
    expect(JSON.parse(res.body).status).toBe(IntentStatus.DENIED);
  });
});

// ─── POST /v1/agent/result ────────────────────────────────────────────────────

describe('POST /v1/agent/result wiring — success', () => {
  function seedRunningIntent(id: string) {
    dbIntents[id] = { id, userId: 'user-1', status: IntentStatus.CHECKOUT_RUNNING, metadata: {} };
  }

  it('calls completeCheckout and settleIntent on success', async () => {
    seedRunningIntent('intent-r1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'intent-r1', success: true, actualAmount: 8000 }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockCompleteCheckout).toHaveBeenCalledWith('intent-r1', 8000);
    expect(mockSettleIntent).toHaveBeenCalledWith('intent-r1', 8000);
    expect(mockFailCheckout).not.toHaveBeenCalled();
    expect(mockReturnIntent).not.toHaveBeenCalled();
  });

  it('calls cancelCard after successful checkout', async () => {
    seedRunningIntent('intent-r2');

    await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'intent-r2', success: true, actualAmount: 5000 }),
    });

    expect(mockCancelCard).toHaveBeenCalledWith('intent-r2');
  });

  it('returns DONE status on success', async () => {
    seedRunningIntent('intent-r3');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'intent-r3', success: true, actualAmount: 5000 }),
    });

    expect(JSON.parse(res.body).status).toBe(IntentStatus.DONE);
  });
});

describe('POST /v1/agent/result wiring — failure', () => {
  function seedRunningIntent(id: string) {
    dbIntents[id] = { id, userId: 'user-1', status: IntentStatus.CHECKOUT_RUNNING, metadata: {} };
  }

  it('calls failCheckout and returnIntent on failure', async () => {
    seedRunningIntent('intent-f1');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({
        intentId: 'intent-f1',
        success: false,
        errorMessage: 'Payment declined',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockFailCheckout).toHaveBeenCalledWith('intent-f1', 'Payment declined');
    expect(mockReturnIntent).toHaveBeenCalledWith('intent-f1');
    expect(mockCompleteCheckout).not.toHaveBeenCalled();
    expect(mockSettleIntent).not.toHaveBeenCalled();
  });

  it('calls cancelCard after failed checkout', async () => {
    seedRunningIntent('intent-f2');

    await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'intent-f2', success: false, errorMessage: 'timeout' }),
    });

    expect(mockCancelCard).toHaveBeenCalledWith('intent-f2');
  });

  it('returns FAILED status on failure', async () => {
    seedRunningIntent('intent-f3');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/result',
      headers: { 'content-type': 'application/json', 'x-worker-key': 'test-worker-key' },
      body: JSON.stringify({ intentId: 'intent-f3', success: false }),
    });

    expect(JSON.parse(res.body).status).toBe(IntentStatus.FAILED);
  });
});

// ─── GET /v1/agent/card/:intentId ─────────────────────────────────────────────

describe('GET /v1/agent/card/:intentId wiring', () => {
  it('delegates to cardService.revealCard', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/card/intent-c1',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(mockRevealCard).toHaveBeenCalledWith('intent-c1');
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.last4).toBe('4242');
    expect(body.number).toBe('4242424242424242');
  });

  it('returns 409 when CardAlreadyRevealedError is thrown', async () => {
    const { CardAlreadyRevealedError } = await import('@/contracts');
    mockRevealCard.mockRejectedValueOnce(new CardAlreadyRevealedError('intent-c2'));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/card/intent-c2',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).error).toContain('already been revealed');
  });

  it('returns 404 when IntentNotFoundError is thrown', async () => {
    const { IntentNotFoundError } = await import('@/contracts');
    mockRevealCard.mockRejectedValueOnce(new IntentNotFoundError('intent-c3'));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/card/intent-c3',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(404);
  });
});

// ─── GET /v1/agent/decision/:intentId ─────────────────────────────────────────

describe('GET /v1/agent/decision/:intentId wiring', () => {
  function seedIntent(id: string, status: string, virtualCard?: any) {
    dbIntents[id] = {
      id,
      userId: 'user-1',
      status,
      metadata: {},
      maxBudget: 10000,
      currency: 'gbp',
    };
    if (virtualCard !== undefined) {
      dbVirtualCards[id] = virtualCard;
    }
  }

  function _makeCard(intentId: string, revealedAt: Date | null = null) {
    return { id: 'vc-1', intentId, providerCardId: 'ic_test', last4: '4242', revealedAt };
  }

  it('returns 401 without X-Worker-Key header', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec1',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 when intent not found', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/nonexistent',
      headers: { 'x-worker-key': 'test-worker-key' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns AWAITING_APPROVAL without calling revealCard', async () => {
    seedIntent('intent-dec3', IntentStatus.AWAITING_APPROVAL);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec3',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(IntentStatus.AWAITING_APPROVAL);
    expect(mockRevealCard).not.toHaveBeenCalled();
  });

  it('returns DENIED without calling revealCard', async () => {
    seedIntent('intent-dec4', IntentStatus.DENIED);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec4',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(IntentStatus.DENIED);
    expect(mockRevealCard).not.toHaveBeenCalled();
  });

  it('returns APPROVED with checkout params when CARD_ISSUED', async () => {
    seedIntent('intent-dec5', IntentStatus.CARD_ISSUED);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec5',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe(IntentStatus.APPROVED);
    expect(body.checkout).toBeDefined();
    expect(body.checkout.intentId).toBe('intent-dec5');
    expect(body.checkout.amount).toBe(10000); // falls back to maxBudget
    expect(body.checkout.currency).toBe('gbp');
    expect(mockRevealCard).not.toHaveBeenCalled();
  });

  it('returns APPROVED with checkout params when CHECKOUT_RUNNING', async () => {
    seedIntent('intent-dec6', IntentStatus.CHECKOUT_RUNNING);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec6',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe(IntentStatus.APPROVED);
    expect(body.checkout).toBeDefined();
    expect(body.checkout.intentId).toBe('intent-dec6');
    expect(mockRevealCard).not.toHaveBeenCalled();
  });

  it('returns quote price when metadata has quote', async () => {
    seedIntent('intent-dec7', IntentStatus.CARD_ISSUED);
    dbIntents['intent-dec7'].metadata = { quote: { price: 3499 } };

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec7',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe(IntentStatus.APPROVED);
    expect(body.checkout.amount).toBe(3499); // quote price takes priority over maxBudget
  });

  it('returns APPROVED with checkout params when DONE', async () => {
    seedIntent('intent-dec8', IntentStatus.DONE);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec8',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe(IntentStatus.APPROVED);
    expect(body.checkout).toBeDefined();
    expect(mockRevealCard).not.toHaveBeenCalled();
  });

  it('returns AWAITING_APPROVAL for APPROVED status (brief transition state)', async () => {
    seedIntent('intent-dec9', IntentStatus.APPROVED);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec9',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe(IntentStatus.AWAITING_APPROVAL);
  });

  it('returns checkout params and no card field when DONE', async () => {
    seedIntent('intent-dec10', IntentStatus.DONE);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-dec10',
      headers: { 'x-worker-key': 'test-worker-key' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe(IntentStatus.APPROVED);
    expect(body.card).toBeUndefined();
    expect(body.checkout).toBeDefined();
    expect(mockRevealCard).not.toHaveBeenCalled();
  });
});

// ─── POST /v1/agent/register ──────────────────────────────────────────────────

describe('POST /v1/agent/register wiring', () => {
  it('returns 401 without X-Worker-Key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/agent/register', payload: {} });
    expect(res.statusCode).toBe(401);
  });

  it('creates a new agentId and pairingCode on first registration', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': 'test-worker-key' },
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agentId).toMatch(/^ag_/);
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(body.expiresAt).toBeDefined();
  });

  it('returns 404 when renewing with unknown agentId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': 'test-worker-key' },
      payload: { agentId: 'ag_nonexistent' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 409 when renewing an already-claimed agent', async () => {
    dbPairingCodes['ag_claimed'] = {
      id: 'pc-1',
      agentId: 'ag_claimed',
      code: 'AAAABBBB',
      claimedByUserId: 'user-existing',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': 'test-worker-key' },
      payload: { agentId: 'ag_claimed' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('renews code for unclaimed agent', async () => {
    dbPairingCodes['ag_renew'] = {
      id: 'pc-2',
      agentId: 'ag_renew',
      code: 'OLDCOD12',
      claimedByUserId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 6 * 60 * 1000), // 6 min ago — past cooldown
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': 'test-worker-key' },
      payload: { agentId: 'ag_renew' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agentId).toBe('ag_renew');
    expect(body.pairingCode).toMatch(/^[A-Z0-9]{8}$/);
  });
});

// ─── GET /v1/agent/user ───────────────────────────────────────────────────────

describe('GET /v1/agent/user wiring', () => {
  it('returns 401 without X-Worker-Key', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/agent/user' });
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when X-Agent-Id header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': 'test-worker-key' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('X-Agent-Id');
  });

  it('returns 404 when agentId is unknown', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': 'test-worker-key', 'x-agent-id': 'ag_unknown' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns unclaimed status when code not yet used', async () => {
    dbPairingCodes['ag_pending'] = {
      id: 'pc-3',
      agentId: 'ag_pending',
      code: 'PEND1234',
      claimedByUserId: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': 'test-worker-key', 'x-agent-id': 'ag_pending' },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).status).toBe('unclaimed');
  });

  it('returns claimed status with userId after user signs up', async () => {
    dbPairingCodes['ag_done'] = {
      id: 'pc-4',
      agentId: 'ag_done',
      code: 'DONE1234',
      claimedByUserId: 'user-signup-1',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(),
    };

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': 'test-worker-key', 'x-agent-id': 'ag_done' },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.status).toBe('claimed');
    expect(body.userId).toBe('user-signup-1');
  });
});

// ─── POST /v1/checkout/simulate ───────────────────────────────────────────────

describe('POST /v1/checkout/simulate wiring', () => {
  it('is reachable — returns 400 on empty body (not 404)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/simulate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.statusCode).toBe(400);
  });

  it('calls runSimulatedCheckout with parsed body and returns 200', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/checkout/simulate',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        intentId: 'intent-wiring-test',
        amount: 5000,
        currency: 'eur',
        merchantName: 'Test Merchant',
      }),
    });

    expect(res.statusCode).toBe(200);
    expect(mockRunSimulatedCheckout).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-wiring-test', amount: 5000, currency: 'eur' }),
    );
    const body = JSON.parse(res.body);
    expect(body.success).toBe(true);
    expect(body.chargeId).toBe('pi_wiring_test');
  });
});
