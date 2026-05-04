/**
 * E2E: Telegram approval -> Stripe Issuing checkout
 *
 * Simulates what OpenClaw does end-to-end -- without a real agent:
 *
 *  1. Create a test user linked to TELEGRAM_TEST_CHAT_ID
 *  2. Create a purchase intent (seeded into QUOTED state)
 *  3. Transition to AWAITING_APPROVAL + send a Telegram approval request
 *  4. Wait up to 60 s for the user to tap "Approve" in Telegram
 *     (requires: npm run dev + Telegram webhook via ngrok pointing to localhost:3000)
 *  5. If no approval received, auto-approve after the timeout
 *  6. Issue the Stripe virtual card
 *  7. Wait 3 s for the fresh cardholder's verification state to settle
 *  8. Create a Stripe test authorization + capture (the simulated checkout)
 *  9. Finalize the intent + settle the ledger
 * 10. Assert: status = DONE, pot SETTLED, balance arithmetic correct
 *
 * When TELEGRAM_MOCK=true (or TELEGRAM_BOT_TOKEN is not set):
 *   - The mock bot is used instead of real Telegram API calls
 *   - Step 4 is skipped entirely (no 60 s wait)
 *   - The test auto-approves immediately and asserts mock calls were recorded
 *
 * Requires:
 *   STRIPE_SECRET_KEY=sk_test_*
 *
 * Run: npx jest --testPathPattern=telegramApprovalCheckout --forceExit
 */

import { prisma } from '@/db/client';
import { disconnectRedis } from '@/config/redis';
import { requestApproval, recordDecision } from '@/approval/approvalService';
import { sendApprovalRequest } from '@/telegram/notificationService';
import { createStripeProvider } from '@/payments/testHelpers';
import { reserveForIntent, settleIntent } from '@/ledger/potService';
import { markCardIssued, startCheckout, completeCheckout } from '@/orchestrator/intentService';
import { IntentStatus, ApprovalDecisionType } from '@/contracts';
import { getTelegramMockCalls, clearTelegramMockCalls } from '@/telegram/mockBot';

const stripeCtx = createStripeProvider();

// -- Skip conditions ----------------------------------------------------------
const hasStripeKey = process.env.STRIPE_SECRET_KEY?.startsWith('sk_test_');
const isMockMode = process.env.TELEGRAM_MOCK === 'true' || !process.env.TELEGRAM_BOT_TOKEN;
const hasTelegram =
  isMockMode || (!!process.env.TELEGRAM_BOT_TOKEN && !!process.env.TELEGRAM_TEST_CHAT_ID);

const testSuite = hasStripeKey && hasTelegram ? describe : describe.skip;

if (!hasStripeKey) console.warn('Skipped: STRIPE_SECRET_KEY must be sk_test_*');

// -- Test data ----------------------------------------------------------------
const RUN_ID = Date.now();
const MERCHANT_NAME = 'Amazon DE';
const TASK = 'Buy a pair of noise-cancelling headphones';
const MAX_BUDGET = 5000; // EUR50 in cents
const CHECKOUT_AMOUNT = 3499; // EUR34.99 -- simulated actual price
const CURRENCY = 'eur';

// Telegram approval timeout: 60 s (only used in non-mock mode)
const APPROVAL_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 2_000;

// Use a synthetic chat ID in mock mode
const TEST_CHAT_ID = isMockMode ? '999999999' : process.env.TELEGRAM_TEST_CHAT_ID!;

// -- Teardown -----------------------------------------------------------------
afterAll(async () => {
  await prisma.$disconnect();
  disconnectRedis();
});

