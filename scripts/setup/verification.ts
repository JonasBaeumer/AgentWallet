import { log, confirm, isCancel, spinner } from '@clack/prompts';
import http from 'http';
import color from 'picocolors';
import { SetupContext } from './types';
import { exec, sleep, SubStep, subStepPass, subStepFail, subStepWarn, subStepSkip, logSubSteps } from './utils';
import { ChildProcess, spawn } from 'child_process';
import path from 'path';

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

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

// ── Progress bar renderer ──────────────────────────────────────────

const BAR_WIDTH = 30;
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface TestProgress {
  total: number;
  completed: number;
  passed: number;
  failed: number;
  currentFile: string;
  spinnerIdx: number;
  failures: string[];
}

function renderProgressBar(p: TestProgress): string {
  const pct = p.total > 0 ? Math.min(p.completed / p.total, 1) : 0;
  const filled = Math.min(Math.round(pct * BAR_WIDTH), BAR_WIDTH);
  const empty = BAR_WIDTH - filled;

  const bar = color.green('█'.repeat(filled)) + color.dim('░'.repeat(empty));
  const counts = `${p.completed}/${p.total}`;
  const passedStr = color.green(`${p.passed} passed`);
  const failedStr = p.failed > 0 ? color.red(` ${p.failed} failed`) : '';
  const spinner = color.cyan(SPINNER_FRAMES[p.spinnerIdx % SPINNER_FRAMES.length]);
  const file = p.currentFile ? color.dim(` ${p.currentFile}`) : '';

  return `  ${spinner} ${bar} ${counts}  ${passedStr}${failedStr}${file}`;
}

function renderFinalBar(p: TestProgress): string {
  const filled = Math.min(BAR_WIDTH, BAR_WIDTH);
  const bar = color.green('█'.repeat(filled));
  const icon = p.failed > 0 ? color.red('✗') : color.green('✓');
  const passedStr = color.green(`${p.passed} passed`);
  const failedStr = p.failed > 0 ? color.red(` ${p.failed} failed`) : '';
  return `  ${icon} ${bar} ${p.completed}/${p.completed}  ${passedStr}${failedStr}`;
}

function clearLine(): void {
  process.stdout.write('\r\x1b[K');
}

/**
 * Detect how many test suites Jest will run by using --listTests with the
 * exact same arguments that the actual run will use. This ensures the count
 * always matches reality.
 */
function countTestSuites(jestArgs: string[], env?: Record<string, string>): number {
  const result = exec(
    `npx jest --listTests ${jestArgs.join(' ')} 2>/dev/null`,
    { timeout: 15_000, env },
  );
  const files = result.stdout.split('\n').filter((l) => l.trim());
  return files.length;
}

/**
 * Run Jest with a live progress bar. Parses PASS/FAIL lines from Jest output
 * to track suite completion. The total is detected dynamically via --listTests
 * with the same args. If Jest reports more suites than expected, the total
 * adjusts upward automatically.
 */
