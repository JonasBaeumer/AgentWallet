import http from 'http';
import https from 'https';
import { log, select, confirm, isCancel, note } from '@clack/prompts';
import color from 'picocolors';
import { ChildProcess } from 'child_process';
import { SetupContext } from './types';
import { exec, spawnDetached, sleep, projectPath, writeEnvFile, commandExists } from './utils';

// ── Types ──────────────────────────────────────────────────────────

type ServiceStatus = 'stopped' | 'starting' | 'running' | 'failed' | 'skipped';

interface ServiceState {
  name: string;
  status: ServiceStatus;
  detail: string;
  pid: number | null;
  command: string; // manual command for the user
}

// ── Spinner / dashboard rendering ──────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function statusIcon(status: ServiceStatus, frameIdx: number): string {
  switch (status) {
    case 'running':  return color.green('✓');
    case 'failed':   return color.red('✗');
    case 'skipped':  return color.dim('○');
    case 'starting': return color.cyan(SPINNER_FRAMES[frameIdx % SPINNER_FRAMES.length]);
    case 'stopped':  return color.dim('·');
  }
}

function statusColor(status: ServiceStatus, text: string): string {
  switch (status) {
    case 'running':  return color.green(text);
    case 'failed':   return color.red(text);
    case 'skipped':  return color.dim(text);
    case 'starting': return color.cyan(text);
    case 'stopped':  return color.dim(text);
  }
}

function padRight(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

function renderDashboard(services: ServiceState[], frameIdx: number): string {
  const nameWidth = Math.max(...services.map((s) => s.name.length), 20);
  const lines = services.map((s) => {
    const icon = statusIcon(s.status, frameIdx);
    const name = padRight(s.name, nameWidth);
    const detail = statusColor(s.status, s.detail);
    return `  ${icon} ${name}  ${detail}`;
  });
  return lines.join('\n');
}

function clearLines(count: number): void {
  for (let i = 0; i < count; i++) {
    process.stdout.write('\x1b[A\x1b[K');
  }
}

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
    process.kill(pid, 0); // signal 0 = just check if alive
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

function telegramWebhookCheck(token: string): Promise<boolean> {
  return new Promise((resolve) => {
    https.get(`https://api.telegram.org/bot${token}/getWebhookInfo`, (res) => {
      let data = '';
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve(info.ok && info.result?.url?.length > 0);
        } catch {
          resolve(false);
        }
      });
    }).on('error', () => resolve(false));
  });
}

// ── Service launchers ──────────────────────────────────────────────

function launchDevServer(ctx: SetupContext): ChildProcess {
  return spawnDetached('npx', [
    'ts-node-dev', '--respawn', '--transpile-only',
    '-r', 'tsconfig-paths/register', 'src/server.ts',
  ], { env: ctx.envVars });
}

function launchWorker(ctx: SetupContext): ChildProcess {
  return spawnDetached('npx', [
    'ts-node', '-r', 'tsconfig-paths/register', 'src/worker/stubWorker.ts',
  ], { env: ctx.envVars });
}

function launchStripeListen(ctx: SetupContext): { child: ChildProcess; secretPromise: Promise<string | null> } {
  const port = ctx.envVars.PORT || '3000';
  const key = ctx.envVars.STRIPE_SECRET_KEY;
  const child = spawnDetached('stripe', [
    'listen', '--forward-to', `localhost:${port}/v1/webhooks/stripe`,
    '--api-key', key,
  ]);

  const secretPromise = new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 20_000);
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
  });

  return { child, secretPromise };
}

function launchNgrok(port: string): ChildProcess {
  return spawnDetached('ngrok', ['http', port]);
}

