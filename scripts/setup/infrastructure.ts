import { log } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, pollUntil } from './utils';

function isContainerRunning(serviceName: string): boolean {
  const result = exec(`docker compose ps --format json ${serviceName}`);
  if (result.code !== 0) return false;
  // docker compose ps --format json outputs one JSON object per line
  for (const line of result.stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj.State === 'running') return true;
    } catch {
      // Not JSON — older docker compose may output plain text
      if (line.toLowerCase().includes('running')) return true;
    }
  }
  return false;
}

export async function startInfrastructure(ctx: SetupContext): Promise<void> {
  log.info('Starting infrastructure...');

  const pgRunning = isContainerRunning('postgres');
  const redisRunning = isContainerRunning('redis');

  if (pgRunning && redisRunning) {
    log.info('Docker containers already running — skipping');
    ctx.results.push({ name: 'PostgreSQL', status: 'pass', message: 'Already running' });
    ctx.results.push({ name: 'Redis', status: 'pass', message: 'Already running' });
    return;
  }

  // Start containers
  const up = exec('docker compose up -d', { timeout: 60_000 });
  if (up.code !== 0) {
    log.error(`docker compose up failed: ${up.stderr}`);
    ctx.results.push({ name: 'PostgreSQL', status: 'fail', message: 'docker compose up failed' });
    ctx.results.push({ name: 'Redis', status: 'fail', message: 'docker compose up failed' });
    return;
  }

  // Health-check Postgres
  const pgReady = await pollUntil(
    () => exec('docker compose exec -T postgres pg_isready -U postgres').code === 0,
    { intervalMs: 1000, timeoutMs: 30_000, label: 'Waiting for PostgreSQL' },
  );
  ctx.results.push({
    name: 'PostgreSQL',
    status: pgReady ? 'pass' : 'fail',
    message: pgReady ? 'Healthy' : 'Timed out — check `docker compose logs postgres`',
  });

  // Health-check Redis
  const redisReady = await pollUntil(
    () => exec('docker compose exec -T redis redis-cli ping').stdout.includes('PONG'),
    { intervalMs: 1000, timeoutMs: 15_000, label: 'Waiting for Redis' },
  );
  ctx.results.push({
    name: 'Redis',
    status: redisReady ? 'pass' : 'fail',
    message: redisReady ? 'Healthy' : 'Timed out — check `docker compose logs redis`',
  });
}
