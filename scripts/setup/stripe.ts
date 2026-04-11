import { log, confirm, spinner, isCancel } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, commandExists, isPlaceholder, projectPath, readEnvFile, writeEnvFile, spawnDetached } from './utils';

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

  // Stripe CLI webhook forwarding
  if (!commandExists('stripe')) {
    log.info('Stripe CLI not installed — skipping webhook listener setup');
    return;
  }

  let shouldListen = false;
  if (ctx.nonInteractive) {
    // In non-interactive mode, don't start the listener
    shouldListen = false;
  } else {
    const answer = await confirm({
      message: 'Start Stripe CLI webhook listener? (runs in background)',
    });
    shouldListen = !isCancel(answer) && answer;
  }

  if (!shouldListen) return;

  s.start('Starting Stripe CLI webhook listener');
  const child = spawnDetached('stripe', [
    'listen',
    '--forward-to',
    `localhost:${ctx.envVars.PORT || '3000'}/v1/webhooks/stripe`,
  ]);

  // Read stderr for the webhook signing secret
  const secret = await new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 15_000);
    let buffer = '';

    child.stderr?.on('data', (data: Buffer) => {
      buffer += data.toString();
      const match = buffer.match(/whsec_\w+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
    });

    child.on('error', () => {
      clearTimeout(timeout);
      resolve(null);
    });
  });

  if (secret) {
    s.stop(`Stripe listener running (PID ${child.pid})`);
    ctx.envVars.STRIPE_WEBHOOK_SECRET = secret;
    writeEnvFile(ctx.envPath, ctx.envVars, projectPath('.env.example'));
    log.success(`STRIPE_WEBHOOK_SECRET updated in .env: ${secret.slice(0, 15)}...`);
    ctx.results.push({
      name: 'Stripe webhook listener',
      status: 'pass',
      message: `Running as PID ${child.pid}`,
    });
  } else {
    s.stop('Could not capture webhook secret from Stripe CLI');
    log.warn('Run manually: stripe listen --forward-to localhost:3000/v1/webhooks/stripe');
    ctx.results.push({
      name: 'Stripe webhook listener',
      status: 'warn',
      message: 'Could not start — run manually',
    });
  }
}
