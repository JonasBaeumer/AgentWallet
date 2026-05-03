/**
 * Integration test — Ledger-to-Stripe reconciliation
 *
 * Requires STRIPE_SECRET_KEY (real test-mode key) and a running PostgreSQL
 * instance (docker compose up -d).
 *
 * Run with:
 *   npm run test:integration -- --testPathPattern=reconciliation
 */

import crypto from 'crypto';
import Stripe from 'stripe';
import { prisma } from '@/db/client';
import { reconcileIntent } from '@/payments/providers/stripe/reconciliationService';
import { PaymentProvider } from '@/contracts';

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

    const user = await prisma.user.create({
      data: {
        email: `recon-test-${Date.now()}@example.com`,
        telegramChatId: null,
        providerCardholderId: null,
      },
    });
    userId = user.id;

    const intent = await prisma.purchaseIntent.create({
      data: {
        userId,
        query: 'reconciliation test product',
        maxBudget: 5000,
        currency: 'eur',
        status: 'DONE',
        idempotencyKey: `recon-test-${crypto.randomUUID()}`,
      },
    });
    intentId = intent.id;

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

    await prisma.virtualCard.create({
      data: {
        intentId,
        provider: PaymentProvider.STRIPE,
        providerCardId: cardId,
        last4: card.last4,
      },
    });

    // Simulate a captured transaction. We use createForceCapture (rather than
    // create+capture on an authorization) because the latter requires the
    // authorization to first be approved and pending — which in turn needs a
    // running webhook approver. Force-capture lets the test stay self-contained.
    await stripe.testHelpers.issuing.transactions.createForceCapture({
      card: cardId,
      amount: 3500,
      currency: 'eur',
      merchant_data: { name: 'Test Merchant' },
    });

    await stripe.issuing.cards.update(cardId, { status: 'canceled' });

    await prisma.pot.create({
      data: {
        userId,
        intentId,
        reservedAmount: 5000,
        settledAmount: 3500,
        status: 'SETTLED',
      },
    });
    await prisma.ledgerEntry.create({
      data: { userId, intentId, type: 'RESERVE', amount: 5000 },
    });
    await prisma.ledgerEntry.create({
      data: { userId, intentId, type: 'SETTLE', amount: 3500 },
    });
  }, 60_000);

  afterAll(async () => {
    // Clean up DB records in FK dependency order. The schema doesn't define
    // ON DELETE CASCADE, so each child table must be cleared explicitly.
    if (!intentId || !userId) return;
    await prisma.ledgerEntry.deleteMany({ where: { intentId } }).catch(() => {});
    await prisma.pot.deleteMany({ where: { intentId } }).catch(() => {});
    await prisma.virtualCard.deleteMany({ where: { intentId } }).catch(() => {});
    await prisma.purchaseIntent.deleteMany({ where: { id: intentId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: userId } }).catch(() => {});
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
    await prisma.pot.update({
      where: { intentId },
      data: { settledAmount: 9999 },
    });

    const report = await reconcileIntent(intentId);

    expect(report.inSync).toBe(false);
    expect(report.discrepancies.some((d) => d.includes('9999'))).toBe(true);

    await prisma.pot.update({
      where: { intentId },
      data: { settledAmount: 3500 },
    });
  });
});
