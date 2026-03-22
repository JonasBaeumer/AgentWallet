# Telegram Approval Setup

This guide sets up the Telegram bot so users can approve or reject purchase requests from their phone.

There are **two testing paths** — Steps 1–4 are shared, then you choose:

| | Path A — Seeded user | Path B — Full OpenClaw |
|---|---|---|
| **Best for** | Solo testing, no OpenClaw running | End-to-end integration testing |
| **User created by** | `npm run seed` or `link-telegram` endpoint | OpenClaw pairing flow |
| **Requires OpenClaw?** | No | Yes |

Steps 1–4 (bot, ngrok, webhook) are identical for both paths. At Step 5, choose the path that fits your situation.

See [docs/openclaw.md](openclaw.md) for the full OpenClaw integration guide.

---

## Prerequisites

- The AgentPay server is running (`npm run dev`)
- You have a Telegram account

---

## Step 1 — Create a Telegram bot

1. Open Telegram and start a chat with [@BotFather](https://t.me/BotFather)
2. Send `/newbot`
3. Choose a display name (e.g. `AgentPay Dev`)
4. Choose a username ending in `bot` (e.g. `agentpay_dev_bot`)
5. BotFather replies with your token: `123456789:ABCdef...` — copy it

---

## Step 2 — Configure `.env`

Add the following to your `.env` file (the placeholders are already there):

```
TELEGRAM_BOT_TOKEN=<your bot token from Step 1>
TELEGRAM_WEBHOOK_SECRET=<any random string you choose, e.g. my-secret-123>
```

Restart the server after saving: `Ctrl+C` then `npm run dev`.

> `TELEGRAM_TEST_CHAT_ID` is optional — used by Path A below to pre-link your Telegram account to the seeded demo user. Come back here at Path A Step 5.

---

## Step 3 — Expose your local server with ngrok

Telegram webhooks require a public HTTPS URL. Use ngrok to create one.

**Install ngrok:**
```bash
brew install ngrok
```

**Create a free account** at [dashboard.ngrok.com/signup](https://dashboard.ngrok.com/signup), then add your authtoken:
```bash
ngrok config add-authtoken <your-authtoken>
```

**Start ngrok** (in a separate terminal, keep it running):
```bash
ngrok http 3000
```

Copy the `https://` URL shown, e.g. `https://abc123.ngrok-free.app`.

---

## Step 4 — Register the webhook with Telegram

Run this once (replace both placeholders):

```bash
curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://<your-ngrok-url>/v1/webhooks/telegram",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>",
    "allowed_updates": ["message", "callback_query"],
    "drop_pending_updates": true
  }'
```

> **Note:** Both `message` and `callback_query` are required.
> `message` handles the signup flow (`/start <code>` and the email reply).
> `callback_query` handles the approve/reject buttons.

You should see: `{"ok":true,"result":true,"description":"Webhook was set"}`

> **Note:** ngrok gives you a new URL each restart (free tier). Re-run this step whenever you restart ngrok.

---

## Choose your path

---

## Path A — Seeded user, no OpenClaw (fastest for solo testing)

### Step 5A — Link your Telegram account to the demo user

**Option 1: use `npm run seed` (recommended for first-time setup)**

1. Find your Telegram chat ID. The easiest way: message [@userinfobot](https://t.me/userinfobot) and it replies with your numeric ID.
2. Add it to `.env`:
   ```
   TELEGRAM_TEST_CHAT_ID=<your-numeric-chat-id>
   ```
3. Run the seed:
   ```bash
   npm run seed
   ```
   This upserts the `demo@agentpay.dev` user and sets `telegramChatId` to your value. The `userId` is printed to stdout — save it.

**Option 2: link an existing user (skip re-seeding)**

If you already have a `userId` from a prior run and just want to update the chat ID, use the `link-telegram` endpoint directly:

```bash
curl -X POST http://localhost:3000/v1/users/<userId>/link-telegram \
  -H "Content-Type: application/json" \
  -d '{"telegramChatId": "<your-chat-id>"}'
# → {"userId":"...","telegramChatId":"...","linked":true}
```

Errors: `400` (missing or invalid body), `404` (userId not found — re-run `npm run seed`). No auth required.

### Step 6A — Explore the menu

Once your account is linked, send `/menu` to the bot. You'll see an inline keyboard:

```
[💰 Balance]       [📋 History]
[🚫 Cancel Intent] [🔗 Agent Status]
[⚙️ Preferences]
```

| Button | What it shows |
|--------|--------------|
| 💰 Balance | Main balance, reserved amount, available balance |
| 📋 History | Last 5 completed purchases |
| 🚫 Cancel Intent | Active intents you can cancel (tap one to confirm) |
| 🔗 Agent Status | Which agent is linked to your account |
| ⚙️ Preferences | Coming soon (card TTL / cancel policy) |

Every screen has a ⬅️ Back button that returns to the main menu.

> If you haven't signed up yet, `/menu` replies with a prompt to run `/start <code>` first.

### Step 7A — Test an approval

```bash
# Create an intent (use the userId from Step 5A)
curl -X POST http://localhost:3000/v1/intents \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: test-1" \
  -d '{"userId":"<YOUR_USER_ID>","query":"Sony WH-1000XM5","subject":"Buy Sony headphones","maxBudget":35000}'

# Run the stub worker (posts a quote, triggers the Telegram notification)
npm run worker
```

Within a few seconds you should receive a Telegram message like:

> 🛒 **Purchase Approval Request**
>
> **Task:** Buy Sony headphones
> **Merchant:** Amazon UK
> **Price:** 350.00 GBP
> **Budget:** 350.00 GBP
>
> Tap below to decide:
> `[✅ Approve]` `[❌ Reject]`

Tap ✅ Approve — the intent moves to `CHECKOUT_RUNNING` and the message updates to confirm.

---

## Path B — Full OpenClaw + Telegram

Users are created through the OpenClaw-initiated pairing flow — **not** through any manual admin step.

### Step 5B — User signup via OpenClaw

**What OpenClaw does (once, on first run):**

```bash
curl -X POST http://localhost:3000/v1/agent/register \
  -H "X-Worker-Key: local-dev-worker-key"
# → { "agentId": "ag_abc123", "pairingCode": "AB3X9K2M", "expiresAt": "..." }
```

OpenClaw stores the `agentId` permanently and gives the user the pairing code along with the bot username.

**What the user does in Telegram:**

1. Open the bot (search for your bot's username, e.g. `@agentpay_dev_bot`)
2. Send: `/start AB3X9K2M` (with the code from OpenClaw)
3. The bot replies: *"What email address should we use for your account?"*
4. Reply with your email address
5. The bot confirms: *"✅ Account created! Your OpenClaw is now linked."*

After this, OpenClaw can resolve the `userId`:

```bash
curl http://localhost:3000/v1/agent/user \
  -H "X-Worker-Key: local-dev-worker-key" \
  -H "X-Agent-Id: ag_abc123"
# → { "status": "claimed", "userId": "clxyz..." }
```

The pairing code is valid for 30 minutes. If it expires before the user signs up, OpenClaw calls `POST /v1/agent/register` again with `{ "agentId": "ag_abc123" }` to get a fresh code.

### Step 6B — Test it

Once a user is signed up, create an intent and run the stub worker (same as Path A Step 6A above).

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| No Telegram message arrives | Bot token not loaded | Restart the server after editing `.env` |
| `/start <code>` gives no reply | Webhook not registered or wrong URL | Re-run Step 4 with the current ngrok URL |
| `"chat not found"` error in logs | User never sent a message to the bot | User must send `/start <code>` first (Step 5) |
| `"invalid or expired code"` reply | Code expired (30 min TTL) | OpenClaw calls `POST /v1/agent/register` with existing `agentId` to renew |
| Buttons do nothing | Webhook not registered or ngrok restarted | Re-run Step 4 with the current ngrok URL |
| `401` on webhook endpoint | Wrong `TELEGRAM_WEBHOOK_SECRET` | Ensure `.env` value matches the `secret_token` in Step 4 |
| ngrok auth error | No authtoken configured | Run `ngrok config add-authtoken <token>` |
| `POST /v1/users/:userId/link-telegram` returns 404 | userId is wrong or DB was reset | Re-run `npm run seed` and use the printed userId |
| `/menu` gives no response | Webhook not registered or server not running | Re-run Step 4; ensure `npm run dev` is running |
| `/menu` says "sign up first" | No account linked to your chat ID | Run `npm run seed` (with `TELEGRAM_TEST_CHAT_ID` set) or complete the `/start <code>` flow |
