/**
 * Integration tests: Telegram /menu command and menu callbacks
 *
 * Uses real PostgreSQL and the full Fastify app. Telegram outbound API calls
 * and BullMQ producers are mocked so no external services are required beyond
 * a running Postgres + Redis instance.
 *
 * Run: npm run test:integration -- --testPathPattern=telegram/menuHandler
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { getRedisClient } from '@/config/redis';

// Mock Telegram outbound calls — we never send real Telegram messages in tests
const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 1 });
const mockAnswerCallbackQuery = jest.fn().mockResolvedValue(undefined);
const mockEditMessageText = jest.fn().mockResolvedValue(undefined);
jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: () => ({
    api: {
      sendMessage: mockSendMessage,
      answerCallbackQuery: mockAnswerCallbackQuery,
      editMessageText: mockEditMessageText,
    },
  }),
}));

// Mock BullMQ producers — no real worker needed
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? 'ilovedatadogok';
const hasStripeKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');

const TEST_CHAT_ID = 55551234;
const TEST_MSG_ID = 42;

let app: FastifyInstance;

// ── DB helpers ────────────────────────────────────────────────────────────────

async function createTestUser(overrides: Partial<{
  agentId: string | null;
  mainBalance: number;
}> = {}) {
  return prisma.user.create({
    data: {
      email: `menu-test-${Date.now()}@example.com`,
      telegramChatId: String(TEST_CHAT_ID),
      agentId: overrides.agentId !== undefined ? overrides.agentId : 'agent-menu-test',
      mainBalance: overrides.mainBalance ?? 12500,
      maxBudgetPerIntent: 50000,
      apiKeyHash: 'irrelevant',
      apiKeyPrefix: 'irrelevant',
    },
  });
}

async function createIntent(userId: string, opts: { status?: string; budget?: number; subject?: string } = {}) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      query: opts.subject ?? 'test item',
      subject: opts.subject ?? 'test item',
      maxBudget: opts.budget ?? 5000,
      currency: 'gbp',
      status: (opts.status ?? 'SEARCHING') as any,
      metadata: {},
      idempotencyKey: `idem-${Date.now()}-${Math.random()}`,
    },
  });
}

async function createPot(userId: string, intentId: string, reservedAmount: number) {
  return prisma.pot.create({
    data: { userId, intentId, reservedAmount, status: 'ACTIVE' },
  });
}

// ── Webhook injection helpers ─────────────────────────────────────────────────

async function sendMenuCommand() {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1e9),
      message: { message_id: TEST_MSG_ID, chat: { id: TEST_CHAT_ID }, text: '/menu' },
    },
  });
  expect(res.statusCode).toBe(200);
  // Allow fire-and-forget handler to complete
  await new Promise((r) => setTimeout(r, 100));
}

async function sendMenuCallback(action: string, payload: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: `cb-${Date.now()}`,
        data: `${action}:${payload}`,
        from: { id: TEST_CHAT_ID },
        message: { message_id: TEST_MSG_ID, chat: { id: TEST_CHAT_ID } },
      },
    },
  });
  expect(res.statusCode).toBe(200);
  await new Promise((r) => setTimeout(r, 100));
}

// ── Test suite ────────────────────────────────────────────────────────────────

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
  getRedisClient().disconnect();
});

beforeEach(async () => {
  await prisma.auditEvent.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.pot.deleteMany();
  await prisma.virtualCard.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.purchaseIntent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.pairingCode.deleteMany();
  await prisma.user.deleteMany();
  jest.clearAllMocks();
});

const testSuite = hasStripeKey ? describe : describe.skip;

testSuite('Telegram /menu integration (real DB)', () => {
  // ── /menu command ───────────────────────────────────────────────────────────

  describe('/menu command', () => {
    it('sends main menu keyboard when user is found', async () => {
      await createTestUser();
      await sendMenuCommand();

      expect(mockSendMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        expect.any(String),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );

      const keyboard = mockSendMessage.mock.calls[0][2].reply_markup;
      const allButtons = keyboard.inline_keyboard.flat();
      expect(allButtons.length).toBeGreaterThanOrEqual(5);

      // All expected menu actions are present
      const actions = allButtons.map((b: any) => b.callback_data);
      expect(actions).toContain('menu_balance:_');
      expect(actions).toContain('menu_history:_');
      expect(actions).toContain('menu_cancel_list:_');
      expect(actions).toContain('menu_agent:_');
      expect(actions).toContain('menu_preferences:_');
    });

    it('sends signup prompt when user is not found', async () => {
      // No user in DB — chatId is not linked
      await sendMenuCommand();

      expect(mockSendMessage).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        expect.stringContaining('sign up'),
        expect.anything(),
      );
    });
  });

  // ── menu_balance ────────────────────────────────────────────────────────────

  describe('menu_balance callback', () => {
    it('shows main balance, reserved amount and available balance', async () => {
      const user = await createTestUser({ mainBalance: 12500 }); // £125.00
      const intent = await createIntent(user.id);
      await createPot(user.id, intent.id, 2500); // £25.00 reserved

      await sendMenuCallback('menu_balance', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('£125.00'); // main balance
      expect(text).toContain('£25.00');  // reserved
      expect(text).toContain('£100.00'); // available
    });

    it('shows £0.00 reserved when no active pots', async () => {
      await createTestUser({ mainBalance: 5000 });

      await sendMenuCallback('menu_balance', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('Reserved:     £0.00');
    });
  });

  // ── menu_history ────────────────────────────────────────────────────────────

  describe('menu_history callback', () => {
    it('lists DONE intents with their settled amounts', async () => {
      const user = await createTestUser();
      const intent = await createIntent(user.id, { status: 'DONE', subject: 'headphones', budget: 4500 });
      await createPot(user.id, intent.id, 4500);
      // Mark pot as settled
      await prisma.pot.update({
        where: { intentId: intent.id },
        data: { status: 'SETTLED', settledAmount: 4500 },
      });

      await sendMenuCallback('menu_history', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('headphones');
      expect(text).toContain('£45.00');
    });

    it('shows empty state when no DONE intents', async () => {
      await createTestUser();

      await sendMenuCallback('menu_history', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('no purchases');
    });
  });

  // ── menu_cancel_list ────────────────────────────────────────────────────────

  describe('menu_cancel_list callback', () => {
    it('renders one cancel button per active intent', async () => {
      const user = await createTestUser();
      const i1 = await createIntent(user.id, { status: 'SEARCHING', subject: 'headphones', budget: 5000 });
      const i2 = await createIntent(user.id, { status: 'AWAITING_APPROVAL', subject: 'coffee maker', budget: 8900 });

      await sendMenuCallback('menu_cancel_list', '_');

      const [, , , opts] = mockEditMessageText.mock.calls[0];
      const buttons = opts.reply_markup.inline_keyboard.flat();
      const cancelButtons = buttons.filter((b: any) =>
        b.callback_data?.startsWith('menu_cancel_confirm:'),
      );
      expect(cancelButtons).toHaveLength(2);
      const payloads = cancelButtons.map((b: any) => b.callback_data.split(':')[1]);
      expect(payloads).toContain(i1.id);
      expect(payloads).toContain(i2.id);
    });

    it('shows empty state when no active intents', async () => {
      const user = await createTestUser();
      // Only DONE intents
      await createIntent(user.id, { status: 'DONE' });

      await sendMenuCallback('menu_cancel_list', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('no active intents');
    });
  });

  // ── menu_cancel_confirm ─────────────────────────────────────────────────────

  describe('menu_cancel_confirm callback', () => {
    it('shows intent label, budget and confirm/back buttons', async () => {
      const user = await createTestUser();
      const intent = await createIntent(user.id, { status: 'SEARCHING', subject: 'headphones', budget: 5000 });

      await sendMenuCallback('menu_cancel_confirm', intent.id);

      const [, , text, opts] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('headphones');
      expect(text).toContain('£50.00');

      const buttons = opts.reply_markup.inline_keyboard.flat();
      expect(buttons.some((b: any) => b.callback_data === `menu_cancel_do:${intent.id}`)).toBe(true);
      expect(buttons.some((b: any) => b.callback_data === 'menu_cancel_list:_')).toBe(true);
    });
  });

  // ── menu_cancel_do ──────────────────────────────────────────────────────────

  describe('menu_cancel_do callback', () => {
    it('transitions the intent to EXPIRED and confirms in the message', async () => {
      const user = await createTestUser();
      const intent = await createIntent(user.id, { status: 'SEARCHING' });

      await sendMenuCallback('menu_cancel_do', intent.id);

      // DB should reflect the cancellation
      const updated = await prisma.purchaseIntent.findUnique({ where: { id: intent.id } });
      expect(updated!.status).toBe('EXPIRED');

      // Bot should confirm
      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('cancelled');
    });

    it('returns reserved funds to user balance when a pot exists', async () => {
      // Simulate the state after reserveForIntent: balance already decremented by the pot amount
      const user = await createTestUser({ mainBalance: 7000 }); // 10000 - 3000 already reserved
      // Put intent in APPROVED state (has a pot but no Stripe card)
      const intent = await createIntent(user.id, { status: 'APPROVED', budget: 3000 });
      await createPot(user.id, intent.id, 3000);

      await sendMenuCallback('menu_cancel_do', intent.id);

      await new Promise((r) => setTimeout(r, 200)); // allow pot return to settle

      const updatedUser = await prisma.user.findUnique({ where: { id: user.id } });
      // mainBalance should be restored: 7000 + 3000 = 10000
      expect(updatedUser!.mainBalance).toBe(10000);
    });

    it('shows error message when intent does not exist', async () => {
      await createTestUser();

      await sendMenuCallback('menu_cancel_do', 'nonexistent-intent-id');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('went wrong');
    });
  });

  // ── menu_agent ──────────────────────────────────────────────────────────────

  describe('menu_agent callback', () => {
    it('shows linked agentId', async () => {
      await createTestUser({ agentId: 'agent-xyz123' });

      await sendMenuCallback('menu_agent', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('agent-xyz123');
    });

    it('shows /start prompt when no agent is linked', async () => {
      await createTestUser({ agentId: null });

      await sendMenuCallback('menu_agent', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('/start');
    });
  });

  // ── menu_preferences ────────────────────────────────────────────────────────

  describe('menu_preferences callback', () => {
    it('shows current policy and policy picker buttons', async () => {
      await createTestUser();

      await sendMenuCallback('menu_preferences', '_');

      const [, , text, opts] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('cancel policy');

      const buttons = opts.reply_markup.inline_keyboard.flat();
      const actions = buttons.map((b: any) => b.callback_data);
      expect(actions).toContain('menu_pref_policy:ON_TRANSACTION');
      expect(actions).toContain('menu_pref_policy:IMMEDIATE');
      expect(actions).toContain('menu_pref_policy:AFTER_TTL');
      expect(actions).toContain('menu_pref_policy:MANUAL');
    });
  });

  // ── menu_main ───────────────────────────────────────────────────────────────

  describe('menu_main callback', () => {
    it('edits the message back to main menu with full keyboard', async () => {
      await createTestUser();

      await sendMenuCallback('menu_main', '_');

      expect(mockEditMessageText).toHaveBeenCalledWith(
        TEST_CHAT_ID,
        TEST_MSG_ID,
        expect.any(String),
        expect.objectContaining({ reply_markup: expect.anything() }),
      );

      const keyboard = mockEditMessageText.mock.calls[0][3].reply_markup;
      const allButtons = keyboard.inline_keyboard.flat();
      expect(allButtons.length).toBeGreaterThanOrEqual(5);

      const actions = allButtons.map((b: any) => b.callback_data);
      expect(actions).toContain('menu_balance:_');
      expect(actions).toContain('menu_history:_');
      expect(actions).toContain('menu_cancel_list:_');
      expect(actions).toContain('menu_agent:_');
      expect(actions).toContain('menu_preferences:_');
    });
  });

  // ── unknown menu_ action ────────────────────────────────────────────────────

  describe('unknown menu_ callback', () => {
    it('resolves without error (user found, action silently ignored)', async () => {
      await createTestUser();

      // Should not throw — webhook always returns 200
      await sendMenuCallback('menu_nonexistent', '_');
      // No crash = pass
    });
  });

  // ── unauthenticated user for user-dependent actions ─────────────────────────

  describe('user-dependent callbacks when user not found', () => {
    it('menu_balance shows signup prompt when no user in DB', async () => {
      // No user created
      await sendMenuCallback('menu_balance', '_');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('sign up');
    });
  });

  // ── menu_pref_policy (integration) ──────────────────────────────────────────

  describe('menu_pref_policy callback', () => {
    it('saves IMMEDIATE policy to DB', async () => {
      const user = await createTestUser();

      await sendMenuCallback('menu_pref_policy', 'IMMEDIATE');

      const updated = await prisma.user.findUnique({ where: { id: user.id } });
      expect(updated!.cancelPolicy).toBe('IMMEDIATE');

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text.toLowerCase()).toContain('saved');
    });

    it('shows TTL picker when AFTER_TTL is tapped', async () => {
      await createTestUser();

      await sendMenuCallback('menu_pref_policy', 'AFTER_TTL');

      const [, , , opts] = mockEditMessageText.mock.calls[0];
      const buttons = opts.reply_markup.inline_keyboard.flat();
      const actions = buttons.map((b: any) => b.callback_data);
      expect(actions).toContain('menu_pref_ttl:30');
      expect(actions).toContain('menu_pref_ttl:custom');
    });
  });

  // ── menu_pref_ttl (integration) ─────────────────────────────────────────────

  describe('menu_pref_ttl callback', () => {
    it('saves AFTER_TTL with preset TTL to DB', async () => {
      const user = await createTestUser();

      await sendMenuCallback('menu_pref_ttl', '240');

      const updated = await prisma.user.findUnique({ where: { id: user.id } });
      expect(updated!.cancelPolicy).toBe('AFTER_TTL');
      expect(updated!.cardTtlMinutes).toBe(240);

      const [, , text] = mockEditMessageText.mock.calls[0];
      expect(text).toContain('240 min');
    });
  });

  // ── PATCH /v1/users/:userId/preferences ─────────────────────────────────────

  describe('PATCH /v1/users/:userId/preferences', () => {
    let rawKey: string;
    let authHeader: string;
    let authedUserId: string;

    beforeEach(async () => {
      rawKey = crypto.randomBytes(32).toString('hex');
      const hash = await bcrypt.hash(rawKey, 10);
      const prefix = rawKey.slice(0, 16);
      const user = await prisma.user.create({
        data: {
          email: `pref-test-${Date.now()}@example.com`,
          telegramChatId: String(TEST_CHAT_ID + 1),
          agentId: null,
          mainBalance: 10000,
          maxBudgetPerIntent: 50000,
          apiKeyHash: hash,
          apiKeyPrefix: prefix,
        },
      });
      authedUserId = user.id;
      authHeader = `Bearer ${rawKey}`;
    });

    it('updates cancelPolicy and returns the new values', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: authHeader },
        payload: { cancelPolicy: 'MANUAL' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cancelPolicy).toBe('MANUAL');

      const updated = await prisma.user.findUnique({ where: { id: authedUserId } });
      expect(updated!.cancelPolicy).toBe('MANUAL');
    });

    it('writes an audit event on successful update', async () => {
      await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: authHeader },
        payload: { cancelPolicy: 'IMMEDIATE' },
      });

      const audit = await prisma.auditEvent.findFirst({ where: { actor: authedUserId, event: 'PREFERENCES_UPDATED' } });
      expect(audit).not.toBeNull();
    });

    it('updates AFTER_TTL policy with cardTtlMinutes', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: authHeader },
        payload: { cancelPolicy: 'AFTER_TTL', cardTtlMinutes: 120 },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.cancelPolicy).toBe('AFTER_TTL');
      expect(body.cardTtlMinutes).toBe(120);
    });

    it('returns 400 when cardTtlMinutes is set without AFTER_TTL policy', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: authHeader },
        payload: { cancelPolicy: 'IMMEDIATE', cardTtlMinutes: 60 },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 for unknown cancelPolicy', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: authHeader },
        payload: { cancelPolicy: 'INVALID_POLICY' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 401 when no auth header provided', async () => {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        payload: { cancelPolicy: 'IMMEDIATE' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('returns 403 when authed as a different user', async () => {
      const otherRawKey = crypto.randomBytes(32).toString('hex');
      const otherHash = await bcrypt.hash(otherRawKey, 10);
      const otherPrefix = otherRawKey.slice(0, 16);
      await prisma.user.create({
        data: {
          email: `other-${Date.now()}@example.com`,
          telegramChatId: String(TEST_CHAT_ID + 2),
          agentId: null,
          mainBalance: 10000,
          maxBudgetPerIntent: 50000,
          apiKeyHash: otherHash,
          apiKeyPrefix: otherPrefix,
        },
      });

      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/users/${authedUserId}/preferences`,
        headers: { authorization: `Bearer ${otherRawKey}` },
        payload: { cancelPolicy: 'IMMEDIATE' },
      });

      expect(res.statusCode).toBe(403);
    });
  });
});
