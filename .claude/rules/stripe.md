# Stripe — Rules & Reference

This file applies to all agents working with Stripe. Agent 4 (Payments) must
fetch and read the four documentation pages listed below before writing any code.

## Documentation to read before coding (Agent 4)

Fetch these in order using WebFetch before writing any Stripe implementation:

1. https://docs.stripe.com/issuing/cards/virtual/issue-cards — cardholder + card issuance
2. https://docs.stripe.com/issuing/controls/spending-controls — limits, MCC restrictions
3. https://docs.stripe.com/issuing/purchases/authorizations — authorization webhook flow
4. https://docs.stripe.com/api/issuing/cards/object — full card object reference

---

## 1. Authentication

- API keys determine mode: `sk_test_*` = test, `sk_live_*` = production
- For this project always use `sk_test_*` from `STRIPE_SECRET_KEY` env var
- **For agent-facing integrations use restricted keys (`rk_*`)** — they scope the key
  to only the Stripe resources the agent needs. This is Stripe's primary recommended
  safety mechanism for agentic payment flows.
- Never embed API keys in source code. Always read from environment variables.
- Node.js SDK initialization:

```ts
import Stripe from 'stripe';
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: '2024-06-20',
});
```

---

## 2. Idempotency Keys

- Include `idempotencyKey` on all `POST` requests that create or mutate objects
- Use V4 UUIDs or another high-entropy random string (max 255 chars)
- Stripe saves the result of the first request and replays it for duplicates — safe for retries
- Keys are pruned after ~24 hours; reuse after pruning is treated as a new request
- **Parameter mismatch:** if the same key is reused with different parameters, Stripe returns a 409 — do not retry, this is a bug
- For this project: use `intentId` as the idempotency key for card issuance (one card per intent)

```ts
await stripe.issuing.cards.create(
  { cardholder: cardholderId, currency: 'gbp', type: 'virtual', spending_controls: { ... } },
  { idempotencyKey: intentId },
);
```

---

## 3. Error Handling

Stripe errors have a `type` field. Handle each category differently:

| Type | Cause | Action |
|------|-------|--------|
| `card_error` | Card declined, insufficient funds | Return error to user, do not retry |
| `invalid_request_error` | Bad parameters | Fix the request, do not retry |
| `idempotency_error` | Same key, different params | Bug — log and alert, do not retry |
| `api_error` | Stripe server issue (rare) | Retry with exponential backoff |

HTTP status codes:

| Code | Retryable? | Meaning |
|------|-----------|---------|
| 400 | No | Invalid parameters |
| 401 | No | Bad API key |
| 402 | Sometimes | Valid params, operation failed |
| 403 | No | Insufficient key permissions |
| 404 | No | Resource not found |
| 409 | No | Idempotency key conflict |
| 429 | Yes | Rate limited — use exponential backoff |
| 5xx | Yes | Stripe server error |

Always wrap Stripe calls in try/catch and log `error.type`, `error.code`, `error.message`:

```ts
try {
  const card = await stripe.issuing.cards.create({ ... });
} catch (err) {
  if (err instanceof Stripe.errors.StripeError) {
    logger.error({ type: err.type, code: err.code, message: err.message, intentId });
    throw err;
  }
  throw err;
}
```

---

## 4. Stripe Issuing — Card Issuance

### Cardholder is required first

A card cannot exist without a Cardholder. Upsert pattern — store `stripeCardholderId` on `User`:

```ts
const cardholder = await stripe.issuing.cardholders.create({
  name: 'Agent Buyer',
  email: user.email,
  type: 'individual',
  billing: {
    address: { line1: '1 Agent St', city: 'London', postal_code: 'EC1A 1BB', country: 'GB' },
  },
});
```

### Create a virtual card

```ts
const card = await stripe.issuing.cards.create(
  {
    cardholder: cardholder.id,
    currency: 'gbp',
    type: 'virtual',
    spending_controls: buildSpendingControls(budgetInPence, mccAllowlist),
  },
  { idempotencyKey: intentId },
);
```

### Retrieve card number (virtual cards — works in both test and live mode)

Card numbers are **not returned by default** — you must explicitly expand:

```ts
const card = await stripe.issuing.cards.retrieve(cardId, {
  expand: ['number', 'cvc'],
});
// card.number and card.cvc are now populated
```

