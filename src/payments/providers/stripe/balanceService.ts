import Stripe from 'stripe';
import { IssuingBalance } from '@/contracts';
import { getStripeClient } from './stripeClient';

export async function getIssuingBalance(currency: string): Promise<IssuingBalance> {
  const stripe = getStripeClient();
  const normalised = currency.toLowerCase();

  let balance: Stripe.Balance;
  try {
    balance = await stripe.balance.retrieve();
  } catch (err) {
    if (err instanceof Stripe.errors.StripeError) {
      console.error(JSON.stringify({
        level: 'error',
        message: 'Failed to retrieve Stripe Issuing balance',
        type: err.type,
        code: err.code,
        stripeMessage: err.message,
      }));
    }
    throw err;
  }

  const entry = (balance.issuing?.available ?? []).find(
    (b) => b.currency.toLowerCase() === normalised,
  );
  return { available: entry?.amount ?? 0, currency: normalised };
}
