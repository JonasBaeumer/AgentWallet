/**
 * Integration test: full card lifecycle — issue, charge, settle, cancel, verify balances
 *
 * Three groups:
 *   1. Successful purchase: issue → reserve → charge → settle → cancel → verify surplus
 *   2. Failed purchase: issue → reserve → decline → return → cancel → verify refund
 *   3. Idempotency: double cancel and double return are safe no-ops
 *
 * Requires: running Postgres, STRIPE_SECRET_KEY=sk_test_*
 * Skipped otherwise.
 *
 * Run: npm run test:integration -- --testPathPattern=cardLifecycle
 */

import { prisma } from '@/db/client';
import { disconnectRedis } from '@/config/redis';
import { issueVirtualCard, cancelCard } from '@/payments/providers/stripe/cardService';
import { reserveForIntent, settleIntent, returnIntent } from '@/ledger/potService';
import { getStripeClient } from '@/payments/providers/stripe/stripeClient';
import { IntentStatus, PotStatus } from '@/contracts';

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
  enqueueCancelCard: jest.fn().mockResolvedValue(undefined),
}));

jest.setTimeout(60_000);

const STRIPE_KEY = process.env.STRIPE_SECRET_KEY;
const hasStripeKey =
  !!STRIPE_KEY && STRIPE_KEY.startsWith('sk_test_') && !STRIPE_KEY.includes('placeholder');
const testSuite = hasStripeKey ? describe : describe.skip;

const RUN_ID = Date.now();

const createdIntentIds: string[] = [];
const createdUserIds: string[] = [];

afterAll(async () => {
  const errors: unknown[] = [];
  for (const intentId of createdIntentIds) {
    for (const model of [
      'ledgerEntry',
      'pot',
      'virtualCard',
      'auditEvent',
      'approvalDecision',
    ] as const) {
      await (prisma[model] as any)
        .deleteMany({ where: { intentId } })
        .catch((e: unknown) => errors.push(e));
    }
    await prisma.purchaseIntent
      .deleteMany({ where: { id: intentId } })
      .catch((e: unknown) => errors.push(e));
  }
  for (const userId of createdUserIds) {
    await prisma.user.deleteMany({ where: { id: userId } }).catch((e: unknown) => errors.push(e));
  }
  await prisma.$disconnect();
  await disconnectRedis();
  if (errors.length) {
    console.error(`afterAll cleanup encountered ${errors.length} error(s):`, errors);
  }
});

