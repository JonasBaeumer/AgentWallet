/**
 * Integration test: OpenClaw onboarding + first purchase intent
 *
 * Uses real PostgreSQL, real Redis, and real Stripe test mode.
 * Only mocks Telegram outbound API calls (we don't want to push to Telegram during tests).
 *
 * Requires running Postgres + Redis. Skipped if STRIPE_SECRET_KEY is not a sk_test_ key.
 *
 * Run: npm run test:integration -- --testPathPattern=onboarding
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { getRedisClient } from '@/config/redis';

// Mock Telegram outbound calls only — we don't send real Telegram messages during tests
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

// Mock BullMQ producers — we don't need a running Redis worker for this test
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

const WORKER_KEY = process.env.WORKER_API_KEY ?? 'local-dev-worker-key';
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? 'ilovedatadogok';

const hasStripeKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');

let app: FastifyInstance;

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

  // Flush signup sessions from Redis
  const redis = getRedisClient();
  const keys = await redis.keys('telegram_signup:*');
  if (keys.length) await redis.del(...keys);

  jest.clearAllMocks();
});

// ─── Full onboarding + intent creation flow ───────────────────────────────────

const testSuite = hasStripeKey ? describe : describe.skip;

testSuite('OpenClaw onboarding + first purchase intent (real DB + Redis)', () => {
  it('registers agent, signs up user via Telegram, then creates a purchase intent', async () => {
    // Step 1: OpenClaw registers for the first time — gets agentId + pairingCode
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': WORKER_KEY },
      payload: {},
    });
    expect(regRes.statusCode).toBe(200);
    const { agentId, pairingCode, expiresAt } = regRes.json();
    expect(agentId).toMatch(/^ag_/);
    expect(pairingCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(new Date(expiresAt).getTime()).toBeGreaterThan(Date.now());

    // Verify pairing code is persisted in DB
    const dbCode = await prisma.pairingCode.findUnique({ where: { agentId } });
    expect(dbCode).not.toBeNull();
    expect(dbCode!.code).toBe(pairingCode);
    expect(dbCode!.claimedByUserId).toBeNull();

    // Step 2: GET /v1/agent/user — should be unclaimed
    const beforeRes = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': WORKER_KEY, 'x-agent-id': agentId },
    });
    expect(beforeRes.statusCode).toBe(200);
    expect(beforeRes.json().status).toBe('unclaimed');

    // Step 3: User sends /start <pairingCode> via Telegram webhook
    const chatId = 88887777;
    const startRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 1001,
        message: { message_id: 1, chat: { id: chatId }, text: `/start ${pairingCode}` },
      },
    });
    expect(startRes.statusCode).toBe(200);

    // Allow fire-and-forget handler to finish (handler does DB lookups before sending)
    await new Promise((r) => setTimeout(r, 100));

    // Bot should have shown the confirmation keyboard with the agentId
    expect(mockSendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining(agentId),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    // Step 3b: User taps "Confirm" — callback query with link_confirm:<chatId>
    const confirmRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 10015,
        callback_query: {
          id: 'cb-confirm-1',
          data: 'link_confirm:_',
          from: { id: chatId },
          message: { message_id: 1, chat: { id: chatId } },
        },
      },
    });
    expect(confirmRes.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // After confirm, the bot edits the message to show the provider-choice keyboard.
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('payment provider'),
      expect.any(Object),
    );

    // Step 3c: User taps "Stripe (EUR)" — callback query with signup_provider:STRIPE
    const providerRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 10016,
        callback_query: {
          id: 'cb-provider-1',
          data: 'signup_provider:STRIPE',
          from: { id: chatId },
          message: { message_id: 1, chat: { id: chatId } },
        },
      },
    });
    expect(providerRes.statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 100));

    // After provider choice, bot should ask for the email
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('email'),
      expect.any(Object),
    );

    // Step 4: User replies with email address (unique per run to avoid any collision)
    const testEmail = `onboarding-${Date.now()}@example.com`;
    const emailRes = await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 1002,
        message: { message_id: 2, chat: { id: chatId }, text: testEmail },
      },
    });
    expect(emailRes.statusCode).toBe(200);

    // Wait for fire-and-forget DB write + Telegram API call to complete
    await new Promise((r) => setTimeout(r, 300));

    // Bot should have confirmed account creation (message includes API key)
    expect(mockSendMessage).toHaveBeenLastCalledWith(
      chatId,
      expect.stringContaining('Account created'),
      expect.any(Object),
    );

    // Verify user exists in DB with correct fields
    const user = await prisma.user.findUnique({ where: { email: testEmail } });
    expect(user).not.toBeNull();
    expect(user!.agentId).toBe(agentId);
    expect(user!.telegramChatId).toBe(chatId.toString());

    // Verify pairing code is marked as claimed
    const claimedCode = await prisma.pairingCode.findUnique({ where: { agentId } });
    expect(claimedCode!.claimedByUserId).toBe(user!.id);

    // Step 5: OpenClaw polls GET /v1/agent/user — should now be claimed
    const afterRes = await app.inject({
      method: 'GET',
      url: '/v1/agent/user',
      headers: { 'x-worker-key': WORKER_KEY, 'x-agent-id': agentId },
    });
    expect(afterRes.statusCode).toBe(200);
    const { status: claimedStatus, userId } = afterRes.json();
    expect(claimedStatus).toBe('claimed');
    expect(userId).toBe(user!.id);

    // Top up user balance and set API key so intent creation succeeds
    const rawKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = await bcrypt.hash(rawKey, 10);
    await prisma.user.update({
      where: { id: userId },
      data: { mainBalance: 50000, apiKeyHash, apiKeyPrefix: rawKey.slice(0, 16) },
    });

    // Step 6: User creates a purchase intent via authenticated API
    const intentRes = await app.inject({
      method: 'POST',
      url: '/v1/intents',
      headers: {
        'x-idempotency-key': `onboarding-intent-${Date.now()}`,
        authorization: `Bearer ${rawKey}`,
      },
      payload: {
        query: 'Sony WH-1000XM5 headphones',
        subject: 'Buy Sony headphones',
        maxBudget: 30000,
        currency: 'gbp',
      },
    });
    expect(intentRes.statusCode).toBe(201);
    const { intentId, status: intentStatus } = intentRes.json();
    expect(intentStatus).toBe('SEARCHING');

    // Verify intent exists in DB linked to the correct user
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
    expect(intent).not.toBeNull();
    expect(intent!.userId).toBe(userId);
    expect(intent!.status).toBe('SEARCHING');
  });

  it('code renewal: register again with existing agentId to get a fresh code', async () => {
    // Register fresh
    const reg1 = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': WORKER_KEY },
      payload: {},
    });
    const { agentId, pairingCode: firstCode } = reg1.json();

    // Backdate createdAt so the 5-minute per-agentId renewal cooldown is satisfied
    // (simulate that the original code was issued 6 minutes ago)
    await prisma.pairingCode.update({
      where: { agentId },
      data: { createdAt: new Date(Date.now() - 6 * 60 * 1000) },
    });

    // Renew
    const reg2 = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': WORKER_KEY },
      payload: { agentId },
    });
    expect(reg2.statusCode).toBe(200);
    const { agentId: sameAgentId, pairingCode: newCode } = reg2.json();

    expect(sameAgentId).toBe(agentId);
    expect(newCode).toMatch(/^[A-Z0-9]{8}$/);
    expect(newCode).not.toBe(firstCode); // statistically certain with 32^8 space

    // DB should reflect the new code
    const dbCode = await prisma.pairingCode.findUnique({ where: { agentId } });
    expect(dbCode!.code).toBe(newCode);
  });

  it('rejects re-registration after user has claimed the code', async () => {
    // Register
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': WORKER_KEY },
      payload: {},
    });
    const { agentId, pairingCode } = reg.json();

    // Simulate user claiming via Telegram (including the new confirmation step)
    const chatId = 77776666;
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 2001,
        message: { message_id: 1, chat: { id: chatId }, text: `/start ${pairingCode}` },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    // User taps Confirm
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 20015,
        callback_query: {
          id: 'cb-confirm-2',
          data: 'link_confirm:_',
          from: { id: chatId },
          message: { message_id: 1, chat: { id: chatId } },
        },
      },
    });
    await new Promise((r) => setTimeout(r, 200));
    await app.inject({
      method: 'POST',
      url: '/v1/webhooks/telegram',
      headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
      payload: {
        update_id: 2002,
        message: { message_id: 2, chat: { id: chatId }, text: 'claimed@example.com' },
      },
    });
    // Wait for bcrypt.hash + DB transaction to complete (bcrypt cost=10 takes ~200 ms)
    await new Promise((r) => setTimeout(r, 500));

    // Try to renew after claiming — should 409
    const renewRes = await app.inject({
      method: 'POST',
      url: '/v1/agent/register',
      headers: { 'x-worker-key': WORKER_KEY },
      payload: { agentId },
    });
    expect(renewRes.statusCode).toBe(409);
  });
});
