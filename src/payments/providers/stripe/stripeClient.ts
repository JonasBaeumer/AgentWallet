import Stripe from 'stripe';

export type StripeMode = 'live' | 'test';

export function getStripeMode(): StripeMode {
  const key = process.env.STRIPE_SECRET_KEY ?? '';
  return key.startsWith('sk_live_') ? 'live' : 'test';
}

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
    _stripe = new Stripe(key, { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
  }
  return _stripe;
}
