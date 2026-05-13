import Stripe from 'stripe';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'payments/stripe/validateStripe' });

const PLACEHOLDER = 'sk_test_placeholder';

export async function validateStripeSetup(): Promise<void> {
  const key = process.env.STRIPE_SECRET_KEY;

  if (!key || key === PLACEHOLDER) {
    log.warn('STRIPE_SECRET_KEY is not configured — Stripe features will not work');
    return;
  }

  const stripe = new Stripe(key, { apiVersion: '2024-06-20' as typeof Stripe.API_VERSION });

  try {
    await stripe.issuing.cards.list({ limit: 1 });
  } catch (err) {
    if (err instanceof Stripe.errors.StripeAuthenticationError) {
      log.warn('STRIPE_SECRET_KEY is invalid — Stripe authentication failed');
      return;
    }
    if (
      err instanceof Stripe.errors.StripePermissionError ||
      (err instanceof Stripe.errors.StripeError && err.code === 'resource_missing')
    ) {
      log.warn(
        'Stripe Issuing is not enabled on this account. Apply at https://stripe.com/issuing',
      );
      return;
    }
    log.warn(`Stripe validation failed: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  const mode = key.startsWith('sk_live_') ? 'live' : 'test';
  log.info(`Stripe Issuing is enabled (mode: ${mode})`);

  try {
    const balance = await stripe.balance.retrieve();
    const issuingBalance = balance.issuing?.available ?? [];
    const summary = issuingBalance.map((b) => `${b.amount} ${b.currency}`).join(', ') || 'no funds';
    log.info(`Stripe Issuing balance: ${summary}`);
  } catch {
    // Balance retrieval is informational — don't fail
  }
}