testSuite('Card lifecycle integration', () => {
  // ─── Group 1: Successful purchase — full lifecycle ────────────────────────

  describe('Successful purchase — full lifecycle', () => {
    let userId: string;
    let intentId: string;
    let stripeCardId: string;

    beforeAll(async () => {
      try {
        const user = await prisma.user.create({
          data: {
            email: `lifecycle-success-${RUN_ID}@example.com`,
            mainBalance: 10_000,
            maxBudgetPerIntent: 50_000,
          },
        });
        userId = user.id;
        createdUserIds.push(userId);

        // Intent uses 'eur' for Stripe Issuing; note that potService currently
        // hardcodes 'gbp' on ledger entries — a known mismatch tracked separately.
        const intent = await prisma.purchaseIntent.create({
          data: {
            userId,
            query: 'Lifecycle test — successful purchase',
            maxBudget: 1_000,
            currency: 'eur',
            status: IntentStatus.CARD_ISSUED,
            metadata: {},
            idempotencyKey: `lifecycle-success-${RUN_ID}`,
          },
        });
        intentId = intent.id;
        createdIntentIds.push(intentId);

        await issueVirtualCard(intentId, 1_000, 'eur');
        const card = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
        stripeCardId = card.providerCardId;

        // Stripe test mode needs ~3-5s for cardholder verification to settle;
        // without this wait, authorizations are declined with cardholder_verification_required
        await new Promise((r) => setTimeout(r, 5_000));
      } catch (err) {
        throw new Error(`Group 1 setup failed: ${err}`);
      }
    }, 90_000);

    it('reserves funds and reduces user balance to €90', async () => {
      await reserveForIntent(userId, intentId, 1_000);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mainBalance).toBe(9_000);
    });

    it('simulates a €7 charge on the card via force capture', async () => {
      const stripe = getStripeClient();

      // createForceCapture simulates a merchant force-capturing a payment,
      // bypassing the real-time authorization webhook (which is tested
      // separately in authorizationFlow.test.ts). This avoids flakiness from
      // account-level webhook configuration issues in Stripe test mode.
      const tx = await stripe.testHelpers.issuing.transactions.createForceCapture({
        card: stripeCardId,
        amount: 700,
        currency: 'eur',
        merchant_data: { name: 'Lifecycle Test Merchant' },
      });

      expect(tx.type).toBe('capture');
      expect(tx.amount).toBe(-700);
      expect(tx.currency).toBe('eur');
    });

    it('settles the intent and returns €3 surplus to user', async () => {
      await settleIntent(intentId, 700);

      const pot = await prisma.pot.findUniqueOrThrow({ where: { intentId } });
      expect(pot.status).toBe(PotStatus.SETTLED);
      expect(pot.settledAmount).toBe(700);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mainBalance).toBe(9_300); // €90 + €3 surplus
    });

    it('cancels the card on Stripe and records cancelledAt in DB', async () => {
      await cancelCard(intentId);

      const stripe = getStripeClient();
      const stripeCard = await stripe.issuing.cards.retrieve(stripeCardId);
      expect(stripeCard.status).toBe('canceled');

      const dbCard = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
      expect(dbCard.cancelledAt).not.toBeNull();
    });

    it('declines authorization on the cancelled card', async () => {
      const stripe = getStripeClient();
      const auth = await stripe.testHelpers.issuing.authorizations.create({
        card: stripeCardId,
        amount: 100,
        currency: 'eur',
      });
      expect(auth.approved).toBe(false);
    });
  });

  // ─── Group 2: Failed purchase — full return ───────────────────────────────

  describe('Failed purchase — full return', () => {
    let userId: string;
    let intentId: string;
    let stripeCardId: string;

    beforeAll(async () => {
      try {
        const user = await prisma.user.create({
          data: {
            email: `lifecycle-fail-${RUN_ID}@example.com`,
            mainBalance: 10_000,
            maxBudgetPerIntent: 50_000,
          },
        });
        userId = user.id;
        createdUserIds.push(userId);

        const intent = await prisma.purchaseIntent.create({
          data: {
            userId,
            query: 'Lifecycle test — failed purchase',
            maxBudget: 1_000,
            currency: 'eur',
            status: IntentStatus.CARD_ISSUED,
            metadata: {},
            idempotencyKey: `lifecycle-fail-${RUN_ID}`,
          },
        });
        intentId = intent.id;
        createdIntentIds.push(intentId);

        await issueVirtualCard(intentId, 1_000, 'eur');
        const card = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
        stripeCardId = card.providerCardId;

        await new Promise((r) => setTimeout(r, 5_000));
      } catch (err) {
        throw new Error(`Group 2 setup failed: ${err}`);
      }
    }, 90_000);

    it('reserves funds and reduces user balance to €90', async () => {
      await reserveForIntent(userId, intentId, 1_000);
      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mainBalance).toBe(9_000);
    });

    it('declines a charge that exceeds the spending limit', async () => {
      const stripe = getStripeClient();
      const auth = await stripe.testHelpers.issuing.authorizations.create({
        card: stripeCardId,
        amount: 5_000,
        currency: 'eur',
      });
      expect(auth.approved).toBe(false);
      expect(auth.status).toBe('closed');
    });

    it('returns the intent — pot is RETURNED, balance back to €100', async () => {
      await returnIntent(intentId);

      const pot = await prisma.pot.findUniqueOrThrow({ where: { intentId } });
      expect(pot.status).toBe(PotStatus.RETURNED);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
      expect(user.mainBalance).toBe(10_000);
    });

    it('cancels the card on Stripe and records cancelledAt in DB', async () => {
      await cancelCard(intentId);

      const stripe = getStripeClient();
      const stripeCard = await stripe.issuing.cards.retrieve(stripeCardId);
      expect(stripeCard.status).toBe('canceled');

      const dbCard = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
      expect(dbCard.cancelledAt).not.toBeNull();
    });
  });

  // ─── Group 3: Idempotency ────────────────────────────────────────────────

  describe('Idempotency', () => {
    let userId: string;
    let cancelIntentId: string;
    let returnIntentId: string;

    beforeAll(async () => {
      try {
        const user = await prisma.user.create({
          data: {
            email: `lifecycle-idempotent-${RUN_ID}@example.com`,
            mainBalance: 10_000,
            maxBudgetPerIntent: 50_000,
          },
        });
        userId = user.id;
        createdUserIds.push(userId);

        // Intent with card for double-cancel test
        const cancelIntent = await prisma.purchaseIntent.create({
          data: {
            userId,
            query: 'Idempotency test — cancel',
            maxBudget: 1_000,
            currency: 'eur',
            status: IntentStatus.CARD_ISSUED,
            metadata: {},
            idempotencyKey: `lifecycle-idem-cancel-${RUN_ID}`,
          },
        });
        cancelIntentId = cancelIntent.id;
        createdIntentIds.push(cancelIntentId);
        await issueVirtualCard(cancelIntentId, 1_000, 'eur');

        // Intent with pot for double-return test (no card needed)
        const returnIntent_ = await prisma.purchaseIntent.create({
          data: {
            userId,
            query: 'Idempotency test — return',
            maxBudget: 1_000,
            currency: 'eur',
            status: IntentStatus.CARD_ISSUED,
            metadata: {},
            idempotencyKey: `lifecycle-idem-return-${RUN_ID}`,
          },
        });
        returnIntentId = returnIntent_.id;
        createdIntentIds.push(returnIntentId);
        await reserveForIntent(userId, returnIntentId, 1_000);
      } catch (err) {
        throw new Error(`Group 3 setup failed: ${err}`);
      }
    }, 90_000);

    it('double cancelCard does not throw', async () => {
      await cancelCard(cancelIntentId);
      await expect(cancelCard(cancelIntentId)).resolves.toBeUndefined();

      const card = await prisma.virtualCard.findUniqueOrThrow({
        where: { intentId: cancelIntentId },
      });
      expect(card.cancelledAt).not.toBeNull();
    });

    it('double returnIntent is a no-op — balance unchanged', async () => {
      await returnIntent(returnIntentId);
      const potAfterFirst = await prisma.pot.findUniqueOrThrow({
        where: { intentId: returnIntentId },
      });
      expect(potAfterFirst.status).toBe(PotStatus.RETURNED);

      const balanceAfterFirst = (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .mainBalance;

      await expect(returnIntent(returnIntentId)).resolves.toBeUndefined();
      const potAfterSecond = await prisma.pot.findUniqueOrThrow({
        where: { intentId: returnIntentId },
      });
      expect(potAfterSecond.status).toBe(PotStatus.RETURNED);

      const balanceAfterSecond = (await prisma.user.findUniqueOrThrow({ where: { id: userId } }))
        .mainBalance;
      expect(balanceAfterSecond).toBe(balanceAfterFirst);
    });
  });
});
