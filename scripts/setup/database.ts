import { log, note, spinner } from '@clack/prompts';
import { SetupContext } from './types';
import { exec } from './utils';

export async function setupDatabase(ctx: SetupContext): Promise<void> {
  log.info('Setting up database...');

  // Prisma generate (always safe to re-run)
  const s = spinner();
  s.start('Generating Prisma client');
  const generate = exec('npx prisma generate', { timeout: 30_000 });
  if (generate.code !== 0) {
    s.stop('Prisma generate failed');
    log.error(generate.stderr);
    ctx.results.push({ name: 'Prisma generate', status: 'fail', message: generate.stderr });
    return;
  }
  s.stop('Prisma client generated');

  // Check migration status
  const status = exec('npx prisma migrate status');
  const isUpToDate = status.stdout.includes('Database schema is up to date');

  if (isUpToDate) {
    log.info('Database migrations already up to date');
    ctx.results.push({ name: 'Database migrations', status: 'pass', message: 'Already up to date' });
  } else {
    s.start('Running database migrations');
    const migrateCmd = ctx.nonInteractive ? 'npx prisma migrate deploy' : 'npx prisma migrate dev';
    const migrate = exec(migrateCmd, { timeout: 60_000 });
    if (migrate.code !== 0) {
      s.stop('Migrations failed');
      log.error(migrate.stderr);
      ctx.results.push({ name: 'Database migrations', status: 'fail', message: 'Migration failed — check output above' });
      return;
    }
    s.stop('Migrations applied');
    ctx.results.push({ name: 'Database migrations', status: 'pass', message: 'Applied' });
  }

  // Seed demo user
  s.start('Seeding demo user');
  const seed = exec('npm run seed 2>&1', { timeout: 30_000 });
  if (seed.code !== 0) {
    s.stop('Seed failed');
    log.error(seed.stderr || seed.stdout);
    ctx.results.push({ name: 'Demo user seed', status: 'fail', message: 'Seed script failed' });
    return;
  }
  s.stop('Demo user seeded');

  // Extract API key from seed output
  const keyMatch = seed.stdout.match(/Demo user API key \(save this\): (.+)/);
  if (keyMatch) {
    ctx.generatedApiKey = keyMatch[1].trim();
    note(
      `Email:   demo@agentpay.dev\n` +
      `API Key: ${ctx.generatedApiKey}\n\n` +
      `Save this key — it won't be shown again.\n` +
      `Re-running seed rotates the key (invalidates the old one).`,
      'Demo User Credentials',
    );
  }

  ctx.results.push({ name: 'Demo user seed', status: 'pass', message: 'demo@agentpay.dev created' });
}
