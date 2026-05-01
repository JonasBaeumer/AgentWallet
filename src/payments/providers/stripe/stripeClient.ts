import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripeClient(): Stripe {
  if (!_stripe) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY env var is not set');
    _stripe = new Stripe(key, {
      apiVersion: '2024-06-20' as Stripe.LatestApiVersion,
      // 5 retries (default 0) to survive transient test-mode connection errors.
      maxNetworkRetries: 5,
    });
  }
  return _stripe;
}
