# Stripe Issuing Setup Guide

This guide walks you through setting up Stripe Issuing from scratch — creating an account, enabling Issuing, funding your test balance, and configuring the webhook secret. Everything here uses **test/sandbox mode** — no real money is involved.

> **Time required:** ~10 minutes

---

## 1. Create a Stripe account

1. Go to [https://dashboard.stripe.com/register](https://dashboard.stripe.com/register)
2. Sign up with your email
3. After signup you land on the Dashboard — you are already in **test mode** (or a **Sandbox**)

> **Test mode vs Sandbox:** Stripe offers two testing environments. A **Sandbox** is an isolated test environment shown at the top-left of the Dashboard. **Test mode** is a toggle on your main account. Both work — the key difference is that Sandboxes require business verification before you can fund the Issuing balance. Either way, no real money is ever involved.

---

## 2. Get your API keys

1. Go to **Developers → API keys** ([dashboard.stripe.com/test/apikeys](https://dashboard.stripe.com/test/apikeys))
2. Copy the **Secret key** — it starts with `sk_test_...`
3. Add it to your `.env`:

```env
STRIPE_SECRET_KEY=sk_test_your_key_here
```

The publishable key (`pk_test_...`) is not needed for this project.

---

## 3. Enable Stripe Issuing

1. Go to [dashboard.stripe.com/test/issuing/overview](https://dashboard.stripe.com/test/issuing/overview)
2. Issuing activates automatically in test/sandbox mode
3. You should see **"Issuing"** in the left sidebar with tabs for Cards, Cardholders, Transactions, etc.

**Verify via API:**

```bash
curl -s -u "sk_test_YOUR_KEY:" "https://api.stripe.com/v1/issuing/cards?limit=1"
```

Expected: `{"object":"list","data":[],...}` — an empty list, no error.

If you get `"Your account is not set up to use Issuing"`, revisit the Issuing overview page and follow the activation prompts.

---

## 4. Complete business verification

Stripe requires basic business details before you can fund the Issuing balance — even in test mode. This is a one-time form with **placeholder data** (nothing is verified in test mode).

1. Go to **Settings → Account details** ([dashboard.stripe.com/test/settings/account](https://dashboard.stripe.com/test/settings/account))
2. Fill in:
   - **Business type:** Individual
   - **Name:** anything (e.g., `Test Developer`)
   - **Address:** any address (e.g., `123 Test St, Berlin, 10115, DE`)
   - **Date of birth:** any date (e.g., `01/01/1990`)
3. When asked to **add a payout account**, use a test IBAN:
   - Germany: `DE89370400440532013000`
   - UK: `GB29NWBK60161331926819`
4. Select any payout schedule (doesn't matter in test mode)
5. Save

> No real bank account is involved. This is purely test data to unlock the funding feature.

---

## 5. Fund the test Issuing balance

Without funds in the Issuing balance, card authorizations will be declined with `insufficient_funds`.

### Via the Dashboard (recommended)

1. Go to [dashboard.stripe.com/test/balance/overview](https://dashboard.stripe.com/test/balance/overview)
2. Scroll down to the **Issuing balance** section
3. Click **"Add to balance"**
4. Add a test amount (e.g., €1,000 or €10,000)

### Via the API (if available on your account)

```bash
curl -s -u "sk_test_YOUR_KEY:" \
  -d "amount=1000000" \
  -d "currency=eur" \
  "https://api.stripe.com/v1/test_helpers/issuing/fund_balance"
```

This adds €10,000 (1,000,000 cents) in fake money.

> **Note:** Some Sandbox accounts show `"Issuing top-ups of type sepa_credit_transfer cannot be done"` when using the API. This happens when business verification is incomplete. Complete step 4 first, then use the Dashboard method.

**Verify:**

```bash
curl -s -u "sk_test_YOUR_KEY:" "https://api.stripe.com/v1/balance"
```

Look for the `"issuing"` section — `amount` should be greater than 0:

```json
"issuing": {
  "available": [{ "amount": 1000000, "currency": "eur" }]
}
```

---

## 6. Create the webhook endpoint and get the signing secret

The webhook secret (`STRIPE_WEBHOOK_SECRET`) is used to verify that incoming webhook events actually come from Stripe.

### Option A: Via the API (quickest)

```bash
curl -s -u "sk_test_YOUR_KEY:" \
  -d "url=https://your-domain.com/v1/webhooks/stripe" \
  -d "enabled_events[]=issuing_authorization.created" \
  -d "enabled_events[]=issuing_transaction.created" \
  "https://api.stripe.com/v1/webhook_endpoints"
```

The response includes `"secret": "whsec_..."` — copy that value.

### Option B: Via the Stripe CLI (best for local development)

```bash
brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
```

The CLI prints the signing secret:

```
> Ready! Your webhook signing secret is whsec_abc123def456...
```

### Option C: Via the Dashboard

1. Go to [dashboard.stripe.com/test/webhooks](https://dashboard.stripe.com/test/webhooks)
2. Click **"Add endpoint"**
3. Enter your webhook URL (for production: `https://your-domain.com/v1/webhooks/stripe`)
4. Under **"Select events"**, add:
   - `issuing_authorization.created`
   - `issuing_transaction.created`
5. Click **"Add endpoint"**
6. On the endpoint page, click **"Reveal"** next to "Signing secret"

### Add to `.env`

```env
STRIPE_WEBHOOK_SECRET=whsec_your_secret_here
```

---

## 7. Real-time authorization endpoint (`issuing_authorization.request`)

`issuing_authorization.request` is a **synchronous** event — Stripe sends it when a charge attempt is made on your card and **waits up to 2 seconds** for your server to respond with `{ approved: true }` or `{ approved: false }`. If no response is received in time, Stripe declines the authorization.

### Critical: this is configured in Issuing Settings, not the Webhooks page

The real-time authorization endpoint is **not** configured under the regular Webhooks page. It lives in:

**Stripe Dashboard → Settings → Issuing → Realtime authorization**

(Or navigate directly: `dashboard.stripe.com/settings/issuing`)

After you configure the endpoint URL there, Stripe creates a **separate signing secret** for it. You can find this secret by going to **Developers → Webhooks** (`dashboard.stripe.com/webhooks`) — look for the Issuing endpoint in the list and click "Reveal" next to its signing secret.

### `stripe listen` does NOT work for real-time authorization

`stripe listen --forward-to localhost:3000/v1/webhooks/stripe` is **one-way**. It forwards events from Stripe to your local server but it cannot relay your server's response (`{ approved: true }`) back to Stripe within the 2-second synchronous window.

If you use `stripe listen` for sync auth, every authorization will be declined — Stripe never receives your approve response.

### Local development setup with ngrok

To test real-time authorization locally, you need a publicly-reachable tunnel:

```bash
# 1. Install ngrok and start a tunnel to your local server
ngrok http 3000
# Note the https URL, e.g. https://abc123.ngrok.io

# 2. Start your dev server
npm run dev

# 3. Register the tunnel URL in Stripe Dashboard → Settings → Issuing → Realtime authorization
#    URL: https://abc123.ngrok.io/v1/webhooks/stripe

# 4. Copy the signing secret from Dashboard → Developers → Webhooks (the Issuing endpoint)
#    and update your .env:
STRIPE_WEBHOOK_SECRET=whsec_the_issuing_endpoint_secret
```

> **Note:** The `Stripe-Version` response header is added automatically by the server (`webhooks.ts`). You do not need to configure this manually.

### For local development without real-time auth

If you are not testing the card authorization flow, skip the Issuing Settings endpoint entirely. Use `stripe listen` for the regular async events only:

```bash
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
# Handles: issuing_authorization.created, issuing_transaction.created
# Does NOT handle: issuing_authorization.request (sync auth)
```

---

## 8. Verify the full setup

Run these commands to confirm everything works:

```bash
# 1. Is Issuing enabled?
curl -s -u "sk_test_YOUR_KEY:" \
  "https://api.stripe.com/v1/issuing/cards?limit=1"
# Expected: {"object":"list","data":[],...}

# 2. Is the Issuing balance funded?
curl -s -u "sk_test_YOUR_KEY:" \
  "https://api.stripe.com/v1/balance"
# Expected: "issuing":{"available":[{"amount":1000000,...}]}

# 3. Can you create a cardholder?
curl -s -u "sk_test_YOUR_KEY:" \
  -d "name=Test User" \
  --data-urlencode "phone_number=+15555555555" \
  -d "email=test@example.com" \
  -d "type=individual" \
  -d "individual[first_name]=Test" \
  -d "individual[last_name]=User" \
  -d "individual[dob][day]=1" \
  -d "individual[dob][month]=1" \
  -d "individual[dob][year]=1990" \
  -d "billing[address][line1]=123 Test St" \
  -d "billing[address][city]=Berlin" \
  -d "billing[address][postal_code]=10115" \
  -d "billing[address][country]=DE" \
  "https://api.stripe.com/v1/issuing/cardholders"
# Expected: {"id":"ich_...","object":"issuing.cardholder",...}
```

---

## 9. Required `.env` variables

```env
STRIPE_SECRET_KEY=sk_test_...          # from Dashboard → Developers → API keys
STRIPE_WEBHOOK_SECRET=whsec_...        # from webhook endpoint creation (step 6)
```

Your `.env.example` already contains placeholders for both. Replace them with your actual values.

---

## 10. Running the integration tests

Once Stripe is set up, the integration tests that use real Stripe APIs will run:

```bash
# Full Stripe card lifecycle test
npm run test:integration -- --testPathPattern=checkoutSimulator

# Telegram approval + Stripe checkout flow
npm run test:integration -- --testPathPattern=telegramApprovalCheckout
```

Tests are automatically skipped when `STRIPE_SECRET_KEY` is not a `sk_test_*` key.

---

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `Your account is not set up to use Issuing` | Issuing not enabled | Go to [Dashboard → Issuing → Overview](https://dashboard.stripe.com/test/issuing/overview) |
| `You must verify your business before you can top up in test mode` | Business details not filled in | [Settings → Account details](https://dashboard.stripe.com/test/settings/account) → fill in placeholder data (step 4) |
| `insufficient_funds` on authorization | Issuing balance is €0 | [Dashboard → Balances](https://dashboard.stripe.com/test/balance/overview) → Issuing balance → Add to balance (step 5) |
| `webhook_timeout` on authorization | `issuing_authorization.request` subscribed but server is not reachable | Remove that event from the webhook endpoint, or make sure your server is running (step 7) |
| `webhook_error: "Invalid Stripe API version: "` | Real-time auth endpoint has no API version set, or server response is missing `Stripe-Version` header | The server sets this header automatically — ensure you are hitting the live server, not a mock |
| Auth declined with no `webhook_error` | Likely using `stripe listen` for sync auth — it is one-way and cannot relay the response back | Use an ngrok tunnel and register the URL in Dashboard → Settings → Issuing (step 7) |
| `reason: card_inactive` | Card was created but is not yet active | Wait a few seconds after card creation, or check that the cardholder has passed verification |
| `cardholder_phone_number_required` | Cardholder has no phone number | Include `phone_number` when creating a cardholder (the code in `cardService.ts` already does this) |
| `Issuing top-ups of type sepa_credit_transfer cannot be done` | Sandbox account, business not verified | Complete business verification (step 4), then fund via Dashboard |
| `Invalid API Key provided` | Wrong key or extra whitespace in `.env` | Double-check `STRIPE_SECRET_KEY` — no quotes, no trailing spaces |
| `Webhook signature verification failed` | `STRIPE_WEBHOOK_SECRET` doesn't match the endpoint | Re-create the webhook endpoint and copy the new `whsec_...` value |

---

## Further reading

- [Stripe Issuing documentation](https://docs.stripe.com/issuing)
- [Stripe Issuing testing guide](https://docs.stripe.com/issuing/testing)
- [Funding your Issuing balance](https://docs.stripe.com/issuing/adding-funds-to-your-card-program)
- [Stripe Issuing balance management](https://docs.stripe.com/issuing/funding/balance)
