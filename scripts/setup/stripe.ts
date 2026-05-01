import { log, spinner } from '@clack/prompts';
import { SetupContext } from './types';
import { isPlaceholder, SubStep, subStepPass, subStepFail, subStepWarn, logSubSteps } from './utils';

export async function setupStripe(ctx: SetupContext): Promise<void> {
  const key = ctx.envVars.STRIPE_SECRET_KEY;
  if (isPlaceholder(key)) {
    log.warn('STRIPE_SECRET_KEY not configured — skipping Stripe validation');
    ctx.results.push({ name: 'Stripe API', status: 'skip', message: 'No API key configured' });
    return;
  }

  const s = spinner();
  s.start('Validating Stripe configuration...');

  const steps: SubStep[] = [];
  let stripe: any;

  // Validate key with a real API call
  s.message('Validating API key...');
  try {
    const Stripe = require('stripe').default || require('stripe');
    stripe = new Stripe(key, { apiVersion: '2024-06-20' as any, maxNetworkRetries: 3 });
    await stripe.accounts.retrieve();
    steps.push(subStepPass('Stripe API', 'Key validated'));
    ctx.results.push({ name: 'Stripe API', status: 'pass', message: 'Key validated' });
  } catch (err: any) {
    const msg = err?.message || 'Unknown error';
    steps.push(subStepFail('Stripe API', msg));
    ctx.results.push({ name: 'Stripe API', status: 'fail', message: msg });
    s.stop('Stripe validation failed');
    logSubSteps(steps);
    return;
  }

  // Check Issuing is enabled
  s.message('Checking Stripe Issuing...');
  try {
    await stripe.issuing.cards.list({ limit: 1 });
    steps.push(subStepPass('Stripe Issuing', 'Enabled'));
    ctx.results.push({ name: 'Stripe Issuing', status: 'pass', message: 'Enabled' });
  } catch {
    steps.push(subStepWarn('Stripe Issuing', 'Not enabled or insufficient permissions'));
    ctx.results.push({ name: 'Stripe Issuing', status: 'warn', message: 'Not enabled or insufficient permissions' });
  }

  // Check Issuing balance
  s.message('Checking Issuing balance...');
  try {
    const balance = await stripe.balance.retrieve();
    const issuingBalance = balance.issuing?.available?.[0]?.amount ?? 0;
    if (issuingBalance === 0) {
      steps.push(subStepWarn('Issuing balance', 'Zero — fund via Dashboard → Balances'));
      ctx.results.push({ name: 'Issuing balance', status: 'warn', message: 'Unfunded (zero balance)' });
    } else {
      steps.push(subStepPass('Issuing balance', `${issuingBalance} (smallest unit)`));
      ctx.results.push({ name: 'Issuing balance', status: 'pass', message: `${issuingBalance}` });
    }
  } catch {
    steps.push(subStepWarn('Issuing balance', 'Could not retrieve'));
    ctx.results.push({ name: 'Issuing balance', status: 'warn', message: 'Could not retrieve' });
  }

  s.stop('Stripe configuration validated');
  logSubSteps(steps);
}
