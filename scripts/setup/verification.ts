import { log, confirm, spinner, isCancel } from '@clack/prompts';
import http from 'http';
import { SetupContext } from './types';
import { exec, sleep } from './utils';
import { ChildProcess, spawn } from 'child_process';

function httpGet(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(3000, () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function checkHealthEndpoint(ctx: SetupContext): Promise<void> {
  const port = ctx.envVars.PORT || '3000';
  const s = spinner();
  s.start('Starting dev server for health check');

  let serverProcess: ChildProcess | null = null;
  try {
    serverProcess = spawn(
      'npx',
      ['ts-node-dev', '--transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts'],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...ctx.envVars },
      },
    );

    // Wait for server to start (poll health endpoint)
    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await httpGet(`http://localhost:${port}/health`)) {
        healthy = true;
        break;
      }
    }

    if (healthy) {
      s.stop('Health endpoint responding');
      ctx.results.push({ name: 'Health endpoint', status: 'pass', message: `localhost:${port}/health OK` });
    } else {
      s.stop('Health endpoint not responding');
      ctx.results.push({
        name: 'Health endpoint',
        status: 'warn',
        message: `localhost:${port}/health did not respond within 30s`,
      });
    }
  } catch (err: any) {
    s.stop('Could not start dev server');
    ctx.results.push({
      name: 'Health endpoint',
      status: 'warn',
      message: err.message || 'Server start failed',
    });
  } finally {
    if (serverProcess && serverProcess.pid) {
      try {
        process.kill(-serverProcess.pid, 'SIGTERM');
      } catch {
        try { serverProcess.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }
  }
}

async function runUnitTests(ctx: SetupContext): Promise<void> {
  let shouldRun = ctx.nonInteractive;
  if (!ctx.nonInteractive) {
    const answer = await confirm({ message: 'Run unit tests?', initialValue: true });
    shouldRun = !isCancel(answer) && answer;
  }

  if (!shouldRun) {
    ctx.results.push({ name: 'Unit tests', status: 'skip', message: 'Skipped by user' });
    return;
  }

  const s = spinner();
  s.start('Running unit tests');
  const result = exec('npm test 2>&1', { timeout: 120_000 });
  if (result.code === 0) {
    s.stop('Unit tests passed');
    ctx.results.push({ name: 'Unit tests', status: 'pass', message: 'All passing' });
  } else {
    s.stop('Unit tests failed');
    log.warn('Some tests failed — review output above');
    ctx.results.push({ name: 'Unit tests', status: 'warn', message: 'Some tests failed' });
  }
}

async function runIntegrationTests(ctx: SetupContext): Promise<void> {
  // Only offer if Docker is running and Stripe is configured
  const hasDocker = ctx.results.some((r) => r.name === 'PostgreSQL' && r.status === 'pass');
  const hasStripe = ctx.results.some((r) => r.name === 'Stripe API' && r.status === 'pass');

  if (!hasDocker || !hasStripe) {
    ctx.results.push({
      name: 'Integration tests',
      status: 'skip',
      message: 'Requires running Docker + valid Stripe key',
    });
    return;
  }

  let shouldRun = false;
  if (ctx.nonInteractive) {
    shouldRun = process.env.SETUP_RUN_INTEGRATION === '1';
  } else {
    const answer = await confirm({ message: 'Run integration tests? (takes longer)', initialValue: false });
    shouldRun = !isCancel(answer) && answer;
  }

  if (!shouldRun) {
    ctx.results.push({ name: 'Integration tests', status: 'skip', message: 'Skipped by user' });
    return;
  }

  const s = spinner();
  s.start('Running integration tests');
  const result = exec('npm run test:integration 2>&1', { timeout: 300_000 });
  if (result.code === 0) {
    s.stop('Integration tests passed');
    ctx.results.push({ name: 'Integration tests', status: 'pass', message: 'All passing' });
  } else {
    s.stop('Integration tests had failures');
    ctx.results.push({ name: 'Integration tests', status: 'warn', message: 'Some tests failed' });
  }
}

export async function runVerification(ctx: SetupContext): Promise<void> {
  log.info('Running verification checks...');
  await checkHealthEndpoint(ctx);
  await runUnitTests(ctx);
  await runIntegrationTests(ctx);
}
