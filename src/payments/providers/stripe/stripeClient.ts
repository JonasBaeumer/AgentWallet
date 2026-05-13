import Stripe from 'stripe';
import type { Stripe as StripeTypes } from 'stripe/cjs/stripe.core';

let _stripe: StripeTypes | null = null;

export function getStripeClient(): StripeTypes {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' as typeof Stripe.API_VERSION });
  }
  return _stripe;
}
