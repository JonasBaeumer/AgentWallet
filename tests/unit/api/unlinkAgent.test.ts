/**
 * Unit tests for POST /v1/users/:userId/unlink-agent (issue #15):
 * - Only the authenticated user can unlink their own agent
 * - All active intents are expired before the agent is unlinked
 * - AGENT_UNLINKED AuditEvent is emitted
 * - User.agentId is cleared; PairingCode.claimedByUserId is cleared
 */

import bcrypt from 'bcryptjs';

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

jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));
jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/payments', () => ({ getPaymentProvider: () => ({ handleWebhookEvent: jest.fn() }) }));

// Orchestrator mock — capture expireIntent calls
const mockExpireIntent = jest.fn().mockResolvedValue({ newStatus: 'EXPIRED' });
jest.mock('@/orchestrator/intentService', () => ({
  expireIntent: mockExpireIntent,
  startSearching: jest.fn(),
  receiveQuote: jest.fn(),
  requestApproval: jest.fn(),
  completeCheckout: jest.fn(),
  failCheckout: jest.fn(),
  getIntentWithHistory: jest.fn(),
}));

jest.mock('@/ledger/potService', () => ({ settleIntent: jest.fn(), returnIntent: jest.fn() }));
jest.mock('@/approval/approvalService', () => ({ recordDecision: jest.fn() }));
jest.mock('@/queue/producers', () => ({ enqueueSearch: jest.fn(), enqueueCheckout: jest.fn() }));

// ─── DB mock ──────────────────────────────────────────────────────────────────

const TEST_RAW_KEY = 'unlink-test-api-key-00000000000';
const TEST_KEY_PREFIX = TEST_RAW_KEY.slice(0, 16);
let TEST_KEY_HASH: string;

const dbUsers: Record<string, any> = {};
const dbIntents: Record<string, any> = {};
const dbPairingCodes: Record<string, any> = {};
const dbAuditEvents: any[] = [];

// Transaction helper: runs the callback with a tx object delegating to the same mocks
const txMock = {
  user: {
    update: jest.fn(({ where, data }: any) => {
      dbUsers[where.id] = { ...dbUsers[where.id], ...data };
      return Promise.resolve(dbUsers[where.id]);
    }),
  },
  pairingCode: {
    updateMany: jest.fn(({ where, data }: any) => {
      Object.values(dbPairingCodes).forEach((pc: any) => {
        if (pc.agentId === where.agentId && pc.claimedByUserId === where.claimedByUserId) {
          Object.assign(pc, data);
        }
      });
      return Promise.resolve({ count: 1 });
    }),
  },
  auditEvent: {
    create: jest.fn(({ data }: any) => {
      dbAuditEvents.push(data);
      return Promise.resolve({ id: `ae-${Date.now()}`, ...data });
    }),
  },
};

jest.mock('@/db/client', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(({ where }: any) => {
        if (where.id) return Promise.resolve(dbUsers[where.id] ?? null);
        if (where.apiKeyPrefix) {
          const found = Object.values(dbUsers).find((u: any) => u.apiKeyPrefix === where.apiKeyPrefix);
          return Promise.resolve(found ?? null);
        }
        return Promise.resolve(null);
      }),
    },
    purchaseIntent: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
      findMany: jest.fn(({ where }: any) =>
        Promise.resolve(Object.values(dbIntents).filter((i: any) => i.userId === where.userId && where.status?.in?.includes(i.status)))
      ),
    },
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    auditEvent: { create: jest.fn() },
    pairingCode: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      update: jest.fn(),
    },
    $transaction: jest.fn(async (fn: any) => fn(txMock)),
  },
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';
import { IntentStatus } from '@/contracts';

let app: FastifyInstance;

