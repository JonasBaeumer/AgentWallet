import bcrypt from 'bcryptjs';

jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'bootstrap-worker-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
  },
}));

const mockReceiveQuote = jest.fn().mockResolvedValue({ newStatus: 'QUOTED' });
const mockRequestApproval = jest.fn().mockResolvedValue({ newStatus: 'AWAITING_APPROVAL' });
const mockCompleteCheckout = jest.fn().mockResolvedValue({ newStatus: 'DONE' });
const mockFailCheckout = jest.fn().mockResolvedValue({ newStatus: 'FAILED' });

jest.mock('@/orchestrator/intentService', () => ({
  receiveQuote: mockReceiveQuote,
  requestApproval: mockRequestApproval,
  completeCheckout: mockCompleteCheckout,
  failCheckout: mockFailCheckout,
  startSearching: jest.fn(),
  expireIntent: jest.fn(),
  getIntentWithHistory: jest.fn(),
}));

const mockSettleIntent = jest.fn().mockResolvedValue(undefined);
const mockReturnIntent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/ledger/potService', () => ({
  settleIntent: mockSettleIntent,
  returnIntent: mockReturnIntent,
}));

const mockRevealCard = jest.fn().mockResolvedValue({
  number: '4242424242424242',
  cvc: '123',
  expMonth: 12,
  expYear: 2030,
  last4: '4242',
});
const mockCancelCard = jest.fn().mockResolvedValue(undefined);
const mockProvider = {
  metadata: { id: 'STRIPE', currency: 'eur' },
  revealCard: mockRevealCard,
  cancelCard: mockCancelCard,
  issueCard: jest.fn(),
  freezeCard: jest.fn(),
  handleWebhookEvent: jest.fn(),
  getIssuingBalance: jest.fn(),
};
jest.mock('@/payments', () => ({
  getPaymentProvider: () => mockProvider,
  getProviderForIntent: () => Promise.resolve(mockProvider),
  getProviderForUser: () => Promise.resolve(mockProvider),
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

const AGENT_A_ID = 'ag_authorized_a';
const AGENT_B_ID = 'ag_authorized_b';
const AGENT_A_KEY = `agk_${'a'.repeat(43)}`;
const AGENT_B_KEY = `agk_${'b'.repeat(43)}`;

const dbUsers: Record<string, any> = {};
const dbAgents: Record<string, any> = {};
const dbIntents: Record<string, any> = {};
const dbAuditEvents: any[] = [];

const pairingCodeStore = {
  findUnique: jest.fn(({ where }: any) => {
    if (where.agentId) return Promise.resolve(dbAgents[where.agentId] ?? null);
    if (where.credentialPrefix) {
      return Promise.resolve(
        Object.values(dbAgents).find(
          (record: any) => record.credentialPrefix === where.credentialPrefix,
        ) ?? null,
      );
    }
    return Promise.resolve(null);
  }),
  create: jest.fn(({ data }: any) => {
    const record = { id: `pc-${data.agentId}`, ...data, createdAt: new Date() };
    dbAgents[record.agentId] = record;
    return Promise.resolve(record);
  }),
  update: jest.fn(({ where, data }: any) => {
    dbAgents[where.agentId] = { ...dbAgents[where.agentId], ...data };
    return Promise.resolve(dbAgents[where.agentId]);
  }),
  updateMany: jest.fn(({ where, data }: any) => {
    const record = dbAgents[where.agentId];
    if (
      !record ||
      (where.credentialVersion !== undefined &&
        record.credentialVersion !== where.credentialVersion) ||
      (where.credentialRevokedAt === null && record.credentialRevokedAt !== null)
    ) {
      return Promise.resolve({ count: 0 });
    }
    dbAgents[where.agentId] = {
      ...record,
      ...data,
      credentialVersion:
        typeof data.credentialVersion === 'object'
          ? record.credentialVersion + data.credentialVersion.increment
          : data.credentialVersion,
    };
    return Promise.resolve({ count: 1 });
  }),
};

const auditEventStore = {
  create: jest.fn(({ data }: any) => {
    dbAuditEvents.push(data);
    return Promise.resolve({ id: `audit-${dbAuditEvents.length}`, ...data });
  }),
};

jest.mock('@/db/client', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbUsers[where.id] ?? null)),
    },
    pairingCode: pairingCodeStore,
    purchaseIntent: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbIntents[where.id] ?? null)),
      update: jest.fn(({ where, data }: any) => {
        dbIntents[where.id] = { ...dbIntents[where.id], ...data };
        return Promise.resolve(dbIntents[where.id]);
      }),
    },
    auditEvent: auditEventStore,
    idempotencyRecord: { findUnique: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(async (callback: any) =>
      callback({ pairingCode: pairingCodeStore, auditEvent: auditEventStore }),
    ),
  },
}));

