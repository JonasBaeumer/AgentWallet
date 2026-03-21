/**
 * Telegram Bot API infrastructure smoke test
 *
 * Verifies each individual Telegram infrastructure step in isolation so that
 * when complex integration tests fail, the specific broken component is
 * immediately identifiable:
 *
 *   Step 1 — Bot token authentication (getMe)
 *   Step 2 — Webhook registration status (getWebhookInfo)
 *   Step 3 — Message delivery (sendMessage)
 *
 * Uses direct fetch to https://api.telegram.org — avoids the telegramClient.ts
 * singleton which always returns the mock bot in test mode.
 *
 * Run with:
 *   # Dry / CI (auto-skip):
 *   npm run test:integration -- --testPathPattern=connectionFlow
 *
 *   # Live (requires TELEGRAM_BOT_TOKEN in .env):
 *   npx jest --config jest.integration.live.js --testPathPattern=connectionFlow --forceExit
 */

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID;
const isMockEnv = process.env.TELEGRAM_MOCK === 'true';

const describeIfTelegram =
  TELEGRAM_TOKEN && !isMockEnv ? describe : describe.skip;

const BASE = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

async function tgGet(method: string) {
  const res = await fetch(`${BASE}/${method}`);
  const body = await res.json();
  return { status: res.status, body };
}

async function tgPost(method: string, payload: Record<string, unknown>) {
  const res = await fetch(`${BASE}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// Shared state captured in Step 1, used for logging in later steps
let botId: number;
let botUsername: string;

describeIfTelegram('Telegram Bot API infrastructure', () => {
  // ─── Step 1: Bot token authentication ──────────────────────────────────────

  describe('Step 1 — Bot token authentication (getMe)', () => {
    it('1.1: GET /getMe returns HTTP 200 with valid bot identity', async () => {
      const { status, body } = await tgGet('getMe');

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.result.is_bot).toBe(true);
      expect(typeof body.result.username).toBe('string');
      expect(body.result.username.length).toBeGreaterThan(0);
      expect(typeof body.result.id).toBe('number');
      expect(body.result.id).toBeGreaterThan(0);

      botId = body.result.id;
      botUsername = body.result.username;

      console.log(`Bot identity: @${botUsername} (id: ${botId})`);
    });
  });

  // ─── Step 2: Webhook registration status ───────────────────────────────────

  describe('Step 2 — Webhook registration status (getWebhookInfo)', () => {
    it('2.1: GET /getWebhookInfo returns HTTP 200 with result object', async () => {
      const { status, body } = await tgGet('getWebhookInfo');

      expect(status).toBe(200);
      expect(body.ok).toBe(true);
      expect(typeof body.result).toBe('object');
      expect(body.result).not.toBeNull();
    });

    it('2.2: documents current webhook configuration (non-asserting discovery)', async () => {
      const { body } = await tgGet('getWebhookInfo');
      const info = body.result;

      console.log('─── Step 2 Webhook info ───');
      console.log('url:', info.url || '(not set)');
      console.log('pending_update_count:', info.pending_update_count ?? 0);
      console.log('last_error_message:', info.last_error_message || '(none)');

      if (info.url) {
        const hasExpectedPath = info.url.includes('/v1/webhooks/telegram');
        console.log(
          'contains /v1/webhooks/telegram:',
          hasExpectedPath ? 'yes' : 'NO — path may be wrong',
        );
      } else {
        console.log(
          'Webhook not configured. To register:',
          `POST https://api.telegram.org/bot<TOKEN>/setWebhook with url=<your-server>/v1/webhooks/telegram`,
        );
      }

      if (info.last_error_message) {
        console.log(
          'last_error_date:',
          info.last_error_date
            ? new Date(info.last_error_date * 1000).toISOString()
            : '(unknown)',
        );
      }

      // Non-asserting: this test documents current state, it does not enforce it.
      expect(body.ok).toBe(true);
    });
  });

  // ─── Step 3: Message delivery ───────────────────────────────────────────────

  describe('Step 3 — Message delivery (sendMessage)', () => {
    it(
      '3.1: sends a message to TELEGRAM_TEST_CHAT_ID and receives a message_id',
      TELEGRAM_TEST_CHAT_ID
        ? async () => {
            const timestamp = new Date().toISOString();
            const { status, body } = await tgPost('sendMessage', {
              chat_id: parseInt(TELEGRAM_TEST_CHAT_ID, 10),
              text: `Smoke test — Step 3 (connectionFlow.test.ts) — ${timestamp}`,
              parse_mode: 'HTML',
            });

            expect(status).toBe(200);
            expect(body.ok).toBe(true);
            expect(typeof body.result.message_id).toBe('number');
            expect(body.result.message_id).toBeGreaterThan(0);
            expect(body.result.chat.id).toBe(parseInt(TELEGRAM_TEST_CHAT_ID, 10));

            console.log(
              `Message delivered: message_id=${body.result.message_id} to chat ${body.result.chat.id}`,
            );
          }
        : () => {
            console.log(
              'Step 3.1 skipped — set TELEGRAM_TEST_CHAT_ID in .env to enable',
            );
          },
    );

    it('3.2: POST /sendMessage with invalid chat_id returns ok=false (negative path)', async () => {
      const { body } = await tgPost('sendMessage', {
        chat_id: 0,
        text: 'negative path test',
      });

      expect(body.ok).toBe(false);
      expect(typeof body.error_code).toBe('number');

      console.log(
        `Negative path: ok=${body.ok}, error_code=${body.error_code}, description=${body.description}`,
      );
    });
  });
});
