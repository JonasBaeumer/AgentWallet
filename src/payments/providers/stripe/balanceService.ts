import Stripe from 'stripe';
import type { Balance } from 'stripe/cjs/resources/Balance';
import { IssuingBalance } from '@/contracts';
import { getStripeClient } from './stripeClient';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'payments/stripe/balanceService' });

export async function getIssuingBalance(currency: string): Promise<IssuingBalance> {
  const stripe = getStripeClient();
  const normalised = currency.toLowerCase();

  let balance: Balance;
  try {
    balance = await stripe.balance.retrieve();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      log.error(
        { type: err.type, code: err.code, err },
        'Failed to retrieve Stripe Issuing balance',
      );
    }
    throw err;
  }

  const entry = (balance.issuing?.available ?? []).find(
    (b) => b.currency.toLowerCase() === normalised,
  );
  return { available: entry?.amount ?? 0, currency: normalised };
}