import { buildApp } from '@/app';
import { IntentStatus } from '@/contracts';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let agentAHash: string;
let agentBHash: string;

function agentRecord(agentId: string, userId: string | null, rawKey: string, hash: string) {
  return {
    id: `pc-${agentId}`,
    agentId,
    code: 'PAIR1234',
    claimedByUserId: userId,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    codeIssuedAt: new Date(Date.now() - 6 * 60 * 1000),
    credentialHash: hash,
    credentialPrefix: rawKey.slice(0, 16),
    credentialExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    credentialVersion: 1,
    credentialRevokedAt: null,
    createdAt: new Date(),
  };
}

function intent(id: string, userId: string, agentId: string, status: IntentStatus) {
  return {
    id,
    userId,
    agentId,
    query: 'test purchase',
    maxBudget: 10_000,
    currency: 'eur',
    status,
    metadata: {},
    idempotencyKey: `idem-${id}`,
    createdAt: new Date(),
    updatedAt: new Date(),
    expiresAt: null,
  };
}

beforeAll(async () => {
  [agentAHash, agentBHash] = await Promise.all([
    bcrypt.hash(AGENT_A_KEY, 4),
    bcrypt.hash(AGENT_B_KEY, 4),
  ]);
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  dbAuditEvents.length = 0;
  Object.keys(dbUsers).forEach((key) => delete dbUsers[key]);
  Object.keys(dbAgents).forEach((key) => delete dbAgents[key]);
  Object.keys(dbIntents).forEach((key) => delete dbIntents[key]);

  dbUsers['user-a'] = { id: 'user-a', agentId: AGENT_A_ID };
  dbUsers['user-b'] = { id: 'user-b', agentId: AGENT_B_ID };
  dbAgents[AGENT_A_ID] = agentRecord(AGENT_A_ID, 'user-a', AGENT_A_KEY, agentAHash);
  dbAgents[AGENT_B_ID] = agentRecord(AGENT_B_ID, 'user-b', AGENT_B_KEY, agentBHash);
});

describe('agent credential error contracts', () => {
  it('returns stable errors for missing, invalid, expired, and unclaimed credentials', async () => {
    const missing = await app.inject({ method: 'GET', url: '/v1/agent/user' });
    expect(missing.statusCode).toBe(401);
    expect(missing.json().code).toBe('agent_credential_missing');

    const invalid = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-agent-key': `agk_${'x'.repeat(43)}` },
    });
    expect(invalid.statusCode).toBe(401);
    expect(invalid.json().code).toBe('agent_credential_invalid');

    dbAgents[AGENT_A_ID].credentialExpiresAt = new Date(0);
    const expired = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-agent-key': AGENT_A_KEY },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('agent_credential_expired');

    dbAgents[AGENT_A_ID].credentialExpiresAt = new Date(Date.now() + 60_000);
    dbAgents[AGENT_A_ID].claimedByUserId = null;
    const unclaimed = await app.inject({
      method: 'GET',
      url: '/v1/agent/decision/intent-a',
      headers: { 'x-agent-key': AGENT_A_KEY },
    });
    expect(unclaimed.statusCode).toBe(403);
    expect(unclaimed.json().code).toBe('agent_not_linked');
  });

  it('rejects X-Agent-Id impersonation even with a valid credential', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-agent-key': AGENT_A_KEY, 'x-agent-id': AGENT_B_ID },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json().code).toBe('agent_identity_mismatch');
  });
});