function runJestWithProgress(
  args: string[],
  opts: { timeout: number; env?: Record<string, string> },
): Promise<{ code: number; passed: number; failed: number; failures: string[] }> {
  // Detect total using the same filters as the actual run
  const detectedTotal = countTestSuites(args, opts.env);
  const total = Math.max(detectedTotal, 1);

  return new Promise((resolve) => {
    const progress: TestProgress = {
      total,
      completed: 0,
      passed: 0,
      failed: 0,
      currentFile: '',
      spinnerIdx: 0,
      failures: [],
    };

    process.stdout.write(renderProgressBar(progress));

    const spinnerInterval = setInterval(() => {
      progress.spinnerIdx++;
      clearLine();
      process.stdout.write(renderProgressBar(progress));
    }, 80);

    const child = spawn('npx', ['jest', ...args], {
      cwd: PROJECT_ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
    }, opts.timeout);

    let outputBuffer = '';

    function processLine(line: string): void {
      const passMatch = line.match(/^(PASS|FAIL)\s+(.+)$/);
      if (passMatch) {
        const [, status, filePath] = passMatch;
        progress.completed++;
        // Auto-adjust total upward if we see more suites than expected
        if (progress.completed > progress.total) {
          progress.total = progress.completed;
        }
        progress.currentFile = filePath.replace(/^.*?tests\//, 'tests/');
        if (status === 'PASS') {
          progress.passed++;
        } else {
          progress.failed++;
          progress.failures.push(filePath);
        }
        clearLine();
        process.stdout.write(renderProgressBar(progress));
      }
    }

    function processChunk(data: Buffer): void {
      outputBuffer += data.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';
      for (const line of lines) {
        processLine(line);
      }
    }

    child.stdout?.on('data', processChunk);
    child.stderr?.on('data', processChunk);

    child.on('close', (code) => {
      clearTimeout(timer);
      clearInterval(spinnerInterval);

      if (outputBuffer.trim()) processLine(outputBuffer.trim());

      // Final count is authoritative
      progress.total = progress.completed;

      clearLine();
      process.stdout.write(renderFinalBar(progress) + '\n');

      resolve({
        code: timedOut ? 124 : (code ?? 1),
        passed: progress.passed,
        failed: progress.failed,
        failures: progress.failures,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(spinnerInterval);
      clearLine();
      process.stdout.write(`  ${color.red('✗')} Test runner failed: ${err.message}\n`);
      resolve({ code: 1, passed: 0, failed: 0, failures: [] });
    });
  });
}

// ── Phase functions ────────────────────────────────────────────────

async function checkHealthEndpoint(ctx: SetupContext): Promise<SubStep> {
  const port = ctx.envVars.PORT || '3000';

  let serverProcess: ChildProcess | null = null;
  try {
    serverProcess = spawn(
      'npx',
      ['ts-node-dev', '--transpile-only', '-r', 'tsconfig-paths/register', 'src/server.ts'],
      {
        cwd: PROJECT_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...ctx.envVars },
      },
    );

    let healthy = false;
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await httpGet(`http://localhost:${port}/health`)) {
        healthy = true;
        break;
      }
    }

    if (healthy) {
      ctx.results.push({ name: 'Health endpoint', status: 'pass', message: `localhost:${port}/health OK` });
      return subStepPass('Health endpoint', `localhost:${port}/health OK`);
    } else {
      ctx.results.push({ name: 'Health endpoint', status: 'warn', message: `No response within 30s` });
      return subStepWarn('Health endpoint', 'No response within 30s');
    }
  } catch (err: any) {
    ctx.results.push({ name: 'Health endpoint', status: 'warn', message: err.message || 'Server start failed' });
    return subStepWarn('Health endpoint', err.message || 'Server start failed');
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

async function runUnitTests(ctx: SetupContext): Promise<SubStep> {
  const jestArgs = ['--no-coverage', '--testPathIgnorePatterns=integration'];

  console.log();
  const result = await runJestWithProgress(jestArgs, { timeout: 120_000 });
  console.log();

  if (result.failures.length > 0) {
    log.warn('Failed suites:');
    for (const f of result.failures) {
      log.warn(`  ${f}`);
    }
  }

  if (result.failed === 0) {
    ctx.results.push({ name: 'Unit tests', status: 'pass', message: `${result.passed} suites passed` });
    return subStepPass('Unit tests', `${result.passed} suites passed`);
  } else {
    ctx.results.push({ name: 'Unit tests', status: 'warn', message: `${result.passed} passed, ${result.failed} failed` });
    return subStepWarn('Unit tests', `${result.passed} passed, ${result.failed} failed`);
  }
}

async function runIntegrationTests(ctx: SetupContext): Promise<SubStep> {
  const jestArgs = [
    '--no-coverage', '--runInBand',
    '--testPathPattern=integration',
    '--testPathIgnorePatterns=\\.live\\.',
  ];
  const env = { ...ctx.envVars, TELEGRAM_MOCK: 'true' };

  const count = countTestSuites(jestArgs, env);
  if (count === 0) {
    ctx.results.push({ name: 'Integration tests', status: 'skip', message: 'No suites found' });
    return subStepSkip('Integration tests', 'No suites found');
  }

  console.log();
  const result = await runJestWithProgress(jestArgs, { timeout: 300_000, env });
  console.log();

  if (result.failures.length > 0) {
    log.warn('Failed suites:');
    for (const f of result.failures) {
      log.warn(`  ${f}`);
    }
  }

  if (result.failed === 0) {
    ctx.results.push({ name: 'Integration tests', status: 'pass', message: `${result.passed} suites passed` });
    return subStepPass('Integration tests', `${result.passed} suites passed`);
  } else {
    ctx.results.push({ name: 'Integration tests', status: 'warn', message: `${result.passed} passed, ${result.failed} failed` });
    return subStepWarn('Integration tests', `${result.passed} passed, ${result.failed} failed`);
  }
}

async function runLiveTelegramTests(ctx: SetupContext): Promise<SubStep> {
  const hasToken = !!ctx.envVars.TELEGRAM_BOT_TOKEN;
  const hasChatId = !!ctx.envVars.TELEGRAM_TEST_CHAT_ID;

  if (!hasToken || !hasChatId) {
    ctx.results.push({ name: 'Live Telegram tests', status: 'skip', message: 'No bot token or chat ID' });
    return subStepSkip('Live Telegram tests', 'No bot token or chat ID');
  }

  const jestArgs = [
    '--no-coverage', '--runInBand', '--forceExit',
    '--config', 'jest.integration.live.js',
    '--testPathPattern=\\.live\\.',
    '--testTimeout=120000',
  ];
  const env = { ...ctx.envVars, TELEGRAM_MOCK: 'false' };

  const count = countTestSuites(jestArgs, env);
  if (count === 0) {
    ctx.results.push({ name: 'Live Telegram tests', status: 'skip', message: 'No suites found' });
    return subStepSkip('Live Telegram tests', 'No suites found');
  }

  log.warn(
    'Open your Telegram chat and follow the bot instructions.\n' +
    'Each step will wait for you to tap a button or send a reply.',
  );

  console.log();
  const result = await runJestWithProgress(jestArgs, { timeout: 600_000, env });
  console.log();

  if (result.failures.length > 0) {
    log.warn('Failed suites:');
    for (const f of result.failures) {
      log.warn(`  ${f}`);
    }
  }

  if (result.failed === 0) {
    ctx.results.push({ name: 'Live Telegram tests', status: 'pass', message: `${result.passed} suites passed` });
    return subStepPass('Live Telegram tests', `${result.passed} suites passed`);
  } else {
    ctx.results.push({ name: 'Live Telegram tests', status: 'warn', message: `${result.passed} passed, ${result.failed} failed` });
    return subStepWarn('Live Telegram tests', `${result.passed} passed, ${result.failed} failed`);
  }
}

export async function runVerification(ctx: SetupContext): Promise<void> {
  const s = spinner();
  s.start('Running verification checks...');

  const steps: SubStep[] = [];

  // Health endpoint
  s.message('Checking health endpoint...');
  const healthStep = await checkHealthEndpoint(ctx);
  steps.push(healthStep);

  // Unit tests — need to stop spinner for progress bar output
  let shouldRunTests = ctx.nonInteractive;
  if (!ctx.nonInteractive) {
    s.stop('Health check complete');
    const answer = await confirm({ message: 'Run unit tests?', initialValue: true });
    shouldRunTests = !isCancel(answer) && answer;
  }

  if (shouldRunTests) {
    if (!ctx.nonInteractive) {
      s.start('Running unit tests...');
    }
    s.stop('Running unit tests...');
    const testStep = await runUnitTests(ctx);
    steps.push(testStep);
  } else {
    s.stop('Verification complete');
    ctx.results.push({ name: 'Unit tests', status: 'skip', message: 'Skipped by user' });
    steps.push(subStepSkip('Unit tests', 'Skipped by user'));
  }

  logSubSteps(steps);
}

export async function runIntegrationSuite(ctx: SetupContext): Promise<void> {
  const hasCriticalFails = ctx.results.some(
    (r) => ['PostgreSQL', 'Redis', 'Database migrations'].includes(r.name) && r.status === 'fail',
  );
  if (hasCriticalFails) {
    log.warn('Skipping integration tests — infrastructure not healthy');
    ctx.results.push({ name: 'Integration tests', status: 'skip', message: 'Infra not ready' });
    return;
  }

  let shouldRun = ctx.nonInteractive;
  if (!ctx.nonInteractive) {
    const answer = await confirm({
      message: 'Run integration tests?',
      initialValue: true,
    });
    shouldRun = !isCancel(answer) && answer;
  }

  if (!shouldRun) {
    ctx.results.push({ name: 'Integration tests', status: 'skip', message: 'Skipped by user' });
    return;
  }

  const steps: SubStep[] = [];

  const s = spinner();
  s.start('Running integration tests...');
  s.stop('Running integration tests...');

  const integrationStep = await runIntegrationTests(ctx);
  steps.push(integrationStep);

  // Offer live Telegram tests if Telegram is configured
  if (!ctx.skipTelegram && ctx.envVars.TELEGRAM_BOT_TOKEN && ctx.envVars.TELEGRAM_TEST_CHAT_ID) {
    let shouldRunLive = ctx.nonInteractive;
    if (!ctx.nonInteractive) {
      const answer = await confirm({
        message: 'Run live Telegram tests? (requires interaction in your Telegram app)',
        initialValue: true,
      });
      shouldRunLive = !isCancel(answer) && answer;
    }

    if (shouldRunLive) {
      const liveStep = await runLiveTelegramTests(ctx);
      steps.push(liveStep);
    } else {
      ctx.results.push({ name: 'Live Telegram tests', status: 'skip', message: 'Skipped by user' });
      steps.push(subStepSkip('Live Telegram tests', 'Skipped by user'));
    }
  }

  logSubSteps(steps);
}
