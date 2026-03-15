---
name: tranzact-checkout
description: Complete purchases on behalf of users using the Tranzact payment backend. Use when the user asks to buy, purchase, order, or checkout a product. Issues a one-time virtual card with user-approved budget, reveals card credentials once for checkout, then cancels the card.
compatibility: Requires TRANZACT_BASE_URL, TRANZACT_WORKER_KEY, and TRANZACT_USER_API_KEY environment variables. Requires web browsing and browser automation tools for product search and checkout. Network access required.
metadata:
  author: tranzact
  version: "0.4"
---

# Tranzact Checkout

You complete purchases for the user through the Tranzact payment API. The user approves every purchase via Telegram before any charge occurs. The backend issues a one-time virtual card — you reveal the card credentials once, use them to checkout on the merchant site, then the card is cancelled.

**Important:** This skill involves a background wait for user approval. You will yield your session and be woken up by a system event. When you wake up, you **must resume on the same session and channel** where the user originally made the purchase request — do not start a new conversation.

## Pre-flight: Environment Check

**Before doing anything, verify these environment variables are set:**

| Variable | Purpose |
|----------|---------|
| `TRANZACT_BASE_URL` | Base URL of the Tranzact server (e.g. `https://pay.example.com`) |
| `TRANZACT_WORKER_KEY` | Shared secret for `/v1/agent/*` endpoints |
| `TRANZACT_USER_API_KEY` | User's API key for `/v1/intents` (issued during Telegram signup) |

If any are missing, tell the user:
> "I need Tranzact credentials to make purchases. Please set `TRANZACT_BASE_URL`, `TRANZACT_WORKER_KEY`, and `TRANZACT_USER_API_KEY` in your environment and try again."

Then stop. Do not proceed without all three values.

**Also verify these dependencies are available on the system:**

| Dependency | Check command | Install if missing |
|------------|--------------|-------------------|
| Python 3 | `python3 --version` | `apt install -y python3` (or system equivalent) |
| `requests` library | `python3 -c "import requests"` | `pip3 install requests` |

If a dependency is missing, attempt to install it. If installation fails (e.g. no permissions), tell the user what to install and stop.

**Two auth mechanisms are used:**

| Endpoint pattern | Header |
|-----------------|--------|
| `/v1/agent/*` | `X-Worker-Key: <TRANZACT_WORKER_KEY>` |
| `/v1/intents` | `Authorization: Bearer <TRANZACT_USER_API_KEY>` |

---

## One-Time Registration

Skip this if you already have a stored `agentId` and `userId` in your persistent state (`memory/tranzact_state.json`).

### 1. Register

```
POST {TRANZACT_BASE_URL}/v1/agent/register
X-Worker-Key: <TRANZACT_WORKER_KEY>
Content-Type: application/json

{}
```

Response (`201`):
```json
{
  "agentId": "ag_...",
  "pairingCode": "AB3X9K2M",
  "expiresAt": "2026-03-15T12:10:00.000Z"
}
```

- **Store `agentId` permanently** in `memory/tranzact_state.json`. It never changes.
- Give the user the `pairingCode` and tell them to message the Telegram bot with `/start <pairingCode>` to link their account.
- If the code expires, call the same endpoint with `{ "agentId": "<stored-id>" }` to get a fresh code.
- Rate limit: 3 requests per 10 minutes. Renewal cooldown: 5 minutes per `agentId`.

### 2. Resolve User

After the user says they've paired via Telegram:

```
GET {TRANZACT_BASE_URL}/v1/agent/user
X-Worker-Key: <TRANZACT_WORKER_KEY>
X-Agent-Id: <agentId>
```

Response (`200`):
```json
{ "status": "unclaimed" }
```
→ User hasn't signed up yet. Ask them to complete the Telegram pairing.

```json
{ "status": "claimed", "userId": "clx..." }
```
→ Pairing complete. You're ready for purchases. (The `userId` is informational — it is not passed in any API call. The Bearer token identifies the user automatically.)

---

## Currency Units

All monetary amounts in the API are **integers in the smallest currency unit**:

| Currency | Unit | Example: €5.00 / £5.00 / $5.00 |
|----------|------|---------------------------------|
| `eur` | cents | `500` |
| `gbp` | pence | `500` |
| `usd` | cents | `500` |

**Always multiply the user's amount by 100** to convert to API values. Always divide by 100 when displaying amounts back to the user.

---

## Purchase Flow

Execute these steps in order when the user asks you to buy something.

### Step 1 — Create Intent

Register the intent immediately, before searching. This tells the backend a purchase task is active.

**Note:** This endpoint uses the user's Bearer token, not the worker key.

