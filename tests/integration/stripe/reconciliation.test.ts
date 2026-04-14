/**
 * Integration test — Ledger-to-Stripe reconciliation
 *
 * Requires STRIPE_SECRET_KEY (real test-mode key) and a running PostgreSQL
 * instance (docker compose up -d).
 *
 * Run with:
 *   npm run test:integration -- --testPathPattern=reconciliation
 */

import Stripe from 'stripe';
import { prisma } from '@/db/client';
import { reconcileIntent } from '@/payments/providers/stripe/reconciliationService';

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const describeIfStripe =
  STRIPE_KEY && !STRIPE_KEY.includes('placeholder') ? describe : describe.skip;

let stripe: Stripe;
let cardId: string;
let intentId: string;
let userId: string;

describeIfStripe('Reconciliation integration', () => {
  beforeAll(async () => {
    stripe = new Stripe(STRIPE_KEY!, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });

    // Create minimal DB records
    const user = await prisma.user.create({
      data: {
        email: `recon-test-${Date.now()}@example.com`,
        telegramChatId: null,
        stripeCardholderId: null,
      },
    });
    userId = user.id;

    const intent = await prisma.purchaseIntent.create({
      data: {
        userId,
        query: 'reconciliation test product',
        maxBudget: 5000,
        currency: 'gbp',
        status: 'DONE',
      },
    });
    intentId = intent.id;

    // Create Stripe cardholder and card
    const cardholder = await stripe.issuing.cardholders.create({
      name: 'Recon Test',
      email: `recon-stripe-${Date.now()}@example.com`,
      phone_number: '+15555555555',
      type: 'individual',
      individual: {
        first_name: 'Recon',
        last_name: 'Test',
        dob: { day: 1, month: 1, year: 1980 },
      },
      billing: {
        address: { line1: '1 Test St', city: 'London', postal_code: 'EC1A 1BB', country: 'GB' },
      },
    });

    const card = await stripe.issuing.cards.create({
      cardholder: cardholder.id,
      currency: 'eur',
      type: 'virtual',
      status: 'active',
      spending_controls: {
        spending_limits: [{ amount: 5000, interval: 'per_authorization' }],
      },
      metadata: { intentId },
    });
    cardId = card.id;

    // Write VirtualCard to DB
    await prisma.virtualCard.create({
      data: { intentId, stripeCardId: cardId, last4: card.last4 },
    });

    // Simulate a capture
    const auth = await stripe.testHelpers.issuing.authorizations.create({
      card: cardId,
      amount: 3500,
      currency: 'eur',
      merchant_data: { name: 'Test Merchant' },
    });
    await stripe.testHelpers.issuing.authorizations.capture(auth.id);

    // Cancel the card (mirrors what the system does post-checkout)
    await stripe.issuing.cards.update(cardId, { status: 'canceled' });

    // Write matching ledger records
    await prisma.pot.create({
      data: { intentId, reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' },
    });
    await prisma.ledgerEntry.create({
      data: { intentId, type: 'RESERVE', amount: 5000 },
    });
    await prisma.ledgerEntry.create({
      data: { intentId, type: 'SETTLE', amount: 3500 },
    });
  }, 60_000);

  afterAll(async () => {
    // Clean up DB records (cascade delete via purchaseIntent)
    await prisma.purchaseIntent.delete({ where: { id: intentId } }).catch(() => {});
    await prisma.user.delete({ where: { id: userId } }).catch(() => {});
    await prisma.$disconnect();
  });

  it('returns inSync:true when ledger matches Stripe captured amount', async () => {
    const report = await reconcileIntent(intentId);

    expect(report.inSync).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.stripe).not.toBeNull();
    expect(report.stripe?.totalCaptured).toBeGreaterThan(0);
  });

  it('returns inSync:false with discrepancy when settledAmount is wrong', async () => {
    // Corrupt the pot
    await prisma.pot.update({
      where: { intentId },
      data: { settledAmount: 9999 },
    });

    const report = await reconcileIntent(intentId);

    expect(report.inSync).toBe(false);
    expect(report.discrepancies.some((d) => d.includes('9999'))).toBe(true);

    // Restore
    await prisma.pot.update({
      where: { intentId },
      data: { settledAmount: 3500 },
    });
  });
});
