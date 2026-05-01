import http from 'http';
import https from 'https';
import { log, multiselect, confirm, isCancel, spinner } from '@clack/prompts';
import color from 'picocolors';
import { spawn, ChildProcess } from 'child_process';
import { SetupContext, StepResult } from './types';
import { exec, sleep, projectPath, writeEnvFile, commandExists, SubStep, logSubSteps } from './utils';

// ── Types ──────────────────────────────────────────────────────────

interface ServiceResult {
  name: string;
  icon: string;
  detail: string;
  status: StepResult['status'];
}

const PROJECT_ROOT = projectPath();

// ── Health checks ──────────────────────────────────────────────────

function httpHealthCheck(port: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/health`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(data).status === 'ok');
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.setTimeout(2000, () => { req.destroy(); resolve(false); });
  });
}

function isProcessAlive(pid: number | null): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function checkNgrokTunnel(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = http.get('http://127.0.0.1:4040/api/tunnels', (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const tunnels = JSON.parse(data).tunnels;
          const httpsTunnel = tunnels.find((t: any) =>
            t.proto === 'https' && t.config?.addr?.includes('3000'),
          );
          resolve(httpsTunnel?.public_url || tunnels[0]?.public_url || null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(2000, () => { req.destroy(); resolve(null); });
  });
}

// ── Background process spawner (stays referenced for stdio) ───────

function spawnBackground(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): ChildProcess {
  const child = spawn(cmd, args, {
    cwd: opts?.cwd ?? PROJECT_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: opts?.env ? { ...process.env, ...opts.env } : process.env,
    detached: true,
  });
  return child;
}

// ── Service launchers (no spinners — caller manages the spinner) ──

async function startDevServer(
  ctx: SetupContext,
  port: string,
  updateMsg: (msg: string) => void,
): Promise<{ pid: number | null; result: ServiceResult }> {
  updateMsg('Dev server — starting');

  const child = spawnBackground('npx', [
    'ts-node-dev', '--respawn', '--transpile-only',
    '-r', 'tsconfig-paths/register', 'src/server.ts',
  ], { env: ctx.envVars });

  const pid = child.pid ?? null;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { pid: null, result: { name: 'Dev server', icon: color.red('✗'), detail: 'process exited', status: 'fail' } };
    }
    if (await httpHealthCheck(port)) {
      child.unref();
      return { pid, result: { name: 'Dev server', icon: color.green('✓'), detail: `PID ${pid}, port ${port}`, status: 'pass' } };
    }
    await sleep(1000);
  }

  child.unref();
  return { pid, result: { name: 'Dev server', icon: color.yellow('▲'), detail: `PID ${pid} — no health response`, status: 'warn' } };
}

async function startWorker(
  ctx: SetupContext,
  updateMsg: (msg: string) => void,
): Promise<{ pid: number | null; result: ServiceResult; errorHint?: string }> {
  updateMsg('Stub worker — starting');

  const child = spawnBackground('npx', [
    'ts-node', '--transpile-only', '-r', 'tsconfig-paths/register', 'src/worker/stubWorker.ts',
  ], { env: ctx.envVars });

  const pid = child.pid ?? null;

  let stderr = '';
  child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
  let stdout = '';
  child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });

  let exited = false;
  child.on('exit', () => { exited = true; });

  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    if (exited) break;
    if (stdout.toLowerCase().includes('stub worker running')) {
      child.unref();
      return { pid, result: { name: 'Stub worker', icon: color.green('✓'), detail: `PID ${pid}`, status: 'pass' } };
    }
    await sleep(500);
  }

  if (!exited && isProcessAlive(pid)) {
    child.unref();
    return { pid, result: { name: 'Stub worker', icon: color.green('✓'), detail: `PID ${pid}`, status: 'pass' } };
  }

  const errorHint = (stderr || stdout).trim().split('\n').slice(-3).join('\n');
  return { pid: null, result: { name: 'Stub worker', icon: color.red('✗'), detail: 'process exited', status: 'fail' }, errorHint };
}

async function startStripeListener(
  ctx: SetupContext,
  port: string,
  updateMsg: (msg: string) => void,
): Promise<{ pid: number | null; result: ServiceResult }> {
  updateMsg('Stripe listener — starting');

  const key = ctx.envVars.STRIPE_SECRET_KEY;
  const child = spawnBackground('stripe', [
    'listen', '--forward-to', `localhost:${port}/v1/webhooks/stripe`,
    '--api-key', key,
  ]);

  const pid = child.pid ?? null;

  const secret = await new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 25_000);
    let buffer = '';

    function onData(data: Buffer): void {
      buffer += data.toString();
      const match = buffer.match(/whsec_\w+/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[0]);
      }
      if (buffer.includes('level=fatal') || buffer.includes('Authorization failed')) {
        clearTimeout(timeout);
        resolve(null);
      }
    }

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', () => { clearTimeout(timeout); resolve(null); });
    child.on('exit', () => { clearTimeout(timeout); resolve(null); });
  });

  if (secret) {
    ctx.envVars.STRIPE_WEBHOOK_SECRET = secret;
    writeEnvFile(ctx.envPath, ctx.envVars, projectPath('.env.example'));
    child.unref();
    return { pid, result: { name: 'Stripe listener', icon: color.green('✓'), detail: `PID ${pid} — secret captured`, status: 'pass' } };
  }

  if (isProcessAlive(pid)) {
    child.unref();
    return { pid, result: { name: 'Stripe listener', icon: color.yellow('▲'), detail: 'secret not captured', status: 'warn' } };
  }

  return { pid: null, result: { name: 'Stripe listener', icon: color.red('✗'), detail: 'process exited — check Stripe CLI auth', status: 'fail' } };
}

async function startNgrok(
  port: string,
  updateMsg: (msg: string) => void,
): Promise<{ pid: number | null; url: string | null; result: ServiceResult }> {
  updateMsg('ngrok tunnel — starting');

  const authCheck = exec('ngrok config check 2>&1');
  if (authCheck.code !== 0 || authCheck.stderr.includes('ERR')) {
    // Will show as a warning in results
  }

  const child = spawnBackground('ngrok', ['http', port]);
  const pid = child.pid ?? null;

  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return { pid: null, url: null, result: { name: 'ngrok tunnel', icon: color.red('✗'), detail: 'process exited — check ngrok auth', status: 'fail' } };
    }
    const url = await checkNgrokTunnel();
    if (url) {
      child.unref();
      return { pid, url, result: { name: 'ngrok tunnel', icon: color.green('✓'), detail: url, status: 'pass' } };
    }
    await sleep(1000);
  }

  child.unref();
  return { pid, url: null, result: { name: 'ngrok tunnel', icon: color.yellow('▲'), detail: 'URL not detected', status: 'warn' } };
}

async function doRegisterTelegramWebhook(
  ctx: SetupContext,
  ngrokUrl: string,
  updateMsg: (msg: string) => void,
): Promise<ServiceResult> {
  updateMsg('Telegram webhook — registering');

  const token = ctx.envVars.TELEGRAM_BOT_TOKEN;
  const webhookSecret = ctx.envVars.TELEGRAM_WEBHOOK_SECRET;
  const url = `${ngrokUrl}/v1/webhooks/telegram`;

  const ok = await new Promise<boolean>((resolve) => {
    const body = JSON.stringify({
      url,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'callback_query'],
      drop_pending_updates: true,
    });

    const req = https.request(
      `https://api.telegram.org/bot${token}/setWebhook`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data).ok === true);
          } catch {
            resolve(false);
          }
        });
      },
    );
    req.on('error', () => resolve(false));
    req.write(body);
    req.end();
  });

  if (ok) {
    return { name: 'Telegram webhook', icon: color.green('✓'), detail: `at ${ngrokUrl}`, status: 'pass' };
  }
  return { name: 'Telegram webhook', icon: color.red('✗'), detail: 'registration failed', status: 'fail' };
}