```
POST {TRANZACT_BASE_URL}/v1/intents
Authorization: Bearer <TRANZACT_USER_API_KEY>
X-Idempotency-Key: <unique-uuid>
Content-Type: application/json

{
  "query": "Sony WH-1000XM5 headphones, black",
  "subject": "Buy Sony headphones",
  "maxBudget": 30000,
  "currency": "eur"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `query` | Yes | What to buy (1–500 chars) |
| `subject` | No | Short label (1–100 chars) |
| `maxBudget` | Yes | Maximum spend in smallest currency unit. Positive integer, max `1000000` (€10,000). If the user didn't specify a budget, ask them. |
| `currency` | No | 3-letter ISO code. Defaults to `"eur"`. **Always pass explicitly** — the quote endpoint defaults to `"gbp"`, so omitting on both causes a mismatch. |

Response (`201`):
```json
{
  "intentId": "clxyz123",
  "status": "SEARCHING",
  "createdAt": "2026-03-15T12:00:00.000Z"
}
```

**Store `intentId`** — used in every subsequent call for this purchase.

Rate limit: 10 requests per minute.

### Step 2 — Find the Product

Use your web browsing tools to search for the product the user wants. Collect:

- **merchantName** — retailer display name (e.g. "Amazon UK")
- **merchantUrl** — direct product URL (must be a valid URL)
- **price** — integer in smallest currency unit (e.g. €2.49 = `249`)
- **currency** — 3-letter ISO code, lowercase (`gbp`, `eur`, `usd`)

**Before asking the user for details**, check `USER.md` for saved preferences (shipping address, email, phone). Only ask for information that isn't already there or that's specific to this purchase (size, colour, etc.). Gather everything you'll need for checkout now — after approval you will yield and resume, so don't interrupt the post-approval flow.

### Step 3 — Submit Quote

```
POST {TRANZACT_BASE_URL}/v1/agent/quote
X-Worker-Key: <TRANZACT_WORKER_KEY>
Content-Type: application/json

