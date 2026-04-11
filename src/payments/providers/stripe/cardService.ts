import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { buildSpendingControls } from './spendingControls';
import { prisma } from '@/db/client';
import { VirtualCardData, CardReveal, CardAlreadyRevealedError, IntentNotFoundError } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'payments/stripe/cardService' });

interface IssueCardOptions {
  mccAllowlist?: string[];
}

export async function issueVirtualCard(
  intentId: string,
  amount: number,
  currency: string,
  options: IssueCardOptions = {},
): Promise<VirtualCardData> {
  const stripe = getStripeClient();

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { user: true },
  });
  if (!intent) throw new IntentNotFoundError(intentId);

  // Upsert cardholder: reuse existing Stripe cardholder if the user already has one,
  // otherwise create a new one and persist the ID so future intents reuse it.
  let cardholderId: string;
  if (intent.user.stripeCardholderId) {
    cardholderId = intent.user.stripeCardholderId;
  } else {
    let newCardholder: Stripe.Issuing.Cardholder;
    try {
      newCardholder = await stripe.issuing.cardholders.create({
        name: 'Agent Buyer',
        email: intent.user.email,
        phone_number: intent.user.phoneNumber ?? '+15555555555',
        type: 'individual',
        individual: {
          first_name: 'Agent',
          last_name: 'Buyer',
          dob: { day: 1, month: 1, year: 1980 },
        },
        billing: {
          address: {
            line1: '1 Agent St',
            city: 'London',
            postal_code: 'EC1A 1BB',
            country: 'GB',
          },
        },
      });
    } catch (err) {
      if (err instanceof Stripe.errors.StripeError) {
        log.error({ intentId, type: err.type, code: err.code, err }, 'Cardholder create failed');
      }
      throw err;
    }
    cardholderId = newCardholder.id;
    // Persist so all future intents for this user reuse the same cardholder
    await prisma.user.update({
      where: { id: intent.user.id },
      data: { stripeCardholderId: cardholderId },
    });
  }

  // Create virtual card with intentId as idempotency key.
  // metadata.intentId is set so Stripe webhook events can be correlated back to this intent.
  let stripeCard: Stripe.Issuing.Card;
  try {
    stripeCard = await stripe.issuing.cards.create(
      {
        cardholder: cardholderId,
        currency: currency.toLowerCase(),
        type: 'virtual',
        status: 'active',
        spending_controls: buildSpendingControls(amount, options.mccAllowlist),
        metadata: {
          intentId,
          purpose: (intent.subject ?? intent.query).slice(0, 500),
          budget: `${(amount / 100).toFixed(2)} ${currency.toUpperCase()}`,
        },
      },
      { idempotencyKey: intentId },
    );
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error({ intentId, type: err.type, code: err.code, err }, 'Card create failed');
    }
    throw err;
  }

  // Persist ONLY stripeCardId + last4 — never PAN, CVC
  const virtualCard = await prisma.virtualCard.create({
    data: {
      intentId,
      stripeCardId: stripeCard.id,
      last4: stripeCard.last4,
    },
  });

  return virtualCard as unknown as VirtualCardData;
}

export async function revealCard(intentId: string): Promise<CardReveal> {
  const stripe = getStripeClient();

  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!card) throw new IntentNotFoundError(intentId);
  if (card.revealedAt) throw new CardAlreadyRevealedError(intentId);

  // Retrieve card with expanded number and CVC (works for virtual cards in both test and live mode)
  let stripeCard: Stripe.Issuing.Card;
  try {
    stripeCard = await stripe.issuing.cards.retrieve(card.stripeCardId, {
      expand: ['number', 'cvc'],
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error({ intentId, type: err.type, code: err.code, err }, 'Failed to retrieve card details');
    }
    throw err;
  }

  // Mark as revealed — destructive, one-time only
  await prisma.virtualCard.update({
    where: { intentId },
    data: { revealedAt: new Date() },
  });

  return {
    number: (stripeCard as any).number ?? '',
    cvc: (stripeCard as any).cvc ?? '',
    expMonth: stripeCard.exp_month,
    expYear: stripeCard.exp_year,
    last4: stripeCard.last4,
  };
}

export async function freezeCard(intentId: string): Promise<void> {
  const stripe = getStripeClient();

  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!card) throw new IntentNotFoundError(intentId);

  try {
    await stripe.issuing.cards.update(card.stripeCardId, { status: 'inactive' });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error({ intentId, type: err.type, code: err.code, err }, 'Failed to freeze card');
    }
    throw err;
  }

  await prisma.virtualCard.update({
    where: { intentId },
    data: { frozenAt: new Date() },
  });
}

export async function cancelCard(intentId: string): Promise<void> {
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!card) throw new IntentNotFoundError(intentId);

  // Guard 1: already cancelled in our DB — nothing to do
  if (card.cancelledAt) return;

  const stripe = getStripeClient();
  try {
    await stripe.issuing.cards.update(card.stripeCardId, { status: 'canceled' });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      // Guard 2: card was already cancelled externally (e.g. Stripe dashboard)
      // Stripe returns StripeInvalidRequestError in this case — treat as success
      if (err instanceof Stripe.errors.StripeInvalidRequestError) {
        log.warn({ intentId }, 'Card already cancelled externally — marking in DB');
        await prisma.virtualCard.update({ where: { intentId }, data: { cancelledAt: new Date() } });
        return;
      }
      log.error({ intentId, type: err.type, code: err.code, err }, 'Failed to cancel card');
    }
    throw err;
  }

  await prisma.virtualCard.update({
    where: { intentId },
    data: { cancelledAt: new Date() },
  });
}