// -- Suite --------------------------------------------------------------------
testSuite('Telegram approval -> Stripe Issuing checkout', () => {
  let userId: string;
  let intentId: string;

  beforeAll(() => {
    if (isMockMode) {
      clearTelegramMockCalls();
    }
  });

  afterAll(async () => {
    await prisma.virtualCard.deleteMany({ where: { intentId } });
    await prisma.ledgerEntry.deleteMany({ where: { intentId } });
    await prisma.pot.deleteMany({ where: { intentId } });
    await prisma.approvalDecision.deleteMany({ where: { intentId } });
    await prisma.auditEvent.deleteMany({ where: { intentId } });
    await prisma.purchaseIntent.deleteMany({ where: { id: intentId } });
    await prisma.user.deleteMany({ where: { id: userId } });
  });

  // -- Step 1 -- Create test user ---------------------------------------------
  it('creates a test user linked to the Telegram chat', async () => {
    const user = await prisma.user.create({
      data: {
        email: `tg-checkout-${RUN_ID}@example.com`,
        telegramChatId: TEST_CHAT_ID,
        mainBalance: 1_000_000, // EUR10 000
        maxBudgetPerIntent: 500_000,
      },
    });
    userId = user.id;
    expect(user.telegramChatId).toBe(TEST_CHAT_ID);
  });

  // -- Step 2 -- Create purchase intent ---------------------------------------
  it('creates a purchase intent in QUOTED state', async () => {
    const intent = await prisma.purchaseIntent.create({
      data: {
        userId,
        query: TASK,
        subject: TASK,
        maxBudget: MAX_BUDGET,
        currency: CURRENCY,
        status: IntentStatus.QUOTED,
        idempotencyKey: `tg-checkout-${RUN_ID}`,
        metadata: {
          quote: {
            merchant: MERCHANT_NAME,
            url: 'https://amazon.de/dp/B09XS7JWHH',
            price: CHECKOUT_AMOUNT,
            currency: CURRENCY,
          },
        },
      },
    });
    intentId = intent.id;
    expect(intent.status).toBe(IntentStatus.QUOTED);
  });

  // -- Step 3 -- Request approval + send Telegram notification ----------------
  it('transitions to AWAITING_APPROVAL and sends a Telegram message', async () => {
    await requestApproval(intentId);

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.AWAITING_APPROVAL);

    // Send the Telegram approval request (uses mock bot in mock mode)
    await sendApprovalRequest(intentId);

    if (isMockMode) {
      // Verify the mock bot recorded a sendMessage call
      const mockCalls = getTelegramMockCalls();
      const sendCalls = mockCalls.filter((c) => c.method === 'sendMessage');
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      expect(sendCalls[0].args[0]).toBe(TEST_CHAT_ID);
      console.log(
        `[mock] Telegram notification recorded (${sendCalls.length} sendMessage call(s))`,
      );
    } else {
      console.log(
        `\nTelegram approval request sent!\n` +
          `   Tap "Approve" in your bot within ${APPROVAL_TIMEOUT_MS / 1000}s.\n` +
          `   (If not approved in time, the test will auto-approve.)\n`,
      );
    }
  });

  // -- Step 4 -- Wait for Telegram approval (or auto-approve) -----------------
  it(
    'waits for user approval (or auto-approves after timeout)',
    async () => {
      if (isMockMode) {
        // Mock mode: skip the 60 s wait and auto-approve immediately
        await recordDecision(intentId, ApprovalDecisionType.APPROVED, 'test-mock-approve');
        await reserveForIntent(userId, intentId, MAX_BUDGET);
        await stripeCtx.provider.issueCard(intentId, MAX_BUDGET);
        await markCardIssued(intentId);
        await startCheckout(intentId);

        const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
        expect([IntentStatus.CARD_ISSUED, IntentStatus.CHECKOUT_RUNNING]).toContain(intent.status);
        return;
      }

      // Real Telegram mode: poll for approval
      const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
      let telegramApproved = false;
      let currentStatus: IntentStatus = IntentStatus.AWAITING_APPROVAL;

      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
        currentStatus = intent.status as IntentStatus;

        if (currentStatus === IntentStatus.APPROVED) {
          if (!telegramApproved) {
            telegramApproved = true;
            console.log('Approved via Telegram! Waiting for card to be issued...');
          }
          continue;
        }

        if (
          currentStatus === IntentStatus.CARD_ISSUED ||
          currentStatus === IntentStatus.CHECKOUT_RUNNING
        ) {
          console.log(`Card issued! Intent status: ${currentStatus}`);
          break;
        }
      }

      if (!telegramApproved && currentStatus === IntentStatus.AWAITING_APPROVAL) {
        console.log('Timeout -- auto-approving and continuing...');
        await recordDecision(intentId, ApprovalDecisionType.APPROVED, 'test-auto-approve');
        await reserveForIntent(userId, intentId, MAX_BUDGET);
        await stripeCtx.provider.issueCard(intentId, MAX_BUDGET);
        await markCardIssued(intentId);
        await startCheckout(intentId);
        currentStatus = IntentStatus.CHECKOUT_RUNNING;
      } else if (telegramApproved && currentStatus === IntentStatus.APPROVED) {
        console.log('Card issuance still in progress, waiting 5 s...');
        await new Promise((r) => setTimeout(r, 5000));
        const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
        currentStatus = intent.status as IntentStatus;
      }

      const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
      expect([IntentStatus.CARD_ISSUED, IntentStatus.CHECKOUT_RUNNING]).toContain(intent.status);
    },
    isMockMode ? 30_000 : APPROVAL_TIMEOUT_MS + 30_000,
  );

  // -- Step 5 -- Verify card was issued ---------------------------------------
  it('has a real Stripe Issuing card in the database', async () => {
    const card = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });
    expect(card.providerCardId).toMatch(/^ic_/);
    expect(card.last4).toHaveLength(4);

    const stripeCard = await stripeCtx.stripe.issuing.cards.retrieve(card.providerCardId);
    expect(stripeCard.status).toBe('active');
    expect(stripeCard.spending_controls.spending_limits[0].amount).toBe(MAX_BUDGET);

    console.log(
      `Card issued: ${stripeCard.id} (last4: ${stripeCard.last4}, status: ${stripeCard.status})`,
    );
  });

  // -- Step 6 -- Simulated checkout via Stripe test helpers -------------------
  it('creates a real Stripe authorization and captures it (simulated checkout)', async () => {
    // Stripe test mode: freshly created individual cardholders need ~3 s to
    // settle before authorizations are approved
    console.log('Waiting 3 s for cardholder verification to settle...');
    await new Promise((r) => setTimeout(r, 3000));

    const card = await prisma.virtualCard.findUniqueOrThrow({ where: { intentId } });

    const auth = await stripeCtx.stripe.testHelpers.issuing.authorizations.create({
      card: card.providerCardId,
      amount: CHECKOUT_AMOUNT,
      currency: CURRENCY,
      merchant_data: { name: MERCHANT_NAME },
    });

    expect(auth.approved).toBe(true);
    expect(auth.status).toBe('pending');
    console.log(`Authorization approved: ${auth.id} (EUR${(CHECKOUT_AMOUNT / 100).toFixed(2)})`);

    const captured = await stripeCtx.stripe.testHelpers.issuing.authorizations.capture(auth.id);
    expect(captured.status).toBe('closed');
    console.log(`Transaction captured.`);
  }, 30_000);

  // -- Step 7 -- Finalize intent + settle ledger ------------------------------
  it('finalizes the intent and settles the ledger', async () => {
    const pre = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
    if (pre.status === IntentStatus.CARD_ISSUED) {
      await startCheckout(intentId);
    }

    await completeCheckout(intentId, CHECKOUT_AMOUNT);
    await settleIntent(intentId, CHECKOUT_AMOUNT);

    const intent = await prisma.purchaseIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(intent.status).toBe(IntentStatus.DONE);

    const pot = await prisma.pot.findFirstOrThrow({ where: { intentId } });
    expect(pot.status).toBe('SETTLED');
    expect(pot.settledAmount).toBe(CHECKOUT_AMOUNT);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const surplus = MAX_BUDGET - CHECKOUT_AMOUNT;
    expect(user.mainBalance).toBe(1_000_000 - CHECKOUT_AMOUNT);

    console.log(
      `\nFlow complete!\n` +
        `   Intent: ${intentId} -> ${intent.status}\n` +
        `   Charged: EUR${(CHECKOUT_AMOUNT / 100).toFixed(2)}\n` +
        `   Surplus returned: EUR${(surplus / 100).toFixed(2)}\n` +
        `   New balance: EUR${(user.mainBalance / 100).toFixed(2)}\n`,
    );
  });
});
