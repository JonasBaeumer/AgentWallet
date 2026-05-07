# API Reference

Human-readable API reference for the Trusted Payment Infrastructure for Agents
HTTP API. This document is the canonical contract for third-party agent
developers; the source of truth for schemas lives in
[`src/api/validators/`](../src/api/validators) and the Zod schemas there.

> Base URL for the self-hosted default: `http://localhost:3000`

---

## Table of contents

- [Authentication](#authentication)
- [Standard error envelope](#standard-error-envelope)
- [Conventions](#conventions)
- [Intents](#intents)
- [Approvals](#approvals)
- [Agent API](#agent-api)
- [Checkout simulation](#checkout-simulation)
- [Webhooks](#webhooks)
- [Users](#users)
- [Debug / observability](#debug--observability)
- [Error reference](#error-reference)
- [Integration walkthrough](#integration-walkthrough)

---

## Authentication

There are two authentication schemes. A given endpoint requires exactly one.

### 1. User bearer key — for end-user routes

End-user routes require an API key issued to the user, sent as a bearer token:

```
Authorization: Bearer <api-key>
```

The key is issued once during Telegram signup and returned in the bot's
"Account created!" message. Only the 16-char prefix is stored in plain text in
the `apiKeyPrefix` column; the remainder is bcrypt-hashed. Keys cannot be
re-displayed.

Failure responses:

| Condition | Status | Body |
|---|---|---|
| Missing / non-Bearer header | 401 | `{ "error": "Unauthorized: missing or invalid Authorization header" }` |
| Bad key | 401 | `{ "error": "Unauthorized: invalid API key" }` |

### 2. Worker key — for agent routes

Agent / OpenClaw routes require the shared worker secret plus an agent identifier:

```
X-Worker-Key: <WORKER_API_KEY from env>
X-Agent-Id:   <ag_...>   # returned by POST /v1/agent/register
```

The worker key is a single process-global secret (`WORKER_API_KEY`). The agent
id is per-OpenClaw-instance; it becomes the `actor` on every audit event
emitted by that agent and is included in every structured log line on
`/v1/agent/*` routes.

Failure responses:

| Condition | Status | Body |
|---|---|---|
| Missing / wrong worker key | 401 | `{ "error": "Unauthorized: invalid or missing X-Worker-Key" }` |

### Routes without auth

- `POST /v1/checkout/simulate` — the card's own spending controls are the security boundary (test mode only).
- `POST /v1/webhooks/stripe` — verified by signature (`Stripe-Signature`) instead of a key.
- `POST /v1/webhooks/telegram` — verified by the `X-Telegram-Bot-Api-Secret-Token` header.
- `POST /v1/users/:userId/link-telegram` and `PATCH /v1/users/:userId/preferences` are currently internal / Telegram-callback helpers and do not enforce bearer auth.

---

## Standard error envelope

Every error response returns JSON with at least an `error` field. Validation
errors include a Zod-shaped `details` array. Human-readable error messages
land in `error` (not `message`).

```json
{
  "error": "Invalid input",
  "details": [
    { "code": "invalid_type", "expected": "string", "path": ["merchantName"], "message": "Required" }
  ]
}
```

---

## Conventions

- All monetary amounts are **integer minor units** (e.g. cents). `maxBudget: 30000` means €300.00.
- Currency is ISO-4217, lower case (`eur`, `gbp`, `usd`). Default is `eur`.
- All dates are ISO-8601 UTC strings.
- Every state-changing user-facing route requires a unique `X-Idempotency-Key` header; repeating a request with the same key replays the stored response body (see [idempotency middleware](../src/api/middleware/idempotency.ts)).

---

## Intents

An **intent** is a single shopping task with a hard budget. It walks the state
machine `RECEIVED → SEARCHING → QUOTED → AWAITING_APPROVAL → APPROVED → CARD_ISSUED → CHECKOUT_RUNNING → DONE`.

### `POST /v1/intents`

Create a purchase intent. Transitions immediately to `SEARCHING` and enqueues a
search job for the agent.

| | |
|---|---|
| Auth | `Authorization: Bearer <api-key>` |
| Idempotency | **Required**: `X-Idempotency-Key: <uuid>` |
| Rate limit | 10 req / minute per API key + IP |

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `query` | string (1–500) | yes | Natural-language shopping query |
| `subject` | string (1–100) | no | Short human-readable subject/title |
| `maxBudget` | int > 0, ≤ 1,000,000 | yes | Hard cap in minor units |
| `currency` | 3-letter ISO code | no | Defaults to `eur` |
| `expiresAt` | ISO-8601 datetime | no | Auto-expires if no terminal state by then |

**Request example**

```bash
curl -X POST http://localhost:3000/v1/intents \
  -H "Authorization: Bearer sk_live_abc..." \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{
    "userId": "usr_123",
    "query": "Sony WH-1000XM5 headphones",
    "maxBudget": 30000,
    "currency": "eur"
  }'
```

**Response 201**

```json
{
  "intentId": "cl123abc...",
  "status": "SEARCHING",
  "createdAt": "2026-04-21T10:00:00.000Z"
}
```

**Error table**

| Status | When | Body shape |
|---|---|---|
| 400 | Missing `X-Idempotency-Key` | `{ "error": "X-Idempotency-Key header is required" }` |
| 400 | Body fails Zod validation | `{ "error": "Invalid input", "details": [...] }` |
| 401 | Missing / invalid bearer key | `{ "error": "Unauthorized: ..." }` |
| 429 | Rate-limited | `{ "statusCode": 429, "error": "rate_limit_exceeded", "message": "Too many requests. Please retry after ...", "retryAfter": 42 }` |

### `GET /v1/intents/:intentId`

Fetch an intent and its full audit history.

| | |
|---|---|
| Auth | `Authorization: Bearer <api-key>` |
| Scope | The caller must own the intent (403 otherwise) |

**Response 200**

```json
{
  "intent": {
    "id": "cl123abc",
    "userId": "usr_123",
    "query": "Sony WH-1000XM5",
    "status": "DONE",
    "maxBudget": 30000,
    "currency": "eur",
    "virtualCard": { "id": "vc_...", "last4": "4242", "cancelledAt": "..." },
    "auditEvents": [
      { "event": "INTENT_CREATED", "actor": "system", "agentId": null, "createdAt": "..." },
      { "event": "QUOTE_RECEIVED",  "actor": "ag_abc", "agentId": "ag_abc", "createdAt": "..." },
      { "event": "USER_APPROVED",   "actor": "usr_123","agentId": null, "createdAt": "..." },
      { "event": "CHECKOUT_SUCCEEDED", "actor": "ag_abc", "agentId": "ag_abc", "createdAt": "..." }
    ]
  }
}
```

**Error table**

| Status | When |
|---|---|
| 401 | Missing / invalid bearer key |
| 403 | Intent belongs to a different user |
| 404 | `Intent not found: <id>` |

See the [state machine](../README.md#intent-state-machine) for the full list of possible `status` and `event` values.

---

## Approvals

### `POST /v1/approvals/:intentId/decision`

Approve or deny a pending intent. On approval this route:
1. Checks the Stripe Issuing balance.
2. Records the decision.
3. Reserves funds in a ledger pot (deducts from `user.mainBalance`).
4. Issues a restricted Stripe virtual card.
5. Transitions `APPROVED → CARD_ISSUED → CHECKOUT_RUNNING` and enqueues the checkout job.

| | |
|---|---|
| Auth | `Authorization: Bearer <api-key>` |
| Idempotency | **Required**: `X-Idempotency-Key: <uuid>` |
| Rate limit | 5 req / minute per API key + IP |
| Valid state | Intent must be `AWAITING_APPROVAL` |

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `decision` | `"APPROVED"` \| `"DENIED"` | yes | |
| `reason` | string | no | Free-text reason recorded on the audit trail |

**Request example**

```bash
curl -X POST http://localhost:3000/v1/approvals/cl123abc/decision \
  -H "Authorization: Bearer sk_live_abc..." \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H "Content-Type: application/json" \
  -d '{ "decision": "APPROVED" }'
```

**Response 200**

```json
{ "intentId": "cl123abc", "decision": "APPROVED", "status": "CHECKOUT_RUNNING" }
```

**Error table**

| Status | When |
|---|---|
| 400 | Missing `X-Idempotency-Key` / body fails validation |
| 401 | Missing / invalid bearer key |
| 403 | Intent belongs to a different user |
| 404 | `Intent not found: <id>` |
| 409 | `Intent is not in AWAITING_APPROVAL state (current: <status>)` |
| 422 | `InsufficientFundsError` or `InsufficientIssuingBalanceError` |

---

## Agent API

All `/v1/agent/*` routes require `X-Worker-Key` and should send `X-Agent-Id` so
the agent is attributed in audit events and logs.

### `POST /v1/agent/register`

Register an OpenClaw instance and obtain a short-lived pairing code the user
types into the Telegram bot to link their account.

| | |
|---|---|
| Auth | `X-Worker-Key` |
| Rate limit | 3 req / 10 minutes per IP |
| Body | `{ "agentId"?: "<existing ag_...>" }` |

- Omit `agentId` on first call: a fresh `ag_...` and pairing code are issued.
- Pass an existing unlinked `agentId` to renew the pairing code (5-minute cooldown per agent).

**Response 200**

```json
{ "agentId": "ag_abc...", "pairingCode": "K2N4PQR9", "expiresAt": "2026-04-21T10:10:00.000Z" }
```

**Error table**

| Status | When |
|---|---|
| 400 | Invalid body |
| 401 | Missing / wrong worker key |
| 404 | Supplied `agentId` does not exist |
| 409 | Agent is already linked to a user — registration not needed |
| 429 | Cooldown or IP rate limit hit |

### `GET /v1/agent/user`

Resolve the `userId` an agent is paired with (poll this after signup).

| | |
|---|---|
| Auth | `X-Worker-Key` + `X-Agent-Id` |

**Responses**

```json
{ "status": "unclaimed" }
{ "status": "claimed", "userId": "usr_123" }
```

| Status | When |
|---|---|
| 400 | Missing `X-Agent-Id` header |
| 401 | Missing / wrong worker key |
| 404 | Agent not found |

### `POST /v1/agent/quote`

Post a merchant search result for a `SEARCHING` intent. The orchestrator
transitions `SEARCHING → QUOTED → AWAITING_APPROVAL` and fires a Telegram
notification to the user.

| | |
|---|---|
| Auth | `X-Worker-Key` (+ `X-Agent-Id` for attribution) |
| Valid state | Intent must be `SEARCHING` |

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `intentId` | string | yes | |
| `merchantName` | string | yes | Human-readable merchant name |
| `merchantUrl` | URL | yes | Product page or merchant URL |
| `price` | int > 0 | yes | Quoted total in minor units |
| `currency` | 3-letter ISO code | no | Defaults to `gbp` |

**Response 200**

```json
{ "intentId": "cl123abc", "status": "AWAITING_APPROVAL" }
```

**Error table**

| Status | When |
|---|---|
| 400 | Invalid input |
| 401 | Missing / wrong worker key |
| 404 | Intent not found |
| 409 | `Intent must be in SEARCHING state (current: <status>)` |

### `GET /v1/agent/decision/:intentId`

Poll for the user's decision and fetch checkout parameters. Safe to call in a loop.

| | |
|---|---|
| Auth | `X-Worker-Key` (+ `X-Agent-Id`) |

**Possible responses**

```json
{ "intentId": "cl123abc", "status": "AWAITING_APPROVAL" }
{ "intentId": "cl123abc", "status": "DENIED" }
{ "intentId": "cl123abc", "status": "APPROVED",
  "checkout": { "intentId": "cl123abc", "amount": 27999, "currency": "eur" } }
```

`status` is reported as `APPROVED` throughout the `CARD_ISSUED`, `CHECKOUT_RUNNING`, and `DONE` states so the agent's decision loop can idempotently resume. `checkout.amount` is the quoted `price` when available, otherwise `maxBudget`.

| Status | When |
|---|---|
| 401 | Missing / wrong worker key |
| 404 | Intent not found |

### `GET /v1/agent/card/:intentId`

One-time raw card reveal (PAN + CVC + expiry). Calling this a second time
always fails with `409`. Prefer the `decision` → `POST /v1/checkout/simulate`
flow where possible; card reveal is only for the "agent types card into real
merchant checkout" path.

| | |
|---|---|
| Auth | `X-Worker-Key` (+ `X-Agent-Id`) |
| Rate limit | 2 req / minute per `intentId` |

**Response 200**

```json
{ "intentId": "cl123abc", "number": "4242424242424242", "cvc": "123", "expMonth": 12, "expYear": 2029 }
```

| Status | When |
|---|---|
| 401 | Missing / wrong worker key |
| 404 | No card for intent |
| 409 | `Card has already been revealed` |
| 429 | Reveal rate limit hit |

### `POST /v1/agent/result`

Report checkout outcome. On success: settle ledger, cancel card, transition to
`DONE`. On failure: return funds, cancel card, transition to `FAILED`.

| | |
|---|---|
| Auth | `X-Worker-Key` (+ `X-Agent-Id`) |
| Valid state | Intent must be `CHECKOUT_RUNNING` |

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `intentId` | string | yes | |
| `success` | boolean | yes | |
| `actualAmount` | int ≥ 0 | no | Captured amount in minor units (settled if `success`) |
| `receiptUrl` | URL | no | Stored on `intent.metadata` |
| `errorMessage` | string | no | Stored on `intent.metadata` on failure |

**Response 200**

```json
{ "intentId": "cl123abc", "status": "DONE" }
{ "intentId": "cl123abc", "status": "FAILED" }
```

| Status | When |
|---|---|
| 400 | Invalid body |
| 401 | Missing / wrong worker key |
| 404 | Intent not found |
| 409 | `Intent must be in CHECKOUT_RUNNING state (current: <status>)` |

---

## Checkout simulation

### `POST /v1/checkout/simulate`

Simulates a merchant charging the restricted Stripe virtual card. Used by the
stub worker and by agents in test mode. No auth: the card's own spending
controls are the security boundary.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `intentId` | string | yes | Server resolves `intentId → VirtualCard → stripeCardId` internally |
| `amount` | int > 0, ≤ 1,000,000 | yes | Amount to charge in minor units |
| `currency` | 3-letter ISO code | no | Defaults to `eur` |
| `merchantName` | string (≤ 200) | no | Defaults to `"Simulated Merchant"` |

**Responses**

| Status | Body |
|---|---|
| 200 | `{ "success": true, "chargeId": "iauth_...", "amount": 27999, "currency": "eur" }` |
| 402 | `{ "success": false, "declineCode": "spending_controls", "message": "..." }` |
| 400 | `{ "error": "Invalid input", "details": [...] }` |
| 500 | `{ "error": "Unexpected error during checkout simulation" }` |

---

## Webhooks

### `POST /v1/webhooks/stripe`

Receives Stripe events. The raw body is preserved for signature verification
via `stripe.webhooks.constructEvent()`. Always returns HTTP 200 to Stripe to
avoid unnecessary retries (errors are logged).

| | |
|---|---|
| Auth | `Stripe-Signature` header verified against `STRIPE_WEBHOOK_SECRET` |
| Rate limit | 500 req / minute per IP |

**Events handled**

| Event | Action |
|---|---|
| `issuing_authorization.request` | Returns `{ "approved": true }` inside the 2s Stripe authorization window; emits `STRIPE_AUTHORIZATION_REQUEST` audit event |
| `issuing_authorization.created` | Emits `STRIPE_AUTHORIZATION_CREATED` |
| `issuing_transaction.created` | Emits `STRIPE_TRANSACTION_CREATED`; cancels the card if the user's `cancelPolicy` is `ON_TRANSACTION`; fires background reconciliation |

**Response** always includes the `Stripe-Version: 2024-06-20` header (required for Stripe to accept `issuing_authorization.request` responses).

| Status | When |
|---|---|
| 400 | Missing `stripe-signature` header |
| 200 | Event accepted (even on downstream processing errors) |

### `POST /v1/webhooks/telegram`

Receives Telegram bot updates (messages, callback queries).

| | |
|---|---|
| Auth | `X-Telegram-Bot-Api-Secret-Token` must equal `TELEGRAM_WEBHOOK_SECRET` |
| Rate limit | 200 req / minute per IP |

**Response 200**

```json
{ "received": true }
```

| Status | When |
|---|---|
| 200 | Update accepted (downstream handler failures are logged) |
| 401 | Secret token missing or wrong |

---

## Users

### `GET /v1/users/me`

Get the authenticated user's profile.

| | |
|---|---|
| Auth | `Authorization: Bearer <api-key>` |

**Response 200**

```json
{
  "id": "usr_123",
  "email": "demo@agentpay.dev",
  "mainBalance": 100000,
  "maxBudgetPerIntent": 50000,
  "createdAt": "2026-04-01T09:00:00.000Z"
}
```

### `POST /v1/users/:userId/unlink-agent`

Unlink the authenticated user from their OpenClaw agent. Cancels every active
intent (`RECEIVED`…`CHECKOUT_RUNNING`), invalidates the pairing code, and writes
an `AGENT_UNLINKED` audit event.

| | |
|---|---|
| Auth | `Authorization: Bearer <api-key>` |
| Scope | `:userId` must match the authenticated user |

**Response 200**

```json
{ "unlinked": true, "agentId": "ag_abc", "cancelledIntentIds": ["cl...1", "cl...2"] }
```

| Status | When |
|---|---|
| 401 | Missing / invalid bearer key |
| 403 | `:userId` differs from authenticated user |
| 404 | User has no linked agent |

### `PATCH /v1/users/:userId/preferences`

Update card-cancel policy and optional TTL. Currently internal / Telegram-callback driven — no auth enforced.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `cancelPolicy` | `ON_TRANSACTION` \| `IMMEDIATE` \| `AFTER_TTL` \| `MANUAL` | no | |
| `cardTtlMinutes` | int 1–10080, or `null` | no | Only allowed when `cancelPolicy === AFTER_TTL` |

**Response 200**

```json
{ "userId": "usr_123", "cancelPolicy": "ON_TRANSACTION", "cardTtlMinutes": null }
```

| Status | When |
|---|---|
| 400 | Zod error or `cardTtlMinutes can only be set when cancelPolicy is AFTER_TTL` |
| 404 | User not found |

### `POST /v1/users/:userId/link-telegram`

Persist a Telegram `chatId` on the user so the bot can send approval
notifications.

**Request body**

```json
{ "telegramChatId": "1234567890" }
```

**Response 200**

```json
{ "userId": "usr_123", "telegramChatId": "1234567890", "linked": true }
```

| Status | When |
|---|---|
| 400 | Invalid body |
| 404 | `User not found: <id>` |

---

## Debug / observability

These routes exist for local development and dashboards. They are not
authenticated; deploy behind an internal-only path in any shared environment.

### `GET /v1/debug/intents`

List the 100 most recent intents.

```json
{ "intents": [
  { "id": "cl...", "userId": "usr_...", "query": "...", "status": "DONE",
    "createdAt": "...", "updatedAt": "...", "expiresAt": null }
] }
```

### `GET /v1/debug/ledger/:userId`

Full ledger, pot, and balance history for one user.

```json
{
  "user": { "email": "demo@agentpay.dev", "mainBalance": 99500 },
  "ledgerEntries": [ { "type": "RESERVE", "amount": 5000, "createdAt": "..." }, ... ],
  "pots": [ { "intentId": "cl...", "reservedAmount": 5000, "settledAmount": 4200, "status": "SETTLED" } ]
}
```

### `GET /v1/debug/audit/:intentId`

Full audit trail for a single intent, plus the intent snapshot. Each event
includes `actor`, `agentId`, `event`, and `payload`.

```json
{
  "intent": { "id": "cl123", "status": "DONE", ... },
  "auditEvents": [
    { "event": "INTENT_CREATED",   "actor": "system",     "agentId": null,    "payload": {...} },
    { "event": "QUOTE_RECEIVED",   "actor": "ag_abc",     "agentId": "ag_abc","payload": {...} },
    { "event": "APPROVAL_REQUESTED","actor":"ag_abc",     "agentId": "ag_abc","payload": {} },
    { "event": "USER_APPROVED",    "actor": "usr_123",    "agentId": null,    "payload": {"reason":null} },
    { "event": "CARD_ISSUED",      "actor": "system",     "agentId": null,    "payload": {} },
    { "event": "CHECKOUT_SUCCEEDED","actor":"ag_abc",     "agentId": "ag_abc","payload": {"actualAmount": 27999} }
  ]
}
```

### `GET /v1/debug/jobs`

Placeholder for BullMQ queue depths (not yet wired). Returns a stub object.

### `GET /health`

Liveness probe. Always returns 200 with:

```json
{ "status": "ok", "timestamp": "2026-04-21T10:00:00.000Z" }
```

---

## Error reference

Every error response carries the `{ "error": string, ["details": ...] }` envelope.

| HTTP status | Typical meaning | Common triggers |
|---|---|---|
| 400 | Bad request — client-side problem | Missing `X-Idempotency-Key`, malformed JSON, Zod validation failure (with `details`) |
| 401 | Unauthorized | Missing / invalid `Authorization: Bearer` key; missing / wrong `X-Worker-Key`; bad Stripe/Telegram webhook signature |
| 402 | Payment required | `POST /v1/checkout/simulate` — Stripe Issuing declined (`{ success:false, declineCode, message }`) |
| 403 | Forbidden | User API key does not own the requested resource |
| 404 | Not found | `Intent not found: <id>`, `No card found for intent: <id>`, `User not found`, `Agent not found: <id>` |
| 409 | Conflict | Intent is in the wrong state for the operation; `Card has already been revealed`; `Agent already has a linked user` |
| 422 | Unprocessable | `InsufficientFundsError`, `InsufficientIssuingBalanceError` |
| 429 | Rate-limited | Global 60 req/min + per-route limits (card reveal 2/min per intent, `POST /v1/agent/register` 3/10min per IP, approvals 5/min per key) |
| 500 | Server error | Unhandled exception — server logs will have a stack trace |

Typed domain errors live in [`src/contracts/errors.ts`](../src/contracts/errors.ts); mapping to HTTP status is done by each route handler.

---

## Integration walkthrough

Full happy-path example against a local dev server. Copy and paste to verify
your environment end-to-end. You need the dev server (`npm run dev`) and the
stub worker (`npm run worker`) running, a seeded demo user, and its API key.

```bash
#!/usr/bin/env bash
set -euo pipefail

BASE="http://localhost:3000"
API_KEY="${API_KEY:?export API_KEY=<bearer token returned by Telegram signup>}"
WORKER_KEY="${WORKER_API_KEY:-local-dev-worker-key}"
AGENT_ID="${AGENT_ID:-ag_walkthrough}"

auth_user() { printf 'Authorization: Bearer %s' "$API_KEY"; }
auth_agent() { printf 'X-Worker-Key: %s\nX-Agent-Id: %s' "$WORKER_KEY" "$AGENT_ID"; }

echo "=> 1. Create intent"
INTENT_JSON=$(curl -sS -X POST "$BASE/v1/intents" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H "$(auth_user)" \
  -d '{"query":"Sony WH-1000XM5","maxBudget":30000,"currency":"eur"}')
echo "$INTENT_JSON" | tee /dev/stderr
INTENT_ID=$(node -e "console.log(JSON.parse(process.argv[1]).intentId)" "$INTENT_JSON")

echo "=> 2. Agent posts a quote"
curl -sS -X POST "$BASE/v1/agent/quote" \
  -H "Content-Type: application/json" \
  -H "X-Worker-Key: $WORKER_KEY" \
  -H "X-Agent-Id: $AGENT_ID" \
  -d "{\"intentId\":\"$INTENT_ID\",\"merchantName\":\"Amazon DE\",\"merchantUrl\":\"https://amazon.de/dp/XXX\",\"price\":27999,\"currency\":\"eur\"}"

echo "=> 3. User approves"
curl -sS -X POST "$BASE/v1/approvals/$INTENT_ID/decision" \
  -H "Content-Type: application/json" \
  -H "X-Idempotency-Key: $(uuidgen)" \
  -H "$(auth_user)" \
  -d '{"decision":"APPROVED"}'

echo "=> 4. Agent polls decision + checkout params"
curl -sS -H "X-Worker-Key: $WORKER_KEY" -H "X-Agent-Id: $AGENT_ID" \
  "$BASE/v1/agent/decision/$INTENT_ID"

echo "=> 5. Agent simulates checkout"
curl -sS -X POST "$BASE/v1/checkout/simulate" \
  -H "Content-Type: application/json" \
  -d "{\"intentId\":\"$INTENT_ID\",\"amount\":27999,\"currency\":\"eur\",\"merchantName\":\"Amazon DE\"}"

echo "=> 6. Agent reports result"
curl -sS -X POST "$BASE/v1/agent/result" \
  -H "Content-Type: application/json" \
  -H "X-Worker-Key: $WORKER_KEY" \
  -H "X-Agent-Id: $AGENT_ID" \
  -d "{\"intentId\":\"$INTENT_ID\",\"success\":true,\"actualAmount\":27999}"

echo "=> 7. Inspect audit trail"
curl -sS "$BASE/v1/debug/audit/$INTENT_ID"
```

At the end, the `auditEvents` array contains every state transition, with
`agentId` populated for every step driven by the agent.

---

## Keeping this document in sync

Whenever you add or change a route in [`src/api/routes/`](../src/api/routes)
or a schema in [`src/api/validators/`](../src/api/validators), update this file
in the same pull request. See [CONTRIBUTING.md](../CONTRIBUTING.md) for the
full contributor checklist.
