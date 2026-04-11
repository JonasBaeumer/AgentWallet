import path from 'path';
import { intro, log, confirm, isCancel } from '@clack/prompts';
import { printHeader } from './setup/ascii';
import { checkPrerequisites } from './setup/prerequisites';
import { setupEnvironment } from './setup/environment';
import { startInfrastructure } from './setup/infrastructure';
import { setupDatabase } from './setup/database';
import { setupStripe } from './setup/stripe';
import { setupTelegram } from './setup/telegram';
import { runVerification } from './setup/verification';
import { launchServices } from './setup/services';
import { printSummary } from './setup/summary';
import { SetupContext } from './setup/types';
import { detectOS } from './setup/utils';

async function main(): Promise<void> {
  const nonInteractive =
    process.argv.includes('--non-interactive') ||
    process.env.SETUP_NON_INTERACTIVE === '1';

  const { os, hasBrew, hasApt } = detectOS();

  const ctx: SetupContext = {
    nonInteractive,
    os,
    hasBrew,
    hasApt,
    results: [],
    envPath: path.resolve(__dirname, '..', '.env'),
    envVars: {},
    skipTelegram: false,
    generatedApiKey: null,
  };

  printHeader();
  intro("Let's set up your development environment");

  // Phase 1: Prerequisites
  await checkPrerequisites(ctx);

  // Bail if Docker is not available — nothing else works without it
  const dockerFailed = ctx.results.some(
    (r) => r.name === 'Docker' && r.status === 'fail',
  );
  if (dockerFailed) {
    log.error('Docker is required. Fix the issues above and re-run setup.');
    printSummary(ctx);
    process.exit(1);
  }

  // Phase 2: Environment
  await setupEnvironment(ctx);

  // Phase 3: Infrastructure
  await startInfrastructure(ctx);

  // Bail if infra failed — DB setup won't work
  const infraFailed = ctx.results.some(
    (r) => (r.name === 'PostgreSQL' || r.name === 'Redis') && r.status === 'fail',
  );
  if (infraFailed) {
    log.error('Infrastructure not ready. Fix the issues above and re-run setup.');
    printSummary(ctx);
    process.exit(1);
  }

  // Phase 4: Database
  await setupDatabase(ctx);

  // Phase 5: Stripe
  await setupStripe(ctx);

  // Phase 6: Telegram
  await setupTelegram(ctx);

  // Phase 7: Verification
  await runVerification(ctx);

  // Phase 8: Launch services
  let launchNow = true;
  if (!ctx.nonInteractive) {
    const answer = await confirm({
      message: 'Launch dev services now? (server, worker, webhooks)',
      initialValue: true,
    });
    launchNow = !isCancel(answer) && answer;
  }

  if (launchNow) {
    await launchServices(ctx);
  }

  // Phase 9: Summary
  printSummary(ctx);

  const hasFails = ctx.results.some((r) => r.status === 'fail');
  process.exit(hasFails ? 1 : 0);
}

main().catch((err) => {
  console.error('Setup failed unexpectedly:', err);
  process.exit(1);
});
