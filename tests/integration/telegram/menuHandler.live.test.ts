/**
 * Interactive live Telegram test — /menu command.
 *
 * Sends the real inline keyboard to TELEGRAM_TEST_CHAT_ID, then waits for you
 * to actually tap each button before advancing. Each step sends an instruction
 * message telling you exactly which button to press next.
 *
 * How it works:
 *   1. The test deletes the webhook so Telegram delivers updates to getUpdates.
 *   2. Each step sends the menu (or an instruction) directly to your chat.
 *   3. The test polls getUpdates, waiting for your tap.
 *   4. When a tap arrives it is forwarded to the local Fastify app, which
 *      calls the real Telegram Bot API to edit the message in-place.
 *   5. The next instruction appears and the loop continues.
 *
 * Run:
 *   npx jest --config jest.integration.live.js \
 *            --testPathPattern=menuHandler.live \
 *            --forceExit --testTimeout=120000
 *
 * Requires:
 *   - TELEGRAM_BOT_TOKEN and TELEGRAM_TEST_CHAT_ID in .env
 *   - docker compose up -d  (Postgres + Redis)
 *
 * Note: the webhook is deleted at the start and restored at the end
 * (to the URL stored in getWebhookInfo before the test runs).
 */

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { getRedisClient } from '@/config/redis';

// BullMQ producers mocked — no worker needed
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
  enqueueCancelCard: jest.fn().mockResolvedValue(undefined),
}));

import { buildApp } from '@/app';
import type { FastifyInstance } from 'fastify';

// ── Environment ───────────────────────────────────────────────────────────────

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID
  ? parseInt(process.env.TELEGRAM_TEST_CHAT_ID, 10)
  : null;
const TELEGRAM_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? 'ilovedatadogok';
const BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
const isMockEnv = process.env.TELEGRAM_MOCK === 'true';

const canRun = !!TELEGRAM_TOKEN && !!TEST_CHAT_ID && !isMockEnv;
const testSuite = canRun ? describe : describe.skip;

// ── Low-level Telegram API helpers ────────────────────────────────────────────

async function tgGet(method: string, params: Record<string, unknown> = {}) {
  const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
  const url = qs ? `${BASE}/${method}?${qs}` : `${BASE}/${method}`;
  const res = await fetch(url);
  return res.json() as Promise<any>;
}

async function tgPost(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return res.json() as Promise<any>;
}

// ── Main menu keyboard (matches buildMainMenuKeyboard in menuHandler.ts) ──────

const MAIN_MENU_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '💰 Balance', callback_data: 'menu_balance:_' },
      { text: '📋 History', callback_data: 'menu_history:_' },
    ],
    [
      { text: '🚫 Cancel Intent', callback_data: 'menu_cancel_list:_' },
      { text: '🔗 Agent Status', callback_data: 'menu_agent:_' },
    ],
    [{ text: '⚙️ Preferences', callback_data: 'menu_preferences:_' }],
  ],
};

// ── App + poll state ──────────────────────────────────────────────────────────

let app: FastifyInstance;
let menuMessageId: number; // message_id of the live menu message in the chat
let updateOffset = 0; // rolling getUpdates offset to avoid re-processing

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Webhook management ────────────────────────────────────────────────────────

let originalWebhookUrl = '';

async function disableWebhook() {
  const info = await tgGet('getWebhookInfo');
  originalWebhookUrl = info.result?.url ?? '';
  const delResult = await tgPost('deleteWebhook', { drop_pending_updates: false });
  if (!delResult.ok) {
    throw new Error(`deleteWebhook failed: ${delResult.description}`);
  }
  // Verify webhook is actually gone — getUpdates must work
  const verify = await tgGet('getWebhookInfo');
  if (verify.result?.url) {
    throw new Error(`Webhook still active after deletion: ${verify.result.url}`);
  }
}

async function restoreWebhook() {
  if (originalWebhookUrl) {
    await tgPost('setWebhook', { url: originalWebhookUrl });
  }
}