Stripe allows server-side retrieval of `number` and `cvc` for **virtual cards** in both test
and live mode ([docs](https://docs.stripe.com/issuing/cards/virtual/issue-cards#retrieve-virtual-card-details)).
This restriction only applies to physical cards, which cannot be expanded in live mode.
Since this project only issues virtual cards, server-side expand is the correct approach.

Note: if generating virtual cards for end users, PCI-DSS Service Provider obligations may
apply. See Stripe's guidance on Issuing Elements for a PCI-scope-reducing alternative.

### Spending controls shape

```ts
function buildSpendingControls(amountInSmallestUnit: number, mccAllowlist?: string[]) {
  return {
    spending_limits: [
      { amount: amountInSmallestUnit, interval: 'per_authorization' as const },
    ],
    ...(mccAllowlist?.length ? { allowed_categories: mccAllowlist } : {}),
  };
}
```

- `amount` is in the **smallest currency unit** (pence for GBP, cents for USD)
- `interval: 'per_authorization'` caps a single checkout to the approved budget
- Other intervals: `daily`, `weekly`, `monthly`, `all_time`

### Freeze / cancel a card (kill switch)

```ts
await stripe.issuing.cards.update(cardId, { status: 'inactive' }); // freeze (reversible)
await stripe.issuing.cards.update(cardId, { status: 'canceled' }); // permanent
```

Once canceled, a card cannot be reactivated.

---

## 5. Stripe Issuing — Webhooks & Authorizations

### Raw body is required for signature verification

Fastify parses the body as JSON by default — this breaks `constructEvent`. Register a raw
body parser for the Stripe webhook route before any other content-type parser:

```ts
fastify.addContentTypeParser(
  'application/json',
  { parseAs: 'buffer' },
  (req, body, done) => done(null, body),
);

// In webhook route handler:
const event = stripe.webhooks.constructEvent(
  request.body as Buffer,
  request.headers['stripe-signature'] as string,
  process.env.STRIPE_WEBHOOK_SECRET!,
);
```

Never call `JSON.parse` on the body before passing it to `constructEvent`.

### Authorization request — 2-second response window

`issuing_authorization.request` is **synchronous** — Stripe waits up to 2 seconds for a
response. If no response is received, Stripe auto-declines. In test mode, auto-approve:

```ts
case 'issuing_authorization.request': {
  const auth = event.data.object as Stripe.Issuing.Authorization;
  await stripe.issuing.authorizations.approve(auth.id);
  await logAuditEvent(auth.metadata.intentId, 'STRIPE_AUTHORIZATION_APPROVED', auth);
  break;
}
```

### Other webhook events to handle

```ts
case 'issuing_authorization.created':
  // Authorization approved — log authorized amount to AuditEvent
  break;

case 'issuing_transaction.created':
  // Final transaction settled — log actual spend amount
  break;
```

Always respond `{ received: true }` with HTTP 200 after processing, even on errors —
otherwise Stripe retries the webhook.

---

## 6. Testing Stripe Issuing

### Simulate an authorization (no real card needed)

```ts
// Create a test authorization against an issued card
const auth = await stripe.testHelpers.issuing.authorizations.create({
  card: cardId,
  amount: 1000, // pence
  merchant_data: { name: 'Amazon UK', category: 'general_merchandise' },
});
```

### Capture a pending authorization

```ts
await stripe.testHelpers.issuing.authorizations.capture(auth.id);
// This generates an issuing_transaction and closes the authorization
```

Supports partial captures (amount less than authorized) and over-captures.

### Create a test purchase via Dashboard

In the Stripe Dashboard (test mode): select an issued card → "Create test purchase" →
choose authorization or forced-capture. Useful for manual QA.

### Test card numbers (for cardholder billing, not issued cards)

| Brand | Number |
|-------|--------|
| Visa | `4242 4242 4242 4242` |
| Mastercard | `5555 5555 5555 4444` |
| Amex | `3782 822463 10005` |

- CVC: any 3 digits (4 for Amex)
- Expiry: any future date (e.g. `12/34`)
- Never use real card numbers in tests

### Fund test balance (UK/EU sandbox)

```ts
// Use Funding Instructions API to top up test Issuing balance
const fundingInstructions = await stripe.issuing.fundingInstructions.create({
  bank_transfer: { type: 'gb_bank_account' },
  currency: 'gbp',
  funding_type: 'bank_transfer',
});
```

---

## 7. Agentic Safety (Stripe Agents guidance)

Stripe's official guidance for agent-facing integrations:

- **Use restricted API keys (`rk_*`)** scoped to only the Stripe resources the agent needs.
  This is the primary access control — an agent with a restricted key cannot perform
  operations outside its granted scope even if compromised.
- Deploy agent integrations in sandbox first; validate with evaluations before production.
- Agent behavior is non-deterministic — spending controls and restricted keys are the
  safety net, not trust in the agent's decisions.
- For this project: the `STRIPE_SECRET_KEY` is used server-side (not agent-facing).
  The agent (OpenClaw worker) never receives a Stripe API key — it only receives the
  virtual card credentials via the one-time card reveal endpoint.

---

## 8. What NOT to store in the database

| Data | Store? | Why |
|------|--------|-----|
| `card.number` (PAN) | Never | PCI compliance |
| `card.cvc` | Never | PCI compliance |
| `card.exp_month` / `exp_year` | Avoid | Not needed after reveal |
| `card.id` (Stripe card ID) | Yes | Needed for freeze/cancel |
| `card.last4` | Yes | Safe, useful for display |
| `cardholder.id` | Yes | Needed for upsert |
| Authorization ID | Yes | For webhook correlation |
| Transaction ID | Yes | For audit trail |