describe('intent ownership across every agent route', () => {
  const cases = [
    {
      name: 'quote',
      intentId: 'intent-quote',
      status: IntentStatus.SEARCHING,
      request: {
        method: 'POST' as const,
        url: '/v1/agent/quote',
        payload: {
          intentId: 'intent-quote',
          merchantName: 'Merchant',
          merchantUrl: 'https://merchant.example',
          price: 100,
          currency: 'eur',
        },
      },
    },
    {
      name: 'result',
      intentId: 'intent-result',
      status: IntentStatus.CHECKOUT_RUNNING,
      request: {
        method: 'POST' as const,
        url: '/v1/agent/result',
        payload: { intentId: 'intent-result', success: true, actualAmount: 100 },
      },
    },
    {
      name: 'decision',
      intentId: 'intent-decision',
      status: IntentStatus.AWAITING_APPROVAL,
      request: { method: 'GET' as const, url: '/v1/agent/decision/intent-decision' },
    },
    {
      name: 'card',
      intentId: 'intent-card',
      status: IntentStatus.CARD_ISSUED,
      request: { method: 'GET' as const, url: '/v1/agent/card/intent-card' },
    },
  ];

  it.each(cases)(
    'rejects agent B on agent A $name route',
    async ({ intentId, status, request }) => {
      dbIntents[intentId] = intent(intentId, 'user-a', AGENT_A_ID, status);

      const response = await app.inject({
        ...request,
        headers: { 'x-agent-key': AGENT_B_KEY },
      });

      expect(response.statusCode).toBe(403);
      expect(response.json().code).toBe('agent_intent_forbidden');
    },
  );

  it('attributes successful mutations to the verified agent', async () => {
    dbIntents['intent-own'] = intent('intent-own', 'user-a', AGENT_A_ID, IntentStatus.SEARCHING);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/agent/quote',
      headers: { 'x-agent-key': AGENT_A_KEY },
      payload: {
        intentId: 'intent-own',
        merchantName: 'Merchant',
        merchantUrl: 'https://merchant.example',
        price: 100,
        currency: 'eur',
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockReceiveQuote).toHaveBeenCalledWith('intent-own', expect.any(Object), AGENT_A_ID);
    expect(mockRequestApproval).toHaveBeenCalledWith('intent-own', AGENT_A_ID);
  });
});

describe('credential rotation', () => {
  it('invalidates the old key immediately, preserves identity, and audits the rotation', async () => {
    const rotated = await app.inject({
      method: 'POST',
      url: '/v1/agent/credential/rotate',
      headers: { 'x-agent-key': AGENT_A_KEY },
      payload: {},
    });

    expect(rotated.statusCode).toBe(200);
    const body = rotated.json();
    expect(body.agentId).toBe(AGENT_A_ID);
    expect(body.agentKey).toMatch(/^agk_/);
    expect(body.agentKey).not.toBe(AGENT_A_KEY);
    expect(body.credentialVersion).toBe(2);

    const oldKey = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-agent-key': AGENT_A_KEY },
    });
    expect(oldKey.statusCode).toBe(401);
    expect(oldKey.json().code).toBe('agent_credential_invalid');

    const newKey = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-agent-key': body.agentKey },
    });
    expect(newKey.statusCode).toBe(200);
    expect(newKey.json()).toEqual({ status: 'claimed', userId: 'user-a' });
    expect(dbAuditEvents).toContainEqual(
      expect.objectContaining({
        actor: AGENT_A_ID,
        agentId: AGENT_A_ID,
        event: 'AGENT_CREDENTIAL_ROTATED',
      }),
    );
  });
});