// ── User input: wait for a real button tap ────────────────────────────────────

async function waitForCallback(
  allowed: string[],
  timeoutMs = 90_000,
): Promise<{ action: string; payload: string; messageId: number; callbackId: string }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.floor((deadline - Date.now()) / 1000);
    const pollSecs = Math.min(remaining, 25);
    if (pollSecs <= 0) break;

    const result = await tgGet('getUpdates', {
      offset: updateOffset,
      timeout: pollSecs,
      allowed_updates: JSON.stringify(['callback_query']),
    });

    if (!result.ok) {
      if (typeof result.description === 'string' && result.description.includes('webhook')) {
        console.warn('Webhook conflict detected — re-deleting webhook and retrying...');
        await tgPost('deleteWebhook', { drop_pending_updates: false });
        continue;
      }
      throw new Error(`getUpdates error: ${result.description}`);
    }

    for (const update of result.result ?? []) {
      updateOffset = update.update_id + 1;
      const cb = update.callback_query;
      // Filter by chat.id (not from.id) — in a group chat, from.id is the
      // tapping user's personal ID, while chat.id is the group ID we expect.
      if (!cb || cb.message?.chat?.id !== TEST_CHAT_ID) continue;

      const colonIdx = (cb.data ?? '').indexOf(':');
      const action = cb.data.slice(0, colonIdx);
      const payload = cb.data.slice(colonIdx + 1);

      const matches = allowed.some((a) => (a.includes(':') ? cb.data === a : action === a));

      if (matches) {
        // Answer immediately to dismiss the loading spinner — don't rely on the
        // fire-and-forget app handler which may be too slow or fail silently.
        await tgPost('answerCallbackQuery', { callback_query_id: cb.id });
        return {
          action,
          payload,
          messageId: cb.message?.message_id ?? menuMessageId,
          callbackId: cb.id,
        };
      }

      // Wrong button — alert user and keep waiting. The instruction message
      // sent just before is the most recent message in the chat (i.e. shown
      // BELOW the keyboard), so point there instead of leaking internal
      // callback_data identifiers.
      await tgPost('answerCallbackQuery', {
        callback_query_id: cb.id,
        text: '⚠️ Please tap the button named in the instruction below 👇',
        show_alert: true,
      });
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${allowed.join(', ')}`);
}

// ── Forward a received tap to the local Fastify app ───────────────────────────

async function forwardCallback(cb: {
  action: string;
  payload: string;
  messageId: number;
  callbackId: string;
}) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: cb.callbackId,
        data: `${cb.action}:${cb.payload}`,
        from: { id: TEST_CHAT_ID },
        message: { message_id: cb.messageId, chat: { id: TEST_CHAT_ID } },
      },
    },
  });
  expect(res.statusCode).toBe(200);
  await pause(400); // allow editMessageText to reach Telegram
}

// ── Helpers to send plain instruction messages ────────────────────────────────

async function instruct(text: string) {
  await tgPost('sendMessage', {
    chat_id: TEST_CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
}

// ── DB setup ──────────────────────────────────────────────────────────────────

let userId: string;
let _cancelIntentId: string;

async function buildFixtures() {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(rawKey, 10);
  const user = await prisma.user.create({
    data: {
      email: `live-menu-${Date.now()}@example.com`,
      telegramChatId: String(TEST_CHAT_ID),
      agentId: 'live-agent-001',
      mainBalance: 35000, // £350.00 total
      maxBudgetPerIntent: 50000,
      apiKeyHash,
      apiKeyPrefix: rawKey.slice(0, 16),
    },
  });
  userId = user.id;

  // History: one DONE intent
  const doneIntent = await prisma.purchaseIntent.create({
    data: {
      userId,
      query: 'Sony headphones',
      subject: 'Sony headphones',
      maxBudget: 4500,
      currency: 'gbp',
      status: 'DONE',
      metadata: {},
      idempotencyKey: `live-done-${Date.now()}`,
    },
  });
  await prisma.pot.create({
    data: {
      userId,
      intentId: doneIntent.id,
      reservedAmount: 4500,
      settledAmount: 4000,
      status: 'SETTLED',
    },
  });

  // Cancel list: one active intent with a pot (balance already decremented)
  const activeIntent = await prisma.purchaseIntent.create({
    data: {
      userId,
      query: 'Coffee maker',
      subject: 'Coffee maker',
      maxBudget: 8900,
      currency: 'gbp',
      status: 'SEARCHING',
      metadata: {},
      idempotencyKey: `live-active-${Date.now()}`,
    },
  });
  _cancelIntentId = activeIntent.id;

  // Balance: reserve £50 from the £350
  await prisma.user.update({ where: { id: userId }, data: { mainBalance: 30000 } });
  await prisma.pot.create({
    data: { userId, intentId: activeIntent.id, reservedAmount: 5000, status: 'ACTIVE' },
  });
}

async function cleanDb() {
  await prisma.auditEvent.deleteMany();
  await prisma.ledgerEntry.deleteMany();
  await prisma.pot.deleteMany();
  await prisma.virtualCard.deleteMany();
  await prisma.approvalDecision.deleteMany();
  await prisma.purchaseIntent.deleteMany();
  await prisma.idempotencyRecord.deleteMany();
  await prisma.pairingCode.deleteMany();
  await prisma.user.deleteMany();
  const redis = getRedisClient();
  const keys = await redis.keys('telegram_signup:*');
  if (keys.length) await redis.del(...keys);
}

// ── Suite ─────────────────────────────────────────────────────────────────────

jest.setTimeout(120_000);

beforeAll(async () => {
  if (!canRun) return;
  app = buildApp();
  await app.ready();
  await cleanDb();
  await buildFixtures();
  await disableWebhook();
  // Drain any stale pending updates before we start
  const drain = await tgGet('getUpdates', { timeout: 1, offset: 0 });
  if (drain.ok && drain.result.length > 0) {
    updateOffset = drain.result[drain.result.length - 1].update_id + 1;
  }
});

afterAll(async () => {
  if (!canRun) return;
  await cleanDb();
  await restoreWebhook();
  await app.close();
  await prisma.$disconnect();
  getRedisClient().disconnect();
});

// ── Interactive steps ─────────────────────────────────────────────────────────

testSuite('Telegram /menu — interactive live walkthrough', () => {
  // ── Step 1: Send the main menu ──────────────────────────────────────────────

  it('Step 1 — sends the main menu keyboard', async () => {
    const result = await tgPost('sendMessage', {
      chat_id: TEST_CHAT_ID,
      text: '📱 <b>Main Menu</b>',
      parse_mode: 'HTML',
      reply_markup: MAIN_MENU_KEYBOARD,
    });
    expect(result.ok).toBe(true);
    menuMessageId = result.result.message_id;
    console.log(`\nMenu sent (message_id: ${menuMessageId})`);
  });

  // ── Step 2: Balance screen ──────────────────────────────────────────────────

  it('Step 2 — Balance screen (tap 💰 Balance)', async () => {
    await instruct('👆 Tap <b>[💰 Balance]</b> in the menu above.');

    const cb = await waitForCallback(['menu_balance']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log('✓ Balance screen shown (main menu message edited in-place)');
  });

  // ── Step 3: Back to main ────────────────────────────────────────────────────

  it('Step 3 — Back to main menu (tap ⬅️ Back)', async () => {
    await instruct('👆 Tap <b>[⬅️ Back]</b> to return to the main menu.');

    const cb = await waitForCallback(['menu_main']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log('✓ Main menu restored');
  });

  // ── Step 4: History screen ──────────────────────────────────────────────────

  it('Step 4 — History screen (tap 📋 History)', async () => {
    await instruct('👆 Tap <b>[📋 History]</b> in the main menu.');

    const cb = await waitForCallback(['menu_history']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log('✓ History screen shown — expect: • Sony headphones — £40.00');
  });

  // ── Step 5: Back → Cancel list ──────────────────────────────────────────────

  it('Step 5 — Cancel Intent list (tap ⬅️ Back, then 🚫 Cancel Intent)', async () => {
    await instruct('👆 Tap <b>[⬅️ Back]</b>, then tap <b>[🚫 Cancel Intent]</b>.');

    const back = await waitForCallback(['menu_main']);
    await forwardCallback(back);

    await instruct('👆 Now tap <b>[🚫 Cancel Intent]</b>.');

    const list = await waitForCallback(['menu_cancel_list']);
    console.log(`\nReceived tap: ${list.action}`);

    await forwardCallback(list);
    console.log('✓ Cancel list shown — expect one button: [SEARCHING: Coffee maker  £89.00]');
  });

  // ── Step 6: Cancel confirm ──────────────────────────────────────────────────

  it('Step 6 — Cancel confirm screen (tap the Coffee maker intent button)', async () => {
    await instruct('👆 Tap <b>[SEARCHING: Coffee maker £89.00]</b> to see the confirm screen.');

    const cb = await waitForCallback(['menu_cancel_confirm']);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);
    _cancelIntentId = cb.payload; // capture the real intentId

    await forwardCallback(cb);
    console.log('✓ Confirm screen shown — expect [✅ Yes, cancel] and [⬅️ Back to list]');
  });

  // ── Step 7: Confirm cancellation ────────────────────────────────────────────

  it('Step 7 — Confirm cancel (tap ✅ Yes, cancel)', async () => {
    await instruct('👆 Tap <b>[✅ Yes, cancel]</b> to confirm cancellation.');

    const cb = await waitForCallback(['menu_cancel_do']);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);

    // Verify the intent is now EXPIRED in the DB
    await pause(300);
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: cb.payload } });
    expect(intent!.status).toBe('EXPIRED');
    console.log(`✓ Intent ${cb.payload} → EXPIRED in DB`);
    console.log('✓ Confirmation message shown');
  });

  // ── Step 8: Agent status ────────────────────────────────────────────────────

  it('Step 8 — Agent Status screen (tap ⬅️ Back, then 🔗 Agent Status)', async () => {
    await instruct('👆 Tap <b>[⬅️ Back]</b>, then tap <b>[🔗 Agent Status]</b>.');

    const back = await waitForCallback(['menu_main']);
    await forwardCallback(back);

    await instruct('👆 Now tap <b>[🔗 Agent Status]</b>.');

    const cb = await waitForCallback(['menu_agent']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log('✓ Agent status shown — expect: Linked: live-agent-001');
  });

  // ── Step 9: Preferences screen ──────────────────────────────────────────────

  it('Step 9 — Preferences screen (tap ⬅️ Back, then ⚙️ Preferences)', async () => {
    await instruct('👆 Tap <b>[⬅️ Back]</b>, then tap <b>[⚙️ Preferences]</b>.');

    const back = await waitForCallback(['menu_main']);
    await forwardCallback(back);

    await instruct('👆 Now tap <b>[⚙️ Preferences]</b>.');

    const cb = await waitForCallback(['menu_preferences']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log(
      '✓ Preferences shown — expect: policy picker with On Transaction / Immediate / After TTL / Manual buttons',
    );
  });

  // ── Step 10: Return to main ──────────────────────────────────────────────────

  it('Step 10 — Back to main menu (tap ⬅️ Back)', async () => {
    await instruct('👆 Tap <b>[⬅️ Back]</b> to return to the main menu — this is the last step.');

    const cb = await waitForCallback(['menu_main']);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);

    await tgPost('sendMessage', {
      chat_id: TEST_CHAT_ID,
      text: '✅ <b>All menu screens verified!</b> Interactive walkthrough complete.',
      parse_mode: 'HTML',
    });
    console.log('\n✓ All 10 steps complete — interactive walkthrough finished.');
  });
});
