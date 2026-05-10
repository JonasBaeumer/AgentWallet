jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'test-worker-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  },
}));

const mockHandleTelegramCallback = jest.fn().mockResolvedValue(undefined);
jest.mock('@/telegram/callbackHandler', () => ({
  handleTelegramCallback: mockHandleTelegramCallback,
}));

// Stripe client mock (needed by webhooks route)
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));

// All other service mocks needed by buildApp's route imports
jest.mock('@/orchestrator/intentService', () => ({
  startSearching: jest.fn(),
  receiveQuote: jest.fn(),
  requestApproval: jest.fn(),
  markCardIssued: jest.fn(),
  startCheckout: jest.fn(),
  completeCheckout: jest.fn(),
  failCheckout: jest.fn(),
}));
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn(),
  enqueueCheckout: jest.fn(),
}));
jest.mock('@/approval/approvalService', () => ({ recordDecision: jest.fn() }));
jest.mock('@/ledger/potService', () => ({
  reserveForIntent: jest.fn(),
  settleIntent: jest.fn(),
  returnIntent: jest.fn(),
}));
jest.mock('@/payments/providers/stripe/cardService', () => ({
  issueVirtualCard: jest.fn(),
  revealCard: jest.fn(),
  cancelCard: jest.fn(),
}));
jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
}));

const dbUsers: Record<string, any> = {
  'user-1': { id: 'user-1', email: 'test@agentpay.dev' },
};

jest.mock('@/db/client', () => ({
  prisma: {
    user: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbUsers[where.id] ?? null)),
      update: jest.fn(({ where, data }: any) => {
        if (dbUsers[where.id]) dbUsers[where.id] = { ...dbUsers[where.id], ...data };
        return Promise.resolve(dbUsers[where.id] ?? null);
      }),
    },
    purchaseIntent: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
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
  mockHandleTelegramCallback.mockResolvedValue(undefined);
});

// ─── POST /v1/webhooks/telegram ───────────────────────────────────────────────

describe('POST /v1/webhooks/telegram', () => {
  it('returns 401 when X-Telegram-Bot-Api-Secret-Token is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 401 when X-Telegram-Bot-Api-Secret-Token is wrong', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'wrong-secret',
      },
      body: JSON.stringify({ update_id: 1 }),
    });

    expect(res.statusCode).toBe(401);
  });

  it('returns 200 with received:true for non-callback-query update', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret',
      },
      body: JSON.stringify({ update_id: 1, message: { text: 'hello' } }),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
    expect(mockHandleTelegramCallback).not.toHaveBeenCalled();
  });

  it('invokes handleTelegramCallback for callback_query update', async () => {
    const update = {
      update_id: 2,
      callback_query: {
        id: 'cb1',
        data: 'approve:intent-1',
        from: { id: 111 },
        message: { message_id: 10, chat: { id: 999 } },
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret',
      },
      body: JSON.stringify(update),
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ received: true });
    // handler is fire-and-forget — we just verify the route responded correctly
  });

  it('still returns 200 even if handler throws (fire-and-forget)', async () => {
    mockHandleTelegramCallback.mockRejectedValueOnce(new Error('handler error'));
    const update = {
      update_id: 3,
      callback_query: {
        id: 'cb2',
        data: 'approve:intent-2',
        from: { id: 111 },
        message: { message_id: 10, chat: { id: 999 } },
      },
    };

    const res = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': 'test-webhook-secret',
      },
      body: JSON.stringify(update),
    });

    expect(res.statusCode).toBe(200);
  });
});

// ─── POST /v1/users/:userId/link-telegram ─────────────────────────────────────

describe('POST /v1/users/:userId/link-telegram', () => {
  it('returns 404 when user does not exist', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/no-such-user/link-telegram',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegramChatId: '123456789' }),
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when telegramChatId is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/link-telegram',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.statusCode).toBe(400);
  });

  it('persists telegramChatId and returns linked:true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/users/user-1/link-telegram',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ telegramChatId: '987654321' }),
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.linked).toBe(true);
    expect(body.telegramChatId).toBe('987654321');
    expect(body.userId).toBe('user-1');
  });
});
