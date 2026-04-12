import 'dotenv/config';
import { buildApp } from '@/app';
import { env } from '@/config/env';
import { logger } from '@/config/logger';
import { validateStripeSetup } from '@/payments/providers/stripe/validateStripe';

const log = logger.child({ module: 'server' });

async function start() {
  const app = buildApp();
  try {
    await app.listen({ port: env.PORT, host: '0.0.0.0' });
    log.info({ port: env.PORT }, 'Server running');
  } catch (err) {
    log.error({ err }, 'Server failed to start');
    process.exit(1);
  }

  await validateStripeSetup();
}

start();
