import { log, note, spinner } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, execStreaming, SubStep, subStepPass, subStepFail, logSubSteps } from './utils';

export async function setupDatabase(ctx: SetupContext): Promise<void> {
  const s = spinner();
  s.start('Setting up database...');

  const steps: SubStep[] = [];

  // Prisma generate (always safe to re-run)
  s.message('Generating Prisma client...');
  const generate = exec('npx prisma generate', { timeout: 30_000 });
  if (generate.code !== 0) {
    steps.push(subStepFail('Prisma generate', generate.stderr || generate.stdout || 'Unknown error'));
    ctx.results.push({ name: 'Prisma generate', status: 'fail', message: generate.stderr || generate.stdout });
    s.stop('Database setup failed');
    logSubSteps(steps);
    return;
  }
  steps.push(subStepPass('Prisma client', 'Generated'));

  // Check migration status
  s.message('Checking migration status...');
  const status = exec('npx prisma migrate status 2>&1', { timeout: 30_000 });
  const isUpToDate = status.stdout.includes('Database schema is up to date');

  if (isUpToDate) {
    steps.push(subStepPass('Migrations', 'Already up to date'));
    ctx.results.push({ name: 'Database migrations', status: 'pass', message: 'Already up to date' });
  } else {
    s.stop('Running database migrations...');
    const migrateCmd = ctx.nonInteractive ? 'npx prisma migrate deploy' : 'npx prisma migrate dev';
    const migrate = await execStreaming('sh', ['-c', migrateCmd], { timeout: 60_000 });
    if (migrate.code !== 0) {
      const errorOutput = migrate.stderr || migrate.stdout || 'Unknown error — check database connection';
      log.error(errorOutput);
      steps.push(subStepFail('Migrations', 'Failed'));
      ctx.results.push({ name: 'Database migrations', status: 'fail', message: 'Migration failed — see output above' });
      logSubSteps(steps);
      return;
    }
    steps.push(subStepPass('Migrations', 'Applied'));
    ctx.results.push({ name: 'Database migrations', status: 'pass', message: 'Applied' });
    s.start('Setting up database...');
  }

  // Seed demo user
  s.message('Seeding demo user...');
  const seed = exec('npm run seed 2>&1', { timeout: 30_000 });
  if (seed.code !== 0) {
    steps.push(subStepFail('Demo user seed', seed.stderr || seed.stdout || 'Seed script failed'));
    ctx.results.push({ name: 'Demo user seed', status: 'fail', message: 'Seed script failed' });
    s.stop('Database setup completed with errors');
    logSubSteps(steps);
    return;
  }
  steps.push(subStepPass('Demo user seed', 'demo@agentpay.dev'));
  ctx.results.push({ name: 'Demo user seed', status: 'pass', message: 'demo@agentpay.dev created' });

  // Extract API key from seed output
  const keyMatch = seed.stdout.match(/Demo user API key \(save this\): (.+)/);
  if (keyMatch) {
    ctx.generatedApiKey = keyMatch[1].trim();
  }

  s.stop('Database setup complete');
  logSubSteps(steps);

  // Show credentials separately — important enough for a note box
  if (ctx.generatedApiKey) {
    note(
      `Email:   demo@agentpay.dev\n` +
      `API Key: ${ctx.generatedApiKey}\n\n` +
      `Save this key — it won't be shown again.\n` +
      `Re-running seed rotates the key (invalidates the old one).`,
      'Demo User Credentials',
    );
  }
}
