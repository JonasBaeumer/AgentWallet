import { log, confirm, isCancel } from '@clack/prompts';
import http from 'http';
import color from 'picocolors';
import { SetupContext } from './types';
import { exec, sleep } from './utils';
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

async function checkHealthEndpoint(ctx: SetupContext): Promise<void> {
  const port = ctx.envVars.PORT || '3000';

  let frameIdx = 0;
  process.stdout.write(`  ${color.cyan(SPINNER_FRAMES[0])} Starting dev server for health check`);
  const spinInterval = setInterval(() => {
    frameIdx++;
    clearLine();
    process.stdout.write(`  ${color.cyan(SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length])} Starting dev server for health check`);
  }, 80);

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

    clearInterval(spinInterval);
    clearLine();

    if (healthy) {
      process.stdout.write(`  ${color.green('✓')} Health endpoint responding\n`);
      ctx.results.push({ name: 'Health endpoint', status: 'pass', message: `localhost:${port}/health OK` });
    } else {
      process.stdout.write(`  ${color.yellow('▲')} Health endpoint not responding\n`);
      ctx.results.push({
        name: 'Health endpoint',
        status: 'warn',
        message: `localhost:${port}/health did not respond within 30s`,
      });
    }
  } catch (err: any) {
    clearInterval(spinInterval);
    clearLine();
    process.stdout.write(`  ${color.yellow('▲')} Could not start dev server\n`);
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

  // Use --testPathIgnorePatterns to exclude integration tests — same filter
  // is passed to both --listTests (inside runJestWithProgress) and the actual run.
  const jestArgs = ['--no-coverage', '--testPathIgnorePatterns=integration'];

  log.info('Running unit tests...');
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
  } else {
    ctx.results.push({ name: 'Unit tests', status: 'warn', message: `${result.passed} passed, ${result.failed} failed` });
  }
}

export async function runVerification(ctx: SetupContext): Promise<void> {
  log.info('Running verification checks...');
  await checkHealthEndpoint(ctx);
  await runUnitTests(ctx);
}
