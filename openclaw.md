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

## Authentication

Every request to an agent endpoint requires the `X-Worker-Key` header:

```
X-Worker-Key: <WORKER_API_KEY>
```

The value must match the `WORKER_API_KEY` environment variable configured on the server.
Missing or incorrect key → `401 Unauthorized`.

For local development the default value is `local-dev-worker-key`.

---

## Full Integration Flow

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
  │◀── { status: APPROVED,              │  5. Approved — card details delivered once
  │      card: { number, cvc, ... }} ───│
  │                                     │
  │  6. Complete checkout using card    │
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
| `currency` | `string` | — | Ignored — the intent's currency is derived server-side from the user's payment provider (e.g. `eur` for Stripe). |
| `expiresAt` | `string` | No | ISO 8601 datetime after which the intent expires |

```json
{
  "userId": "user_abc123",
  "query": "Sony WH-1000XM5 headphones, black",
  "subject": "Buy Sony headphones",
  "maxBudget": 30000
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

**Auth:** `X-Worker-Key` required.

**Request body:**

| Field | Type | Required | Constraints |
|-------|------|----------|-------------|
| `intentId` | `string` | Yes | Must match an intent in `SEARCHING` state |
| `merchantName` | `string` | Yes | Non-empty display name of the retailer |
| `merchantUrl` | `string` | Yes | Direct product URL (valid URL) |
| `price` | `integer` | Yes | Positive integer, smallest currency unit |
| `currency` | `string` | No | 3-letter ISO code; pass the currency shown on the listing — it must match the intent's currency (case-insensitive), and a mismatch returns `409` rather than mislabeling the price. Omit to inherit the intent's currency (skips the mismatch check). No default. |

```json
{
  "intentId": "clxyz123",
  "merchantName": "Amazon UK",
  "merchantUrl": "https://www.amazon.co.uk/dp/B0BXYC7KN1",
  "price": 27999
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
| `401` | Missing or wrong `X-Worker-Key` |
| `404` | `intentId` not found |
| `409` | Intent is not in `SEARCHING` state |
| `409` | `currency` does not match the intent's currency |

Do not post another quote for the same `intentId`. The user is now deciding.

---

### GET /v1/agent/decision/:intentId

Poll this endpoint after posting a quote to learn the user's decision and, on approval,
receive the one-time virtual card details.

**Auth:** `X-Worker-Key` required.

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

**Response `200` — approved, card delivered (first poll only):**

```json
{
  "intentId": "clxyz123",
  "status": "APPROVED",
  "card": {
    "number": "4242424242424242",
    "cvc": "123",
    "expMonth": 12,
    "expYear": 2027,
    "last4": "4242"
  }
}
```

**The `card` object is delivered exactly once.** Store it in memory for the duration of
checkout. Do not persist it to disk, logs, or any external system.

**Response `200` — approved, card already delivered:**

```json
{ "intentId": "clxyz123", "status": "APPROVED" }
```

The card was delivered on an earlier poll. If you no longer have the card in memory,
report failure via `POST /v1/agent/result` — do not retry the reveal.

**Error responses:**

| Status | Condition |
|--------|-----------|
| `401` | Missing or wrong `X-Worker-Key` |
| `404` | `intentId` not found |

**Recommended polling strategy:**

- Start polling ~2 seconds after `POST /v1/agent/quote` returns.
- Poll every 5 seconds.
- Stop after 10 minutes (120 polls) and treat as expired — report failure.
- Stop immediately on `DENIED` or on any `APPROVED` response (with or without card).

---

### POST /v1/agent/result

Report the checkout outcome. This finalises the intent, settles or returns the ledger
reservation, and cancels the virtual card.

**Auth:** `X-Worker-Key` required.

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
| `401` | Missing or wrong `X-Worker-Key` |
| `404` | `intentId` not found |
| `409` | Intent is not in `CHECKOUT_RUNNING` state |

---

## Card Security Rules

- **Never log card details.** Do not write `number`, `cvc`, or expiry to stdout, files, or
  any external system.
- **Use the card in memory only.** Store it in a local variable for the duration of the
  checkout request, then discard it.
- **One card, one checkout.** The card is spending-limited to the approved amount and
  cancelled after `POST /v1/agent/result` returns. Do not attempt multiple checkouts.
- **Single reveal.** The backend delivers card details on the first `/decision` poll that
  returns `APPROVED`. Subsequent polls return `{ status: "APPROVED" }` without card data.
  If you missed the card (e.g. after a process restart), call `POST /v1/agent/result` with
  `success: false` immediately — do not try to re-obtain the card.

---

## Status Reference

| Status | Meaning for OpenClaw |
|--------|----------------------|
| `SEARCHING` | Intent registered — submit your quote via `POST /v1/agent/quote` |
| `AWAITING_APPROVAL` | User has not decided yet — keep polling `/decision` |
| `APPROVED` | Returned by `/decision` when the card is ready — first poll includes card details, subsequent polls do not |
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
| `WORKER_API_KEY` | Shared secret for `X-Worker-Key` header |

---

## Note: Stub Worker (local development only)

The repository includes a stub BullMQ worker (`src/worker/`) that simulates OpenClaw for
local testing. It consumes the `search-queue` and `checkout-queue` (Redis), posts a
hardcoded quote, and reports success immediately.

This is a test fixture only. A real OpenClaw implementation uses the HTTP flow above and
does not need Redis or BullMQ at all.