async function registerTelegramWebhook(
  token: string,
  webhookSecret: string,
  ngrokUrl: string,
): Promise<boolean> {
  const url = `${ngrokUrl}/v1/webhooks/telegram`;
  return new Promise((resolve) => {
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
}

// ── Main service orchestration ─────────────────────────────────────

type LaunchChoice = 'auto' | 'manual' | 'skip';

async function askLaunchPreference(
  ctx: SetupContext,
  serviceName: string,
  defaultChoice: LaunchChoice = 'auto',
): Promise<LaunchChoice> {
  if (ctx.nonInteractive) return 'auto';

  const result = await select({
    message: `${serviceName}:`,
    options: [
      { value: 'auto' as const, label: 'Start automatically (background process)' },
      { value: 'manual' as const, label: 'I\'ll start it myself in another terminal' },
      { value: 'skip' as const, label: 'Skip' },
    ],
    initialValue: defaultChoice,
  });

  if (isCancel(result)) return 'skip';
  return result;
}

export async function launchServices(ctx: SetupContext): Promise<void> {
  log.info('Service launcher — getting your dev environment running');

  const port = ctx.envVars.PORT || '3000';
  const hasStripe = !!(ctx.envVars.STRIPE_SECRET_KEY && !ctx.envVars.STRIPE_SECRET_KEY.includes('placeholder'));
  const hasTelegram = !ctx.skipTelegram && !!ctx.envVars.TELEGRAM_BOT_TOKEN;
  const hasNgrok = commandExists('ngrok');
  const hasStripeCli = commandExists('stripe');

  // ── Collect user preferences ──────────────────────────────────

  const devChoice = await askLaunchPreference(ctx, 'Dev server (npm run dev)');
  const workerChoice = await askLaunchPreference(ctx, 'Stub worker (npm run worker)');

  let stripeChoice: LaunchChoice = 'skip';
  if (hasStripe && hasStripeCli) {
    stripeChoice = await askLaunchPreference(ctx, 'Stripe webhook listener (stripe listen)');
  }

  let ngrokChoice: LaunchChoice = 'skip';
  let telegramAutoRegister = false;
  if (hasTelegram && hasNgrok) {
    ngrokChoice = await askLaunchPreference(ctx, 'ngrok tunnel (ngrok http ' + port + ')');
    if (ngrokChoice !== 'skip') {
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
  }

  // ── Build service states ──────────────────────────────────────

  const services: ServiceState[] = [];
  const pids: number[] = [];

  const devState: ServiceState = {
    name: 'Dev server',
    status: devChoice === 'skip' ? 'skipped' : 'stopped',
    detail: devChoice === 'skip' ? 'skipped' : 'waiting',
    pid: null,
    command: 'npm run dev',
  };
  services.push(devState);

  const workerState: ServiceState = {
    name: 'Stub worker',
    status: workerChoice === 'skip' ? 'skipped' : 'stopped',
    detail: workerChoice === 'skip' ? 'skipped' : 'waiting',
    pid: null,
    command: 'npm run worker',
  };
  services.push(workerState);

  let stripeState: ServiceState | null = null;
  if (hasStripe && hasStripeCli) {
    stripeState = {
      name: 'Stripe listener',
      status: stripeChoice === 'skip' ? 'skipped' : 'stopped',
      detail: stripeChoice === 'skip' ? 'skipped' : 'waiting',
      pid: null,
      command: `stripe listen --forward-to localhost:${port}/v1/webhooks/stripe --api-key $STRIPE_SECRET_KEY`,
    };
    services.push(stripeState);
  }

  let ngrokState: ServiceState | null = null;
  if (hasTelegram && hasNgrok) {
    ngrokState = {
      name: 'ngrok tunnel',
      status: ngrokChoice === 'skip' ? 'skipped' : 'stopped',
      detail: ngrokChoice === 'skip' ? 'skipped' : 'waiting',
      pid: null,
      command: `ngrok http ${port}`,
    };
    services.push(ngrokState);
  }

  let webhookState: ServiceState | null = null;
  if (hasTelegram && telegramAutoRegister) {
    webhookState = {
      name: 'Telegram webhook',
      status: 'stopped',
      detail: 'waiting for ngrok',
      pid: null,
      command: `curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" -H "Content-Type: application/json" -d '{"url":"<NGROK_URL>/v1/webhooks/telegram","secret_token":"<SECRET>","allowed_updates":["message","callback_query"]}'`,
    };
    services.push(webhookState);
  }

  // ── Launch auto services ──────────────────────────────────────

  if (devChoice === 'auto') {
    devState.status = 'starting';
    devState.detail = 'starting...';
    const child = launchDevServer(ctx);
    devState.pid = child.pid ?? null;
    if (child.pid) pids.push(child.pid);
  } else if (devChoice === 'manual') {
    devState.status = 'starting';
    devState.detail = `run: ${color.bold('npm run dev')}`;
  }

  if (workerChoice === 'auto') {
    workerState.status = 'starting';
    workerState.detail = 'starting...';
    const child = launchWorker(ctx);
    workerState.pid = child.pid ?? null;
    if (child.pid) pids.push(child.pid);
  } else if (workerChoice === 'manual') {
    workerState.status = 'starting';
    workerState.detail = `run: ${color.bold('npm run worker')}`;
  }

  let stripeSecretPromise: Promise<string | null> | null = null;
  if (stripeState && stripeChoice === 'auto') {
    stripeState.status = 'starting';
    stripeState.detail = 'starting...';
    const { child, secretPromise } = launchStripeListen(ctx);
    stripeState.pid = child.pid ?? null;
    if (child.pid) pids.push(child.pid);
    stripeSecretPromise = secretPromise;
  } else if (stripeState && stripeChoice === 'manual') {
    stripeState.status = 'starting';
    stripeState.detail = `run: ${color.bold('stripe listen --forward-to localhost:' + port + '/v1/webhooks/stripe')}`;
  }

  if (ngrokState && ngrokChoice === 'auto') {
    // Check if ngrok has an auth token configured
    const authCheck = exec('ngrok config check 2>&1');
    if (authCheck.code !== 0 || authCheck.stderr.includes('ERR')) {
      log.warn('ngrok may not be authenticated. Run: ngrok config add-authtoken <TOKEN>');
    }
    ngrokState.status = 'starting';
    ngrokState.detail = 'starting...';
    const child = launchNgrok(port);
    ngrokState.pid = child.pid ?? null;
    if (child.pid) pids.push(child.pid);
  } else if (ngrokState && ngrokChoice === 'manual') {
    ngrokState.status = 'starting';
    ngrokState.detail = `run: ${color.bold('ngrok http ' + port)}`;
  }

  // ── Monitoring dashboard ──────────────────────────────────────

  const allSkipped = services.every((s) => s.status === 'skipped');
  if (allSkipped) {
    log.info('All services skipped');
    printManualCommands(services);
    return;
  }

  console.log();
  log.info('Monitoring services... (press Ctrl+C to stop monitoring)\n');

  // Initial render
  let frameIdx = 0;
  process.stdout.write(renderDashboard(services, frameIdx) + '\n');

  let stripeSecretCaptured = false;
  let ngrokUrl: string | null = null;
  let webhookRegistered = false;
  let skipRequested = false;

  // Listen for 's' key to skip
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', (data) => {
      const key = data.toString();
      if (key === 's' || key === 'S') {
        skipRequested = true;
      }
      // Ctrl+C
      if (key === '\x03') {
        process.stdin.setRawMode(false);
        skipRequested = true;
      }
    });
  }

  const maxPolls = 120; // 2 minutes max
  for (let i = 0; i < maxPolls; i++) {
    if (skipRequested) break;

    // Poll dev server
    if (devState.status === 'starting') {
      if (devChoice === 'auto') {
        if (await httpHealthCheck(port)) {
          devState.status = 'running';
          devState.detail = `PID ${devState.pid} — port ${port}`;
        } else if (!isProcessAlive(devState.pid)) {
          devState.status = 'failed';
          devState.detail = 'process exited';
        }
      } else {
        // Manual — just check if the health endpoint responds
        if (await httpHealthCheck(port)) {
          devState.status = 'running';
          devState.detail = `detected on port ${port}`;
        }
      }
    }

    // Poll worker (check process alive for auto, or check BullMQ for manual)
    if (workerState.status === 'starting') {
      if (workerChoice === 'auto') {
        if (isProcessAlive(workerState.pid)) {
          // Give it a few seconds to initialize
          if (i > 3) {
            workerState.status = 'running';
            workerState.detail = `PID ${workerState.pid}`;
          }
        } else {
          workerState.status = 'failed';
          workerState.detail = 'process exited';
        }
      } else {
        // For manual, we can't easily detect the worker without checking Redis
        // Just mark as running after a reasonable wait if dev server is up
        if (i > 10 && devState.status === 'running') {
          workerState.status = 'running';
          workerState.detail = 'assumed running (manual)';
        }
      }
    }

    // Poll stripe listener
    if (stripeState && stripeState.status === 'starting') {
      if (stripeChoice === 'auto' && stripeSecretPromise && !stripeSecretCaptured) {
        // Check if promise resolved
        const result = await Promise.race([
          stripeSecretPromise.then((s) => ({ done: true, secret: s })),
          Promise.resolve({ done: false, secret: null }),
        ]);
        if (result.done) {
          stripeSecretCaptured = true;
          if (result.secret) {
            stripeState.status = 'running';
            stripeState.detail = `PID ${stripeState.pid} — ${result.secret.slice(0, 15)}...`;
            ctx.envVars.STRIPE_WEBHOOK_SECRET = result.secret;
            writeEnvFile(ctx.envPath, ctx.envVars, projectPath('.env.example'));
          } else {
            stripeState.status = 'failed';
            stripeState.detail = 'auth failed — check Stripe API key';
          }
        }
      } else if (stripeChoice === 'manual') {
        // Check if webhook secret in .env has changed from placeholder
        const currentSecret = ctx.envVars.STRIPE_WEBHOOK_SECRET;
        if (currentSecret && !currentSecret.includes('placeholder')) {
          stripeState.status = 'running';
          stripeState.detail = 'webhook secret configured';
        }
      }
    }

    // Poll ngrok
    if (ngrokState && ngrokState.status === 'starting') {
      const tunnelUrl = await checkNgrokTunnel();
      if (tunnelUrl) {
        ngrokUrl = tunnelUrl;
        ngrokState.status = 'running';
        ngrokState.detail = tunnelUrl;
      } else if (ngrokChoice === 'auto' && !isProcessAlive(ngrokState.pid)) {
        ngrokState.status = 'failed';
        ngrokState.detail = 'process exited — may need: ngrok config add-authtoken <TOKEN>';
      }
    }

    // Auto-register Telegram webhook
    if (webhookState && !webhookRegistered && ngrokUrl) {
      webhookState.status = 'starting';
      webhookState.detail = 'registering...';
      const ok = await registerTelegramWebhook(
        ctx.envVars.TELEGRAM_BOT_TOKEN,
        ctx.envVars.TELEGRAM_WEBHOOK_SECRET,
        ngrokUrl,
      );
      if (ok) {
        webhookRegistered = true;
        webhookState.status = 'running';
        webhookState.detail = `registered at ${ngrokUrl}`;
      } else {
        webhookState.status = 'failed';
        webhookState.detail = 'registration failed — see docs/telegram-setup.md';
      }
    }

    // Re-render dashboard
    frameIdx++;
    clearLines(services.length);
    process.stdout.write(renderDashboard(services, frameIdx) + '\n');

    // Check if all active services are terminal (running/failed/skipped)
    const allTerminal = services.every(
      (s) => s.status === 'running' || s.status === 'failed' || s.status === 'skipped',
    );
    if (allTerminal) break;

    await sleep(1000);
  }

  // Clean up stdin
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  console.log();

  // ── Print results ─────────────────────────────────────────────

  const runningServices = services.filter((s) => s.status === 'running');
  const failedServices = services.filter((s) => s.status === 'failed');

  if (runningServices.length > 0) {
    ctx.results.push({
      name: 'Services',
      status: failedServices.length > 0 ? 'warn' : 'pass',
      message: `${runningServices.length} running, ${failedServices.length} failed`,
    });
  }

  // Print manual commands for anything not auto-started
  const manualServices = services.filter(
    (s) => s.status !== 'running' && s.status !== 'skipped',
  );
  if (manualServices.length > 0) {
    printManualCommands(manualServices);
  }

  // Print cleanup command
  if (pids.length > 0) {
    const pidList = pids.join(' ');
    note(
      `To stop all background processes:\n` +
      `  ${color.bold(`kill ${pidList}`)}\n\n` +
      `To check if they're still running:\n` +
      `  ${color.bold(`ps -p ${pidList} -o pid,command`)}`,
      'Cleanup',
    );
  }
}

function printManualCommands(services: ServiceState[]): void {
  const commands = services
    .filter((s) => s.command && s.status !== 'skipped')
    .map((s) => `  ${color.bold(s.command)}`);

  if (commands.length > 0) {
    note(
      'Run these in separate terminals:\n' + commands.join('\n'),
      'Manual Commands',
    );
  }
}