{
  "intentId": "<intentId>",
  "merchantName": "Amazon UK",
  "merchantUrl": "https://www.amazon.co.uk/dp/B0BXYC7KN1",
  "price": 27999,
  "currency": "gbp"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `intentId` | Yes | From Step 1 |
| `merchantName` | Yes | Retailer display name |
| `merchantUrl` | Yes | Must be a valid URL |
| `price` | Yes | Positive integer, smallest currency unit |
| `currency` | No | Defaults to `"gbp"`. **Always pass explicitly** — must match the currency used in Step 1. |

Response (`200`):
```json
{ "intentId": "clxyz123", "status": "AWAITING_APPROVAL" }
```

Tell the user: "I found [product] at [merchant] for [formatted price]. I've sent an approval request to your Telegram — please approve or reject it there."

The intent must be in `SEARCHING` state. If not, the API returns `409`.

### Step 4 — Wait for Approval (Background Polling)

**Do not poll in a loop yourself.** Launch the background polling script, then yield your session.

#### 4a. Launch the polling script

```
exec(command="./skills/tranzact-checkout/scripts/poll_decision.py <intentId>", background=true)
```

The script polls `GET /v1/agent/decision/<intentId>` every 5 seconds for up to 10 minutes. When the user approves or rejects, the script wakes you up via a system event.

#### 4b. Tell the user and yield

Tell the user:
> "Sent for approval. I'll notify you here as soon as you approve or reject it on Telegram."

Then call `sessions_yield` to end your turn. You will go dormant and stop consuming resources.

#### 4c. Wake up and resume

You will be woken up by a system event starting with `[Tranzact Alert]`. When this happens:

1. **Resume on the same session and channel** where the user originally asked you to buy something. Do not start a new conversation.
2. Parse the JSON from the event text after the `[Tranzact Alert]:` prefix.

The event payload is:
```
[Tranzact Alert]: {"status":"APPROVED","intentId":"clxyz123","checkout":{"intentId":"clxyz123","amount":27999,"currency":"gbp"}}
```

| `status` in payload | Action |
|-------------------|--------|
| `APPROVED` | Tell the user "Your purchase was approved! Proceeding to checkout now..." and continue to Step 5. |
| `DENIED` | Tell the user "Your purchase was rejected." **Stop. Do not proceed.** |
| `TIMEOUT` | Tell the user "The approval request expired after 10 minutes. Please try again." **Stop.** |
| `ERROR` | Read the `error` field for details. Tell the user what went wrong and **stop.** |

The `checkout.amount` is the quote price you submitted. This is the spending limit on the virtual card.

#### Decision API reference (used by the script, not by you directly)

```
GET {TRANZACT_BASE_URL}/v1/agent/decision/<intentId>
X-Worker-Key: <TRANZACT_WORKER_KEY>
```

Response statuses: `AWAITING_APPROVAL`, `APPROVED`, `DENIED`.

### Step 5 — Reveal Card Credentials

Once approved, retrieve the virtual card details. **This endpoint can only be called once per intent.**

```
GET {TRANZACT_BASE_URL}/v1/agent/card/<intentId>
X-Worker-Key: <TRANZACT_WORKER_KEY>
```

Response (`200`, first call only):
```json
{
  "intentId": "clxyz123",
  "number": "4000056655665556",
  "cvc": "482",
  "expMonth": 3,
  "expYear": 2028,
  "last4": "5556"
}
```

| HTTP | Meaning |
|------|---------|
| `200` | Card credentials returned. **This is your only chance** — a second call returns `409`. |
| `404` | No card found for this intent (card not yet issued, or invalid intentId). |
| `409` | Card already revealed. You cannot retrieve credentials again. |

**Hold the card details in memory only.** Never log, store to disk, or persist the full card number or CVC.

Rate limit: 2 requests per minute per intentId.

### Step 6 — Complete Checkout on Merchant Site

Use your browser automation tools to complete the purchase on the merchant website:

1. Navigate to the `merchantUrl` from Step 2.
2. Add the product to cart and proceed to checkout.
3. Fill in the shipping/billing details you gathered from the user in Step 2.
4. Fill the payment form with the card credentials from Step 5:
   - Card number: `number`
   - Expiry: `expMonth` / `expYear` (zero-pad month to 2 digits, e.g. `3` → `03`)
   - CVC: `cvc`
5. Complete the order. Capture the order confirmation URL if available.

The virtual card has a spending limit equal to `checkout.amount` — the merchant's charge will be declined if it exceeds this.

### Step 7 — Report Result

**Always call this as the final step, whether checkout succeeded or failed.** This closes the intent and cancels the virtual card.

```
POST {TRANZACT_BASE_URL}/v1/agent/result
X-Worker-Key: <TRANZACT_WORKER_KEY>
Content-Type: application/json
```

Success:
```json
{
  "intentId": "<intentId>",
  "success": true,
  "actualAmount": 27999,
  "receiptUrl": "https://www.amazon.co.uk/gp/css/order-details?orderID=302-1234567"
}
```

Failure:
```json
{
  "intentId": "<intentId>",
  "success": false,
  "errorMessage": "Card declined at checkout"
}
```

| Field | Required | Notes |
|-------|----------|-------|
| `intentId` | Yes | |
| `success` | Yes | `true` or `false` |
| `actualAmount` | No | Amount actually charged, smallest currency unit. May differ from quoted price. |
| `receiptUrl` | No | Order confirmation URL if available. Omit if none. |
| `errorMessage` | No | Reason for failure. Include on `success: false`. |

Response (`200`):
```json
{ "intentId": "clxyz123", "status": "DONE" }
```
or
```json
{ "intentId": "clxyz123", "status": "FAILED" }
```

The intent must be in `CHECKOUT_RUNNING` state. If not, the API returns `409`.

Tell the user the outcome and the final amount charged.

---

## Rules

1. **One checkout per intent.** Never attempt checkout more than once per `intentId`.
2. **Never skip approval.** Always poll `/decision` and respect the user's choice.
3. **Always report.** Call `/agent/result` even on failure — this releases the budget and cancels the card.
4. **Amounts are integers.** Always smallest currency unit — multiply by 100 (e.g. €5 = `500`). Divide by 100 for display.
5. **`intentId` threads everything.** Pass it through every step: `/intents` → `/quote` → `/decision` → `/card` → checkout → `/result`.
6. **Card credentials are one-time.** The reveal endpoint works exactly once. Hold credentials in memory only — never log, persist, or expose them.
7. **Card credentials are ephemeral.** Clear them from memory after checkout completes or fails. They cannot be retrieved again.
8. **Ask early for checkout details.** Before submitting a quote, check `USER.md` for saved info, then ask the user for anything else you'll need during checkout (shipping address, email, preferences). Don't interrupt the flow after approval.
9. **Yield during approval.** Never poll in a loop. Launch the background script, then `sessions_yield`. Resume only when woken by `[Tranzact Alert]`.
10. **Resume on the same session.** When woken up, continue the conversation on the same session and channel where the user made the purchase request. Do not start a new conversation.

## Persistent State

Store registration data in `memory/tranzact_state.json`:
```json
{
  "agentId": "ag_..."
}
```

Read this file on every purchase to retrieve `agentId` and check if registration is complete.

## Error Codes

| HTTP | Meaning |
|------|---------|
| `400` | Bad request — check required fields |
| `401` | Wrong or missing auth header (`X-Worker-Key` or `Authorization: Bearer`) |
| `402` | Card declined — spending limit exceeded or card cancelled |
| `404` | Resource not found (`intentId`, `userId`, `agentId`) |
| `409` | State conflict — intent not in expected state, or card already revealed |
| `429` | Rate limited — wait before retrying |
