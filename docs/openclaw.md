# OpenClaw — Agent Integration Guide

This document describes the HTTP API that OpenClaw (or any compatible agent) calls to
request purchase approval and receive a one-time virtual card. Read this before writing
any agent tool/plugin code.

---

## Overview

**OpenClaw** is a messaging-driven autonomous agent framework. A user sends a message
("buy me Sony headphones for under £30") via Telegram, Slack, or another channel — OpenClaw
routes it to an AI agent, which executes the task using whatever tools are available.

**This backend is one of those tools** — a payment plugin. When OpenClaw decides to make a
purchase it calls our HTTP API to request user approval and obtain a restricted one-time
virtual card. That is the full scope of our involvement: we manage the financial
infrastructure so OpenClaw never needs access to real bank or card credentials.

OpenClaw initiates every call. The backend never pushes work to the agent.

---

## Onboarding (first-time setup)

Before any purchase can happen, OpenClaw must register with the backend and the user must
sign up via Telegram. This is a one-time setup per OpenClaw instance.

```
OpenClaw                        Backend                         User (Telegram)
  │                                │                                 │
  │── POST /v1/agent/register ────▶│── { agentId, agentKey,          │
  │   X-Worker-Key (bootstrap)      │    pairingCode, expiresAt }     │
  │   stores agentId + key securely│                                 │
  │                                │                                 │
  │   (gives user the code + bot   │                                 │
  │    link: t.me/YourBot)         │                                 │
  │                                │◀── /start <pairingCode> ───────│
  │                                │    Bot: "What's your email?"    │
  │                                │◀── user@example.com ───────────│
  │                                │    Bot: "✅ Account created!"   │
  │                                │                                 │
  │── GET /v1/agent/user ─────────▶│── { status: "claimed",         │
  │   X-Agent-Key: <agentKey>      │    userId: "clx..." }           │
  │   (store userId permanently)   │                                 │
```

Once OpenClaw has a `userId` it can create purchase intents for that user.

If the pairing code expires before the user signs up, call `POST /v1/agent/register` again
with `X-Agent-Key` and an empty body. The authenticated `agentId` is stable and never
comes from request data.

---

## Authentication

Initial registration is the only route that accepts the server's bootstrap key:

```
X-Worker-Key: <WORKER_API_KEY>
```

The response contains `agentKey` exactly once. Store it in the OpenClaw instance's secret
store, never in source control or logs. Every subsequent agent request uses:

```
X-Agent-Key: <agentKey>
```

The backend stores only a bcrypt verifier and a lookup prefix. `X-Agent-Id` is optional
compatibility metadata; it never establishes identity and a mismatched value is rejected.
Credentials expire after 90 days and should be rotated before expiry.

For local development the default value is `local-dev-worker-key`.

---

## Full Integration Flow

