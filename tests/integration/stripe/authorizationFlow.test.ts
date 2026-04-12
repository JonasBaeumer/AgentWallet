/**
 * Test B — Stripe testHelpers authorization smoke test
 *
 * Exercises stripe.testHelpers.issuing.authorizations.create() in isolation
 * to answer two questions:
 *
 *   Q1. Does Stripe auto-approve a test authorization when no webhook
 *       endpoint is responding? (Stripe docs say yes in test mode.)
 *
 *   Q2. When our local server IS responding with { approved: true } via
 *       stripe listen, does Stripe actually honour that response?
 *
 * These tests require STRIPE_SECRET_KEY to be set and call the real Stripe
 * test-mode API. They create and immediately close test resources.
 *
 * Run with:
 *   npm run test:integration -- --testPathPattern=authorizationFlow
 */

import Stripe from 'stripe';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;

// Skip entire suite if no real key is present (unit test environment)
const describeIfStripe =
  STRIPE_KEY && !STRIPE_KEY.includes('placeholder') ? describe : describe.skip;

let stripe: Stripe;
let cardholderId: string;
let cardId: string;

describeIfStripe('Stripe testHelpers authorization flow', () => {
  beforeAll(async () => {
    stripe = new Stripe(STRIPE_KEY!, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
    });

    // Create a minimal cardholder + active virtual card for the test
    const cardholder = await stripe.issuing.cardholders.create({
      name: 'Auth Flow Test',
      email: `auth-flow-test-${Date.now()}@example.com`,
      phone_number: '+15555555555',
      type: 'individual',
      individual: {
        first_name: 'Auth',
        last_name: 'Test',
        dob: { day: 1, month: 1, year: 1980 },
      },
      billing: {
        address: { line1: '1 Test St', city: 'London', postal_code: 'EC1A 1BB', country: 'GB' },
      },
    });
    cardholderId = cardholder.id;

    const card = await stripe.issuing.cards.create({
      cardholder: cardholderId,
      currency: 'eur',
      type: 'virtual',
      status: 'active',
      spending_controls: {
        spending_limits: [{ amount: 10000, interval: 'per_authorization' }],
      },
    });
    cardId = card.id;
  }, 30_000);

  afterAll(async () => {
    // Cancel the card to clean up
    if (cardId) {
      await stripe.issuing.cards.update(cardId, { status: 'canceled' }).catch(() => {});
    }
  });

  // ─── Q1: Default behaviour with no webhook endpoint ───────────────────────

  it('Q1: testHelpers.create() returns a defined authorization object', async () => {
    const auth = await stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: 1000,
      currency: 'eur',
      merchant_data: { name: 'Test Merchant' },
    });

    console.log('Q1 result — approved:', auth.approved, '| status:', auth.status);
    console.log('request_history:', JSON.stringify(auth.request_history));

    // The auth object must always be returned regardless of approval outcome
    expect(auth).toBeDefined();
    expect(auth.id).toMatch(/^iauth_/);
    expect(typeof auth.approved).toBe('boolean');
  });

  it('Q1: documents whether Stripe auto-approves when no webhook responds', async () => {
    const auth = await stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: 500,
      currency: 'eur',
      merchant_data: { name: 'Smoke Test Merchant' },
    });

    // Log the outcome so we can see the actual Stripe test-mode behaviour.
    // This test intentionally does NOT assert approved===true/false —
    // it is a discovery test to document what Stripe does by default.
    console.log('─── Q1 Stripe default behaviour ───');
    console.log('approved:', auth.approved);
    console.log('status:', auth.status);
    if (auth.request_history?.length) {
      for (const h of auth.request_history) {
        console.log('  history entry — reason:', h.reason, '| msg:', h.reason_message);
      }
    } else {
      console.log('request_history: (empty — no webhook error recorded)');
    }

    // Cancel it so it does not interfere with other tests
    await stripe.testHelpers.issuing.authorizations.expire(auth.id).catch(() => {});
  });

  // ─── Q2: Webhook endpoint response relay ──────────────────────────────────

  it('Q2: documents whether stripe listen relays { approved: true } back to Stripe', async () => {
    // This test requires stripe listen to be running AND our server to be
    // running on localhost:3000 with STRIPE_WEBHOOK_SECRET matching the
    // stripe listen secret. It logs the result without asserting, because
    // the outcome depends on external infrastructure.
    //
    // To use: run `stripe listen --forward-to localhost:3000/v1/webhooks/stripe`
    // and `npm run dev` before running this test.

    const auth = await stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: 750,
      currency: 'eur',
      merchant_data: { name: 'Webhook Relay Test' },
    });

    console.log('─── Q2 Webhook relay behaviour ───');
    console.log('approved:', auth.approved);
    console.log('status:', auth.status);
    if (auth.request_history?.length) {
      for (const h of auth.request_history) {
        console.log(
          '  history — reason:',
          h.reason,
          '| msg:',
          h.reason_message,
          '| approved:',
          h.approved,
        );
      }
    } else {
      console.log('request_history: (empty)');
    }

    if (auth.approved) {
      console.log('✓ stripe listen IS relaying the { approved: true } response back to Stripe');
    } else if (auth.request_history?.some((h: any) => h.reason === 'webhook_error')) {
      console.log('✗ webhook_error — server likely returned wrong response or signature mismatch');
    } else {
      console.log(
        '? auth declined but no webhook_error — Stripe may be ignoring the response body',
      );
    }

    await stripe.testHelpers.issuing.authorizations.expire(auth.id).catch(() => {});

    // Non-asserting: this test documents behaviour, it does not enforce it.
    expect(auth).toBeDefined();
  });
});