beforeAll(async () => {
  TEST_KEY_HASH = await bcrypt.hash(TEST_RAW_KEY, 10);
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(dbUsers).forEach((k) => delete dbUsers[k]);
  Object.keys(dbIntents).forEach((k) => delete dbIntents[k]);
  Object.keys(dbPairingCodes).forEach((k) => delete dbPairingCodes[k]);
  dbAuditEvents.length = 0;

  // Reset tx mocks
  txMock.user.update.mockClear();
  txMock.pairingCode.updateMany.mockClear();
  txMock.auditEvent.create.mockClear();
});

function seedUser(agentId: string | null = 'ag_linked') {
  dbUsers['user-1'] = {
    id: 'user-1',
    email: 'user@example.com',
    agentId,
    mainBalance: 100000,
    maxBudgetPerIntent: 50000,
    merchantAllowlist: [],
    mccAllowlist: [],
    apiKeyHash: TEST_KEY_HASH,
    apiKeyPrefix: TEST_KEY_PREFIX,
    createdAt: new Date(),
  };
}

const AUTH = `Bearer ${TEST_RAW_KEY}`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('POST /v1/users/:userId/unlink-agent', () => {
  it('returns 401 without Authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 403 when authenticated user tries to unlink a different user', async () => {
    seedUser('ag_linked');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-other/unlink-agent',
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toContain('Forbidden');
  });

  it('returns 409 when the authenticated user has no linked agent', async () => {
    seedUser(null); // no agentId

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('No agent');
  });

  it('expires all active intents before unlinking', async () => {
    seedUser('ag_linked');
    dbIntents['i-1'] = { id: 'i-1', userId: 'user-1', status: IntentStatus.SEARCHING };
    dbIntents['i-2'] = { id: 'i-2', userId: 'user-1', status: IntentStatus.AWAITING_APPROVAL };
    dbIntents['i-done'] = { id: 'i-done', userId: 'user-1', status: IntentStatus.DONE }; // terminal — not expired

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    expect(res.statusCode).toBe(200);
    expect(mockExpireIntent).toHaveBeenCalledWith('i-1');
    expect(mockExpireIntent).toHaveBeenCalledWith('i-2');
    expect(mockExpireIntent).not.toHaveBeenCalledWith('i-done');
    const body = res.json();
    expect(body.cancelledIntentIds).toContain('i-1');
    expect(body.cancelledIntentIds).toContain('i-2');
  });

  it('clears agentId from user in the transaction', async () => {
    seedUser('ag_linked');

    await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    expect(txMock.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: { agentId: null },
      }),
    );
  });

  it('clears claimedByUserId from PairingCode in the transaction', async () => {
    seedUser('ag_linked');

    await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    expect(txMock.pairingCode.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { agentId: 'ag_linked', claimedByUserId: 'user-1' },
        data: { claimedByUserId: null },
      }),
    );
  });

  it('emits AGENT_UNLINKED audit event with intentId null', async () => {
    seedUser('ag_linked');

    await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    expect(txMock.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          intentId: null,
          actor: 'user-1',
          event: 'AGENT_UNLINKED',
          payload: expect.objectContaining({ agentId: 'ag_linked' }),
        }),
      }),
    );
  });

  it('returns success response with agentId and cancelled intent IDs', async () => {
    seedUser('ag_linked');
    dbIntents['i-active'] = { id: 'i-active', userId: 'user-1', status: IntentStatus.SEARCHING };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.unlinked).toBe(true);
    expect(body.agentId).toBe('ag_linked');
    expect(body.cancelledIntentIds).toEqual(['i-active']);
  });

  it('continues unlinking even if expiring an intent fails', async () => {
    seedUser('ag_linked');
    dbIntents['i-fail'] = { id: 'i-fail', userId: 'user-1', status: IntentStatus.SEARCHING };
    mockExpireIntent.mockRejectedValueOnce(new Error('state machine error'));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/unlink-agent',
      headers: { authorization: AUTH },
    });

    // Unlink still succeeds despite the expiry failure
    expect(res.statusCode).toBe(200);
    expect(txMock.user.update).toHaveBeenCalled();
  });
});
