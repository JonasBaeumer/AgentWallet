/**
 * Interactive live Telegram test — Preferences screen.
 *
 * Walks through the full policy picker UI: preset TTL, Custom TTL (requires
 * a text reply from you), MANUAL, and back to ON_TRANSACTION. Each step sends
 * an instruction message telling you exactly what to do next.
 *
 * How it works (same as menuHandler.live.test.ts):
 *   1. Webhook deleted so Telegram delivers updates via getUpdates.
 *   2. Menu keyboard sent to your chat.
 *   3. Test waits for your taps (and, for Custom TTL, your text reply).
 *   4. Each tap/message is forwarded to the local Fastify app, which calls
 *      the real Telegram Bot API to edit the message in-place.
 *   5. After each save, DB state is verified against the expected policy.
 *
 * Run:
 *   npx jest --config jest.integration.live.js \
 *            --testPathPattern=preferences.live \
 *            --forceExit --testTimeout=120000
 *
 * Requires:
 *   - TELEGRAM_BOT_TOKEN and TELEGRAM_TEST_CHAT_ID in .env
 *   - docker compose up -d  (Postgres + Redis)
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

// ── App + poll state ──────────────────────────────────────────────────────────

let app: FastifyInstance;
let menuMessageId: number;
let updateOffset = 0;

function pause(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Webhook management ────────────────────────────────────────────────────────

let originalWebhookUrl = '';

async function disableWebhook() {
  const info = await tgGet('getWebhookInfo');
  originalWebhookUrl = info.result?.url ?? '';
  await tgPost('deleteWebhook', { drop_pending_updates: false });
}

async function restoreWebhook() {
  if (originalWebhookUrl) {
    await tgPost('setWebhook', { url: originalWebhookUrl });
  }
}

// ── Wait for a button tap ─────────────────────────────────────────────────────
//
// `allowed` entries can be either:
//   - 'action'          — matches any tap with that action prefix
//   - 'action:payload'  — matches only that exact action+payload combination
//
// If the user taps a button that doesn't match, an alert is shown and the
// test keeps waiting — the walkthrough recovers without failing.

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
      allowed_updates: 'callback_query',
    });

    if (!result.ok) {
      // If a webhook was re-registered externally (e.g. a stale process), delete it and retry
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

// ── Wait for a plain text message from the user ───────────────────────────────

async function waitForTextMessage(
  timeoutMs = 90_000,
): Promise<{ text: string; messageId: number }> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = Math.floor((deadline - Date.now()) / 1000);
    const pollSecs = Math.min(remaining, 25);
    if (pollSecs <= 0) break;

    // Poll both message and callback_query updates so we advance the offset
    // correctly even if the user accidentally taps something while we wait.
    const result = await tgGet('getUpdates', {
      offset: updateOffset,
      timeout: pollSecs,
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
      const msg = update.message;
      if (
        msg &&
        msg.chat?.id === TEST_CHAT_ID &&
        typeof msg.text === 'string' &&
        !msg.text.startsWith('/')
      ) {
        return { text: msg.text, messageId: msg.message_id };
      }
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for a text message`);
}

// ── Forward a button tap to the local Fastify app ─────────────────────────────

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
  await pause(400);
}

// ── Forward a plain text message to the local Fastify app ────────────────────

async function forwardMessage(text: string, messageId: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/webhooks/telegram',
    headers: { 'x-telegram-bot-api-secret-token': TELEGRAM_SECRET },
    payload: {
      update_id: Math.floor(Math.random() * 1e9),
      message: {
        message_id: messageId,
        from: { id: TEST_CHAT_ID },
        chat: { id: TEST_CHAT_ID },
        text,
      },
    },
  });
  expect(res.statusCode).toBe(200);
  await pause(400);
}

// ── Send a plain instruction message (returns message_id so it can be deleted) ─

async function instruct(text: string): Promise<number> {
  const result = await tgPost('sendMessage', {
    chat_id: TEST_CHAT_ID,
    text,
    parse_mode: 'HTML',
  });
  return result.result.message_id as number;
}

async function deleteMsg(messageId: number) {
  await tgPost('deleteMessage', { chat_id: TEST_CHAT_ID, message_id: messageId });
}

// ── Keyboard used to open the Preferences screen ─────────────────────────────

const PREFS_ENTRY_KEYBOARD = {
  inline_keyboard: [[{ text: '⚙️ Preferences', callback_data: 'menu_preferences:_' }]],
};

// ── DB setup ──────────────────────────────────────────────────────────────────

let userId: string;

async function buildFixtures() {
  const rawKey = crypto.randomBytes(32).toString('hex');
  const apiKeyHash = await bcrypt.hash(rawKey, 10);
  const user = await prisma.user.create({
    data: {
      email: `live-prefs-${Date.now()}@example.com`,
      telegramChatId: String(TEST_CHAT_ID),
      agentId: 'live-prefs-agent',
      mainBalance: 10000,
      maxBudgetPerIntent: 50000,
      apiKeyHash,
      apiKeyPrefix: rawKey.slice(0, 16),
      // cancelPolicy defaults to ON_TRANSACTION
    },
  });
  userId = user.id;
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
  const signupKeys = await redis.keys('telegram_signup:*');
  const prefKeys = await redis.keys('telegram_pref:*');
  const allKeys = [...signupKeys, ...prefKeys];
  if (allKeys.length) await redis.del(...allKeys);
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

testSuite('Telegram Preferences screen — interactive live walkthrough', () => {
  // ── Step 1: Send the entry keyboard ────────────────────────────────────────

  it('Step 1 — sends a keyboard with the Preferences button', async () => {
    const result = await tgPost('sendMessage', {
      chat_id: TEST_CHAT_ID,
      text: '⚙️ <b>Preferences Walkthrough</b>\n\nDefault policy: <b>On Transaction</b>',
      parse_mode: 'HTML',
      reply_markup: PREFS_ENTRY_KEYBOARD,
    });
    expect(result.ok).toBe(true);
    menuMessageId = result.result.message_id;
    console.log(`\nMenu sent (message_id: ${menuMessageId})`);
  });

  // ── Step 2: Open Preferences — shows policy picker ──────────────────────────

  it('Step 2 — Preferences screen shows policy picker (tap ⚙️ Preferences)', async () => {
    const msg = await instruct('👆 Tap <b>[⚙️ Preferences]</b>.');

    const cb = await waitForCallback(['menu_preferences']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}`);

    await forwardCallback(cb);
    console.log('✓ Policy picker shown');
  });

  // ── Step 3: Tap "After TTL" — shows TTL picker ──────────────────────────────

  it('Step 3 — TTL picker shown when tapping [After TTL]', async () => {
    const msg = await instruct('👆 Tap <b>[After TTL]</b>.');

    const cb = await waitForCallback(['menu_pref_policy:AFTER_TTL']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);
    console.log('✓ TTL picker shown');
  });

  // ── Step 4: Tap "1 hr" — saves AFTER_TTL + 60 min ──────────────────────────

  it('Step 4 — saves AFTER_TTL (60 min) when tapping [1 hr]', async () => {
    const msg = await instruct('👆 Tap <b>[1 hr]</b>.');

    const cb = await waitForCallback(['menu_pref_ttl:60']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);

    await pause(200);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.cancelPolicy).toBe('AFTER_TTL');
    expect(user!.cardTtlMinutes).toBe(60);
    console.log('✓ DB: cancelPolicy=AFTER_TTL, cardTtlMinutes=60');
  });

  // ── Step 5: Back to menu → open Preferences again ───────────────────────────

  it('Step 5 — re-open Preferences shows current policy "After TTL (60 min)"', async () => {
    const msg1 = await instruct('👆 Tap <b>[⬅️ Back to Menu]</b>.');

    const back = await waitForCallback(['menu_main']);
    await deleteMsg(msg1);
    await forwardCallback(back); // message edits to main menu in-place

    const msg2 = await instruct('👆 Tap <b>[⚙️ Preferences]</b>.');

    const cb = await waitForCallback(['menu_preferences']);
    await deleteMsg(msg2);
    await forwardCallback(cb);
    console.log('✓ Preferences re-opened — should show After TTL (60 min)');
  });

  // ── Step 6: Tap "Manual" — saves MANUAL ─────────────────────────────────────

  it('Step 6 — saves MANUAL policy when tapping [Manual]', async () => {
    const msg = await instruct('👆 Tap <b>[Manual]</b>.');

    const cb = await waitForCallback(['menu_pref_policy:MANUAL']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);

    await pause(200);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.cancelPolicy).toBe('MANUAL');
    console.log('✓ DB: cancelPolicy=MANUAL');
  });

  // ── Step 7: Back → re-open Preferences ──────────────────────────────────────

  it('Step 7 — back to menu and re-open Preferences (shows "Manual")', async () => {
    const msg1 = await instruct('👆 Tap <b>[⬅️ Back to Menu]</b>.');

    const back = await waitForCallback(['menu_main']);
    await deleteMsg(msg1);
    await forwardCallback(back); // message edits to main menu in-place

    const msg2 = await instruct('👆 Tap <b>[⚙️ Preferences]</b>.');

    const cb = await waitForCallback(['menu_preferences']);
    await deleteMsg(msg2);
    await forwardCallback(cb);
    console.log('✓ Preferences re-opened — should show Manual');
  });

  it('Step 8 — open TTL picker via [After TTL]', async () => {
    const msg = await instruct('👆 Tap <b>[After TTL]</b>.');

    const cb = await waitForCallback(['menu_pref_policy:AFTER_TTL']);
    await deleteMsg(msg);
    await forwardCallback(cb);
    console.log('✓ TTL picker shown');
  });

  it('Step 9 — tap [Custom] — bot shows ForceReply prompt', async () => {
    const msg = await instruct('👆 Tap <b>[Custom]</b>.');

    const cb = await waitForCallback(['menu_pref_ttl:custom']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);
    console.log('✓ Custom TTL prompt shown');
  });

  it('Step 10 — user replies with "90" — saves AFTER_TTL (90 min)', async () => {
    const msg = await instruct(
      "👆 <b>Reply to the bot's message</b> with the number of minutes (e.g. 90).",
    );

    const { text, messageId } = await waitForTextMessage();
    await deleteMsg(msg);
    console.log(`\nReceived text message: "${text}"`);
    expect(text.trim()).toBe('90');

    await forwardMessage(text, messageId);

    await pause(200);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.cancelPolicy).toBe('AFTER_TTL');
    expect(user!.cardTtlMinutes).toBe(90);
    console.log('✓ DB: cancelPolicy=AFTER_TTL, cardTtlMinutes=90');
  });

  // ── Step 11: Re-open Preferences → verify 90 min shown ──────────────────────
  // After the custom TTL flow the confirmation is a plain text message with no
  // inline keyboard, so we need to send a fresh one to get back into the menu.

  it('Step 11 — re-open Preferences shows "After TTL (90 min)"', async () => {
    const keyboardResult = await tgPost('sendMessage', {
      chat_id: TEST_CHAT_ID,
      text: '⚙️ <b>Preferences Walkthrough</b>',
      parse_mode: 'HTML',
      reply_markup: PREFS_ENTRY_KEYBOARD,
    });
    expect(keyboardResult.ok).toBe(true);
    menuMessageId = keyboardResult.result.message_id;

    const msg = await instruct('👆 Tap <b>[⚙️ Preferences]</b>.');

    const cb = await waitForCallback(['menu_preferences']);
    await deleteMsg(msg);
    await forwardCallback(cb); // edits the ⚙️ message to policy picker in-place
    console.log('✓ Preferences shows After TTL (90 min)');
  });

  // ── Step 12: Restore default — tap "On Transaction" ─────────────────────────

  it('Step 12 — tap [On Transaction] — restores default policy', async () => {
    const msg = await instruct('👆 Tap <b>[On Transaction]</b>.');

    const cb = await waitForCallback(['menu_pref_policy:ON_TRANSACTION']);
    await deleteMsg(msg);
    console.log(`\nReceived tap: ${cb.action}:${cb.payload}`);

    await forwardCallback(cb);

    await pause(200);
    const user = await prisma.user.findUnique({ where: { id: userId } });
    expect(user!.cancelPolicy).toBe('ON_TRANSACTION');
    console.log('✓ DB: cancelPolicy=ON_TRANSACTION (default restored)');

    await tgPost('sendMessage', {
      chat_id: TEST_CHAT_ID,
      text: '✅ <b>All Preferences steps verified!</b> Policy picker walkthrough complete.',
      parse_mode: 'HTML',
    });
    console.log('\n✓ All 12 steps complete — Preferences walkthrough finished.');
  });
});