> **Prerequisite:** complete [Onboarding](#onboarding-first-time-setup) before making
> any purchase. You need a stable `agentId` and a linked `userId`.

OpenClaw drives every step. The backend responds to requests — it never pushes to the agent.

```
OpenClaw                              Backend
  │                                     │
  │  1. Find product independently      │
  │     (web search, Playwright, etc.)  │
  │                                     │
  │── POST /v1/intents ────────────────▶│  2. Register intent, get intentId
  │◀── { intentId, status: SEARCHING } ─│     (intent transitions to SEARCHING)
  │                                     │
  │── POST /v1/agent/quote ────────────▶│  3. Submit found product
  │   { intentId, merchantName,         │     (transitions to AWAITING_APPROVAL,
  │     merchantUrl, price, currency }  │      notifies user via Telegram)
  │◀── { status: AWAITING_APPROVAL } ───│
  │                                     │
  │                          [User approves or rejects in Telegram]
  │                                     │
  │── GET /v1/agent/decision/:intentId ▶│  4. Poll every ~5 s
  │◀── { status: AWAITING_APPROVAL } ───│     (keep polling)
  │                          ...        │
  │── GET /v1/agent/decision/:intentId ▶│
  │◀── { status: APPROVED,              │  5. Approved — checkout params delivered
  │      checkout: { intentId,          │
  │        amount, currency } } ────────│
  │                                     │
  │  6. Simulate checkout using the     │
  │     params from step 5              │
  │── POST /v1/checkout/simulate ──────▶│  6a. Backend charges the card
  │   { intentId, amount, currency,     │      (Stripe Issuing auth + capture)
  │     merchantName }                  │
  │◀── { success, chargeId, amount } ───│
  │                                     │
  │── POST /v1/agent/result ───────────▶│  7. Report outcome
  │   { intentId, success, ... }        │
  │◀── { status: DONE | FAILED } ───────│
```

If the user rejects:

```
  │── GET /v1/agent/decision/:intentId ▶│
  │◀── { status: DENIED } ──────────────│  Stop. Do not checkout.
```

---

## Endpoints

### POST /v1/agent/register

Register a new OpenClaw instance (first time) or renew an expired pairing code.

**Auth:** `X-Worker-Key` for first registration; `X-Agent-Key` for pairing-code renewal.

**Request body:** an empty JSON object. Caller-supplied agent IDs are rejected.

```json
{}
```

**Success response `200` — first registration:**

```json
{
  "agentId": "ag_a1b2c3d4e5f6",
  "agentKey": "agk_...",
  "agentKeyExpiresAt": "2026-11-17T13:00:00.000Z",
  "pairingCode": "AB3X9K2M",
  "expiresAt": "2026-08-19T13:10:00.000Z"
}
```

Store `agentId` and `agentKey` securely. The key is not retrievable later. Give
`pairingCode` to the user; it is valid for 10 minutes.

**Renewal:** send the current `X-Agent-Key` with an empty body:

```json
{}
```

**Success response `200` — pairing-code renewal:**

```json
{
  "agentId": "ag_a1b2c3d4e5f6",
  "pairingCode": "ZX7Q2MNP",
  "expiresAt": "2026-08-19T13:20:00.000Z"
}
```

Renewal does not rotate or redisplay the agent credential.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `401` | Missing/invalid bootstrap key or agent credential |
| `409` | Agent already has a linked user — re-registration not needed |
| `429` | Registration or renewal rate limit hit |

---

### POST /v1/agent/credential/rotate

Replace the current credential before it expires. Rotation preserves the `agentId`, user
link, and active intents, and invalidates the old key immediately.

**Auth:** current `X-Agent-Key`.

**Response `200`:**

```json
{
  "agentId": "ag_a1b2c3d4e5f6",
  "agentKey": "agk_...",
  "agentKeyExpiresAt": "2026-11-20T13:00:00.000Z",
  "credentialVersion": 2
}
```

Replace the stored key atomically. If the response is lost, unlink and pair a new agent;
the old key may already be invalid.

---

### GET /v1/agent/user

Resolve the `userId` linked to this OpenClaw instance.

**Auth:** `X-Agent-Key` required.

**Response `200` — user not yet signed up:**

```json
{ "status": "unclaimed" }
```

Keep displaying the pairing code to the user (or renew it if expired).

**Response `200` — user has signed up:**

```json
{ "status": "claimed", "userId": "clxyz123" }
```

Store `userId` permanently. Use it in all `POST /v1/intents` calls.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `401` | Missing, invalid, rotated, or expired agent credential |

---

### POST /v1/intents

Register a new purchase intent. Call this once per task, before posting a quote.
Returns an `intentId` that is used in all subsequent calls.

**Auth:** None (user-facing endpoint). Supply a unique `X-Idempotency-Key` header.

**Headers:**

| Header | Required | Description |
|--------|----------|-------------|
| `X-Idempotency-Key` | Yes | Any unique string (e.g. UUID). Prevents duplicate intents on retry. |

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `userId` | `string` | Yes | ID of the user on whose behalf the agent is acting |
| `query` | `string` | Yes | Free-text shopping task (e.g. "Sony WH-1000XM5 headphones"), max 500 chars |
| `subject` | `string` | No | Short task title for notifications, max 100 chars |
| `maxBudget` | `integer` | Yes | Maximum spend in smallest currency unit (pence/cents), max 1 000 000 |
| `currency` | `string` | No | 3-letter ISO code, lowercase (e.g. `eur`, `gbp`); default `eur` |
| `expiresAt` | `string` | No | ISO 8601 datetime after which the intent expires |

```json
{
  "userId": "user_abc123",
  "query": "Sony WH-1000XM5 headphones, black",
  "subject": "Buy Sony headphones",
  "maxBudget": 30000,
  "currency": "gbp"
}
```

**Success response `201`:**

```json
{
  "intentId": "clxyz123",
  "status": "SEARCHING",
  "createdAt": "2026-02-22T12:00:00.000Z"
}
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | Missing `X-Idempotency-Key`, or invalid fields |
| `404` | `userId` not found |

> **Note:** This endpoint also enqueues a job on the internal `search-queue`. If you are
> running the stub worker at the same time as a real OpenClaw instance, the stub worker will
> race to post its own quote and cause a `409` on yours. Run one or the other, not both.

---

### POST /v1/agent/quote

Submit the product you found. This transitions the intent to `AWAITING_APPROVAL` and sends
the user a Telegram notification with an approve/reject button.

**Auth:** `X-Agent-Key` required. The intent must belong to this exact agent and its user.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `intentId` | `string` | Yes | Must match an intent in `SEARCHING` state |
| `merchantName` | `string` | Yes | Non-empty display name of the retailer |
| `merchantUrl` | `string` | Yes | Direct product URL (valid URL) |
| `price` | `integer` | Yes | Positive integer, smallest currency unit |
| `currency` | `string` | No | 3-letter ISO code, lowercase; default `gbp` |

```json
{
  "intentId": "clxyz123",
  "merchantName": "Amazon UK",
  "merchantUrl": "https://www.amazon.co.uk/dp/B0BXYC7KN1",
  "price": 27999,
  "currency": "gbp"
}
```

**Success response `200`:**

```json
{ "intentId": "clxyz123", "status": "AWAITING_APPROVAL" }
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | Missing or invalid fields |
| `401` | Missing, invalid, rotated, or expired agent credential |
| `403` | Agent is unlinked or does not own the intent |
| `404` | `intentId` not found |
| `409` | Intent is not in `SEARCHING` state |

Do not post another quote for the same `intentId`. The user is now deciding.

---

### GET /v1/agent/decision/:intentId

Poll this endpoint after posting a quote to learn the user's decision and, on approval,
receive the one-time virtual card details.

**Auth:** `X-Agent-Key` required. The intent must belong to this exact agent and its user.

**URL parameter:** `intentId` from step 2.

**Response `200` — still waiting:**

```json
{ "intentId": "clxyz123", "status": "AWAITING_APPROVAL" }
```

Poll again in a few seconds.

**Response `200` — user rejected:**

```json
{ "intentId": "clxyz123", "status": "DENIED" }
```

Stop polling. Do not attempt checkout.

**Response `200` — approved:**

```json
{
  "intentId": "clxyz123",
  "status": "APPROVED",
  "checkout": {
    "intentId": "clxyz123",
    "amount": 27999,
    "currency": "gbp"
  }
}
```

The `checkout` object contains exactly the params you need to call
`POST /v1/checkout/simulate` in the next step. Pass them through directly (plus
`merchantName`). No card credentials are involved — the backend looks up the card
server-side using the `intentId`.

The `amount` is the quoted price (`price` from your earlier `POST /v1/agent/quote`
call); `maxBudget` is used as a fallback if no quote price is recorded.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `401` | Missing, invalid, rotated, or expired agent credential |
| `403` | Agent is unlinked or does not own the intent |
| `404` | `intentId` not found |

**Recommended polling strategy:**

- Start polling ~2 seconds after `POST /v1/agent/quote` returns.
- Poll every 5 seconds.
- Stop after 10 minutes (120 polls) and treat as expired — report failure.
- Stop immediately on `DENIED` or on `APPROVED`.

---

### POST /v1/agent/result

Report the checkout outcome. This finalises the intent, settles or returns the ledger
reservation, and cancels the virtual card.

**Auth:** `X-Agent-Key` required. The intent must belong to this exact agent and its user.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `intentId` | `string` | Yes | Must match an intent in `CHECKOUT_RUNNING` state |
| `success` | `boolean` | Yes | `true` = purchase completed, `false` = purchase failed |
| `actualAmount` | `integer` | No | Actual amount charged, smallest currency unit; include on success |
| `receiptUrl` | `string` | No | URL of the order confirmation page; include on success |
| `errorMessage` | `string` | No | Human-readable failure reason; include on failure |

**Success checkout:**

```json
{
  "intentId": "clxyz123",
  "success": true,
  "actualAmount": 27999,
  "receiptUrl": "https://www.amazon.co.uk/gp/css/order-details?orderID=203-1234567-8901234"
}
```

**Failed checkout:**

```json
{
  "intentId": "clxyz123",
  "success": false,
  "errorMessage": "Payment declined at checkout"
}
```

**Response `200`:**

```json
{ "intentId": "clxyz123", "status": "DONE" }
```

or on failure:

```json
{ "intentId": "clxyz123", "status": "FAILED" }
```

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | Missing or invalid fields |
| `401` | Missing, invalid, rotated, or expired agent credential |
| `403` | Agent is unlinked or does not own the intent |
| `404` | `intentId` not found |
| `409` | Intent is not in `CHECKOUT_RUNNING` state |

---

---

### POST /v1/checkout/simulate

Simulate a merchant checkout. Use this after `GET /v1/agent/decision/:intentId` returns
`APPROVED` — pass the `checkout` object from that response (plus `merchantName`) directly
to this endpoint.

The backend looks up the issued virtual card by `intentId` and triggers a real Stripe
Issuing authorization + capture. No raw card credentials are required or accepted.

> **Test mode only.** Uses `stripe.testHelpers.issuing.authorizations` — works on any
> standard Stripe test account without special opt-ins. The endpoint is decoupled from
> the intent state machine; intents and ledger entries are settled separately via
> `POST /v1/agent/result`.

**Auth:** None — the card's own spending controls (set at issuance) are the security layer.

**Request body:**

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `intentId` | `string` | Yes | `intentId` from the `/decision` `checkout` object |
| `amount` | `integer` | Yes | Smallest currency unit (cents/pence), max 1 000 000 |
| `currency` | `string` | No | 3-letter ISO code; default `eur` |
| `merchantName` | `string` | No | Display label; default `Simulated Merchant` |

```json
{
  "intentId": "clxyz123",
  "amount": 27999,
  "currency": "gbp",
  "merchantName": "Amazon UK"
}
```

**Typical usage — pass through the `checkout` object from `/decision`:**

```js
const { checkout } = await pollDecision(intentId); // GET /v1/agent/decision/:intentId
const result = await simulateCheckout({
  ...checkout,                // intentId, amount, currency
  merchantName: 'Amazon UK',
});
```

**Success response `200`:**

```json
{
  "success": true,
  "chargeId": "iauth_...",
  "amount": 27999,
  "currency": "gbp"
}
```

**Declined response `402`:**

```json
{
  "success": false,
  "declineCode": "spending_controls",
  "message": "Card declined"
}
```

Common `declineCode` values:
- `card_declined` — generic decline
- `spending_controls` — amount exceeds the card's budget limit
- `insufficient_funds` — Stripe test balance exhausted

**Error responses:**

| Status | Condition |
|--------|-----------|
| `400` | Missing or invalid fields (`intentId` empty, `amount` missing or zero, etc.) |
| `402` | Card declined by Stripe |
| `404` | No virtual card found for this `intentId` (card not yet issued) |
| `500` | Unexpected error |

---

## Card Security Rules

- **OpenClaw never handles raw card credentials.** The virtual card's PAN, CVC, and expiry
  are managed entirely server-side. The `/decision` endpoint returns `checkout` params
  (`intentId`, `amount`, `currency`), not card numbers.
- **One card, one checkout.** The card is spending-limited to the approved amount and
  cancelled after `POST /v1/agent/result` returns. Do not call `POST /v1/checkout/simulate`
  more than once per intent.
- **The `intentId` is the key.** Pass it through from the `/decision` response to
  `/checkout/simulate`. The backend uses it to look up the card server-side.

---

## Status Reference

| Status | Meaning for OpenClaw |
|--------|----------------------|
| `SEARCHING` | Intent registered — submit your quote via `POST /v1/agent/quote` |
| `AWAITING_APPROVAL` | User has not decided yet — keep polling `/decision` |
| `APPROVED` | Returned by `/decision` when the card is ready — response includes `checkout` params to pass to `POST /v1/checkout/simulate` |
| `DENIED` | User rejected — stop, do not checkout |
| `CHECKOUT_RUNNING` | The approved state you must be in to call `POST /v1/agent/result` |
| `DONE` | Purchase complete — terminal state |
| `FAILED` | Checkout failed — terminal state |
| `EXPIRED` | Intent timed out before approval — terminal state |

---

## Environment Variables (agent side)

| Variable | Description |
|----------|-------------|
| `API_BASE_URL` | Base URL of the backend, e.g. `http://localhost:3000` |
| `OPENCLAW_AGENT_KEY` | Per-instance secret returned once by registration; used as `X-Agent-Key` |

### Existing-installation migration

The old shared worker key cannot prove which legacy agent is calling, so there is no safe
automatic exchange by `agentId`. For each existing installation:

1. Upgrade the backend and apply the database migration. Existing active intents are bound
   to the currently linked agent, but legacy agents have no credential and cannot call agent
   routes.
2. Finish or explicitly expire in-flight work before the upgrade window.
3. Unlink the legacy agent from the user's account.
4. Bootstrap a fresh registration with `X-Worker-Key`, store the returned `agentKey`, and
   have the user approve the new pairing code.
5. Remove `WORKER_API_KEY` from the OpenClaw runtime. It is a server-side bootstrap secret,
   not an operational agent credential.

If a key is compromised, unlink immediately. Unlinking revokes the verifier and expires
that agent's active intents; then repeat the fresh-registration flow.

---

## Note: Stub Worker (local development only)

The repository includes a stub BullMQ worker (`src/worker/`) that simulates OpenClaw for
local testing. It consumes the `search-queue` and `checkout-queue` (Redis), posts a
hardcoded quote, and reports success immediately.

Set `OPENCLAW_AGENT_KEY` to the key returned for the single agent used by the stub worker.
The worker cannot process intents owned by any other agent.

This is a test fixture only. A real OpenClaw implementation uses the HTTP flow above and
does not need Redis or BullMQ at all.
