/**
 * Integration test: Stripe Issuing card lifecycle + checkout simulation
 *
 * Uses real PostgreSQL and real Stripe test mode. No mocks for Stripe or DB.
 *
 * Three groups of assertions:
 *
 * 1. Card issuance + reveal — verifies issueVirtualCard() and revealCard()
 *    produce a real Stripe Issuing card with the right spending controls.
 *
 * 2. Spending controls enforcement — uses stripe.testHelpers.issuing.authorizations
 *    to attempt a charge above the card limit. Does NOT require raw card data
 *    API access. Shows up in Stripe Dashboard → Issuing → Authorizations.
 *
 * 3. runSimulatedCheckout — the full PaymentMethod + PaymentIntent path.
 *    Requires "raw card data APIs" to be enabled on the Stripe test account
 *    (Settings → Account settings). Tests are skipped with a warning when
 *    this is not the case; all other tests still run.
 *
 * NOTE: The Stripe test mode 2-second webhook window means the full Issuing
 * success path (charge within limit) requires the webhook server to be running.
 * That path is covered by the manual E2E test in docs/openclaw.md.
 *
 * Requires: running Postgres, STRIPE_SECRET_KEY=sk_test_*
 * Skipped otherwise.
 *
 * Run: npm run test:integration -- --testPathPattern=checkoutSimulator
 */

import { prisma } from '@/db/client';
import { getRedisClient, disconnectRedis } from '@/config/redis';
import { createStripeProvider } from '@/payments/testHelpers';
import { IntentStatus } from '@/contracts';

const stripeCtx = createStripeProvider();

// Don't send real Telegram messages during tests
jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: () => ({
    api: {
      sendMessage: jest.fn().mockResolvedValue({ message_id: 1 }),
      answerCallbackQuery: jest.fn().mockResolvedValue(undefined),
      editMessageText: jest.fn().mockResolvedValue(undefined),
    },
  }),
}));

jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn().mockResolvedValue(undefined),
  enqueueCheckout: jest.fn().mockResolvedValue(undefined),
}));

const hasStripeKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');
const testSuite = hasStripeKey ? describe : describe.skip;

const RUN_ID = Date.now();

afterAll(async () => {
  await prisma.$disconnect();
  disconnectRedis();
});