// ── Sub-step conversion ───────────────────────────────────────────

function toSubSteps(results: ServiceResult[]): SubStep[] {
  return results.map((r) => ({ icon: r.icon, label: r.name, detail: r.detail }));
}

// ── Main service orchestration ─────────────────────────────────────

export async function launchServices(ctx: SetupContext): Promise<void> {
  log.info('Service launcher — getting your dev environment running');

  const port = ctx.envVars.PORT || '3000';
  const hasStripe = !!(ctx.envVars.STRIPE_SECRET_KEY && !ctx.envVars.STRIPE_SECRET_KEY.includes('placeholder'));
  const hasTelegram = !ctx.skipTelegram && !!ctx.envVars.TELEGRAM_BOT_TOKEN;
  const hasNgrok = commandExists('ngrok');
  const hasStripeCli = commandExists('stripe');

  // ── Collect user preferences (single multiselect) ─────────────

  type ServiceKey = 'dev' | 'worker' | 'stripe' | 'ngrok';

  const options: { value: ServiceKey; label: string; hint?: string }[] = [
    { value: 'dev', label: 'Dev server', hint: 'npm run dev' },
    { value: 'worker', label: 'Stub worker', hint: 'npm run worker' },
  ];
  if (hasStripe && hasStripeCli) {
    options.push({ value: 'stripe', label: 'Stripe webhook listener', hint: 'stripe listen' });
  }
  if (hasTelegram && hasNgrok) {
    options.push({ value: 'ngrok', label: 'ngrok tunnel', hint: `ngrok http ${port}` });
  }

  let selected: Set<ServiceKey>;
  if (ctx.nonInteractive) {
    selected = new Set(options.map((o) => o.value));
  } else {
    const result = await multiselect({
      message: 'Which services should we start as background processes?',
      options,
      initialValues: options.map((o) => o.value),
      required: false,
    });
    if (isCancel(result)) {
      selected = new Set();
    } else {
      selected = new Set(result as ServiceKey[]);
    }
  }

  let telegramAutoRegister = false;
  if (hasTelegram && selected.has('ngrok')) {
    if (!ctx.nonInteractive) {
      const regAnswer = await confirm({
        message: 'Auto-register Telegram webhook once ngrok is up?',
        initialValue: true,
      });
      telegramAutoRegister = !isCancel(regAnswer) && regAnswer;
    } else {
      telegramAutoRegister = true;
    }
  }

  // ── Sequential service startup with single spinner ────────────

  if (selected.size === 0 && !telegramAutoRegister) {
    log.info('No services selected — start them manually when ready');
    return;
  }

  const s = spinner();
  s.start('Starting services...');
  const updateMsg = (msg: string) => s.message(msg);

  const pids: number[] = [];
  const serviceResults: ServiceResult[] = [];
  let workerErrorHint: string | undefined;

  // 1. Dev server
  if (selected.has('dev')) {
    const { pid, result } = await startDevServer(ctx, port, updateMsg);
    serviceResults.push(result);
    if (pid) { pids.push(pid); ctx.launchedServices.add('dev'); }
  }

  // 2. Stub worker
  if (selected.has('worker')) {
    const { pid, result, errorHint } = await startWorker(ctx, updateMsg);
    serviceResults.push(result);
    workerErrorHint = errorHint;
    if (pid) { pids.push(pid); ctx.launchedServices.add('worker'); }
  }

  // 3. Stripe webhook listener
  if (selected.has('stripe')) {
    const { pid, result } = await startStripeListener(ctx, port, updateMsg);
    serviceResults.push(result);
    if (pid) { pids.push(pid); ctx.launchedServices.add('stripe-listen'); }
  }

  // 4. ngrok tunnel
  let ngrokUrl: string | null = null;
  if (selected.has('ngrok')) {
    const { pid, url, result } = await startNgrok(port, updateMsg);
    serviceResults.push(result);
    ngrokUrl = url;
    if (pid) { pids.push(pid); ctx.launchedServices.add('ngrok'); }
  }

  // 5. Telegram webhook registration
  if (telegramAutoRegister && ngrokUrl) {
    const result = await doRegisterTelegramWebhook(ctx, ngrokUrl, updateMsg);
    serviceResults.push(result);
    if (result.status === 'pass') ctx.launchedServices.add('telegram-webhook');
  } else if (telegramAutoRegister && !ngrokUrl) {
    serviceResults.push({ name: 'Telegram webhook', icon: color.yellow('▲'), detail: 'no ngrok URL', status: 'warn' });
  }

  // Stop the outer spinner and show sub-steps inline on the bar
  const passed = serviceResults.filter((r) => r.status === 'pass').length;
  const failed = serviceResults.filter((r) => r.status === 'fail').length;
  s.stop(failed > 0
    ? color.yellow(`Services: ${passed} running, ${failed} failed`)
    : `Services: ${passed} running`,
  );

  // Render each service result as an indented sub-step on the │ bar
  logSubSteps(toSubSteps(serviceResults));

  // Show worker error if it crashed
  if (workerErrorHint) {
    log.error(`Worker error:\n${workerErrorHint}`);
  }

  // Push results to ctx for the final summary
  for (const r of serviceResults) {
    ctx.results.push({ name: r.name, status: r.status, message: r.detail });
  }

  // Cleanup info — compact single line
  if (pids.length > 0) {
    const pidList = pids.join(' ');
    log.info(`Cleanup: ${color.bold(`kill ${pidList}`)}  |  Check: ${color.bold(`ps -p ${pidList} -o pid,command`)}`);
  }
}
