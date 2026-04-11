import { log, spinner } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, isPlaceholder } from './utils';

export async function setupStripe(ctx: SetupContext): Promise<void> {
  log.info('Validating Stripe configuration...');

  const key = ctx.envVars.STRIPE_SECRET_KEY;
  if (isPlaceholder(key)) {
    log.warn('STRIPE_SECRET_KEY not configured — skipping Stripe validation');
    ctx.results.push({ name: 'Stripe API', status: 'skip', message: 'No API key configured' });
    return;
  }

  // Validate key with a real API call
  const s = spinner();
  s.start('Validating Stripe API key');

  let stripe: any;
  try {
    const Stripe = require('stripe').default || require('stripe');
    stripe = new Stripe(key, { apiVersion: '2024-06-20' as any });
    await stripe.accounts.retrieve();
    s.stop('Stripe API key is valid');
    ctx.results.push({ name: 'Stripe API', status: 'pass', message: 'Key validated' });
  } catch (err: any) {
    s.stop('Stripe API key validation failed');
    const msg = err?.message || 'Unknown error';
    log.error(`Stripe error: ${msg}`);
    ctx.results.push({ name: 'Stripe API', status: 'fail', message: msg });
    return;
  }

  // Check Issuing is enabled
  s.start('Checking Stripe Issuing');
  try {
    await stripe.issuing.cards.list({ limit: 1 });
    s.stop('Stripe Issuing is enabled');
    ctx.results.push({ name: 'Stripe Issuing', status: 'pass', message: 'Enabled' });
  } catch (err: any) {
    s.stop('Stripe Issuing check failed');
    log.warn(
      'Stripe Issuing may not be enabled. Visit:\n' +
      'https://dashboard.stripe.com/test/issuing/overview',
    );
    ctx.results.push({
      name: 'Stripe Issuing',
      status: 'warn',
      message: 'Not enabled or insufficient permissions',
    });
  }

  // Check Issuing balance
  s.start('Checking Issuing balance');
  try {
    const balance = await stripe.balance.retrieve();
    const issuingBalance = balance.issuing?.available?.[0]?.amount ?? 0;
    s.stop(`Issuing balance: ${issuingBalance} (smallest unit)`);
    if (issuingBalance === 0) {
      log.warn(
        'Issuing balance is zero. Fund it via:\n' +
        'Dashboard → Balances → Issuing balance → Add funds',
      );
      ctx.results.push({ name: 'Issuing balance', status: 'warn', message: 'Unfunded (zero balance)' });
    } else {
      ctx.results.push({ name: 'Issuing balance', status: 'pass', message: `${issuingBalance}` });
    }
  } catch {
    s.stop('Could not check Issuing balance');
    ctx.results.push({ name: 'Issuing balance', status: 'warn', message: 'Could not retrieve' });
  }

  // Stripe CLI listener is handled by the services phase (Phase 8)
}
