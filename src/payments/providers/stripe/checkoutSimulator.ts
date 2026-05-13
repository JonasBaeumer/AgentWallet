import Stripe from 'stripe';
import type { Authorization } from 'stripe/cjs/resources/Issuing';
import { getStripeClient } from './stripeClient';
import { prisma } from '@/db/client';
import { IntentNotFoundError } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'payments/stripe/checkoutSimulator' });

export interface SimulatedCheckoutResult {
  success: boolean;
  chargeId: string;
  amount: number;
  currency: string;
  declineCode?: string;
  message?: string;
}

export async function runSimulatedCheckout(params: {
  intentId: string;
  amount: number;
  currency: string;
  merchantName: string;
}): Promise<SimulatedCheckoutResult> {
  const stripe = getStripeClient();
  const { intentId, amount, currency, merchantName } = params;

  // Look up providerCardId from DB — no raw card data needed
  const virtualCard = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!virtualCard) throw new IntentNotFoundError(intentId);

  let auth: Authorization;
  try {
    auth = await stripe.testHelpers.issuing.authorizations.create({
      card: virtualCard.providerCardId,
      amount,
      currency: currency.toLowerCase(),
      merchant_data: { name: merchantName },
    });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error(
        { intentId, type: err.type, code: err.code, err },
        'checkoutSimulator: authorization create failed',
      );
    }
    throw err;
  }

  if (!auth.approved) {
    return {
      success: false,
      chargeId: auth.id,
      amount,
      currency,
      declineCode: auth.request_history?.[0]?.reason ?? 'card_declined',
      message: 'Card declined',
    };
  }

  try {
    await stripe.testHelpers.issuing.authorizations.capture(auth.id);
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error(
        { intentId, type: err.type, code: err.code, err },
        'checkoutSimulator: authorization capture failed',
      );
    }
    throw err;
  }

  return {
    success: true,
    chargeId: auth.id,
    amount,
    currency,
  };
}