testSuite('Stripe Issuing card lifecycle + checkout simulation', () => {
  let userId: string;
  let intentId: string;
  let stripeCardId: string;
  let credentials: {
    number: string;
    cvc: string;
    expMonth: number;
    expYear: number;
    last4: string;
  };

  beforeAll(async () => {
    // RUN_ID = Date.now() is unique per run, so no stale data cleanup needed.
    // afterAll() cleans up everything we create here.

    // Create a minimal test user (€10 000 balance, €500 per-intent cap)
    const user = await prisma.user.create({
      data: {
        email: `checkout-sim-${RUN_ID}@example.com`,
        mainBalance: 1_000_000,
        maxBudgetPerIntent: 50_000,
      },
    });
    userId = user.id;

    // Create a purchase intent with a €1 (100 cent) budget — intentionally tiny
    // to make the spending controls decline test reliable.
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId,
        query: 'Checkout simulator integration test',
        maxBudget: 100,
        currency: 'eur',
        status: IntentStatus.CARD_ISSUED,
        metadata: {},
        idempotencyKey: `checkout-sim-${RUN_ID}`,
      },
    });
    intentId = intent.id;

    // Issue the virtual card via Stripe Issuing (real API call)
    await stripeCtx.provider.issueCard(intentId, 100, 'eur');

    const card = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
    stripeCardId = card.stripeCardId;

    // Reveal credentials once — stored for all tests in this suite
    const reveal = await stripeCtx.provider.revealCard(intentId);
    credentials = {
      number: reveal.number,
      cvc: reveal.cvc,
      expMonth: reveal.expMonth,
      expYear: reveal.expYear,
      last4: reveal.last4,
    };
  });

  afterAll(async () => {
    await prisma.virtualCard.deleteMany({ where: { intentId } });
    await prisma.purchaseIntent.deleteMany({ where: { id: intentId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // ─── 1. Card issuance + reveal ──────────────────────────────────────────────

  describe('card issuance and reveal', () => {
    it('persists the card in DB with stripeCardId and last4 (no PAN/CVC stored)', async () => {
      const card = await prisma.virtualCard.findUnique({ where: { intentId } });
      expect(card).not.toBeNull();
      expect(card!.stripeCardId).toMatch(/^ic_/);
      expect(card!.last4).toHaveLength(4);
      expect(card!.revealedAt).not.toBeNull();
      // Confirm PAN is not in the DB row
      expect(card).not.toHaveProperty('number');
      expect(card).not.toHaveProperty('cvc');
    });

    it('reveals a 16-digit card number and valid CVC', () => {
      expect(credentials.number).toMatch(/^\d{16}$/);
      expect(credentials.cvc).toMatch(/^\d{3,4}$/);
      expect(credentials.last4).toBe(credentials.number.slice(-4));
    });

    it('reveal returns a future expiry date', () => {
      expect(credentials.expMonth).toBeGreaterThanOrEqual(1);
      expect(credentials.expMonth).toBeLessThanOrEqual(12);
      expect(credentials.expYear).toBeGreaterThanOrEqual(new Date().getFullYear());
    });

    it('card appears in Stripe as a virtual card with the correct spending limit', async () => {
      const stripeCard = await stripeCtx.stripe.issuing.cards.retrieve(stripeCardId);

      expect(stripeCard.type).toBe('virtual');
      expect(stripeCard.status).toBe('active');
      expect(stripeCard.last4).toBe(credentials.last4);
      expect(stripeCard.spending_controls.spending_limits[0].amount).toBe(100);
      expect(stripeCard.spending_controls.spending_limits[0].interval).toBe('per_authorization');
    });
  });

  // ─── 2. Spending controls enforcement (via Stripe test helpers) ─────────────
  //
  // stripe.testHelpers.issuing.authorizations.create works without raw card
  // data API access. It creates a real authorization visible in the dashboard.

  describe('spending controls enforcement', () => {
    beforeAll(async () => {
      // Stripe test mode: freshly created individual cardholders need ~2s for
      // their verification state to settle. Without this wait, the first 1-2
      // authorizations are declined with cardholder_verification_required
      // regardless of spending limit or verification_data provided.
      await new Promise((r) => setTimeout(r, 3000));
    });

    it('declines a test authorization that exceeds the €1 spending limit', async () => {
      // Attempt €50 against a €1 limit — Stripe should decline immediately
      const auth = await stripeCtx.stripe.testHelpers.issuing.authorizations.create({
        card: stripeCardId,
        amount: 5000, // €50 — far exceeds the €1 limit
        currency: 'eur',
      });

      // Stripe declines spending-controls violations at authorization time
      expect(auth.approved).toBe(false);
      expect(auth.status).toBe('closed');
    });

    it('approves and captures a test authorization within the €1 spending limit', async () => {
      // Attempt €0.50 against a €1 limit — should be approved
      const auth = await stripeCtx.stripe.testHelpers.issuing.authorizations.create({
        card: stripeCardId,
        amount: 50, // €0.50 — within the €1 per_authorization limit
        currency: 'eur',
      });

      expect(auth.approved).toBe(true);
      expect(auth.status).toBe('pending');

      // Capture creates an issuing_transaction and settles the authorization
      const captured = await stripeCtx.stripe.testHelpers.issuing.authorizations.capture(auth.id);
      expect(captured.status).toBe('closed');
    });

  });

  // ─── 3. runSimulatedCheckout ─────────────────────────────────────────────────
  //
  // Uses stripe.testHelpers.issuing.authorizations.create + capture.
  // No raw card data APIs required — works on any standard Stripe test account.

  describe('runSimulatedCheckout via intentId (test helpers)', () => {
    it('declines when charge amount exceeds the spending limit', async () => {
      const result = await stripeCtx.runSimulatedCheckout({
        intentId,
        amount: 5000, // €50 against €1 card — should be declined
        currency: 'eur',
        merchantName: 'Integration Test Merchant',
      });

      expect(result.success).toBe(false);
      expect(result.declineCode).toBeDefined();
    });
  });
});
