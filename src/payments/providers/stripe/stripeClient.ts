import Stripe from 'stripe';
import type { StripeClient } from './stripeTypes';

let _stripe: StripeClient | null = null;

export function getStripeClient(): StripeClient {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' as typeof Stripe.API_VERSION });
  }
  return _stripe;
}
