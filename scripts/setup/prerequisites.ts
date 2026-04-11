import { log, confirm, isCancel } from '@clack/prompts';
import { SetupContext, StepResult } from './types';
import { exec, commandExists } from './utils';

function addResult(ctx: SetupContext, result: StepResult): void {
  ctx.results.push(result);
  const icon =
    result.status === 'pass' ? '✓' :
    result.status === 'warn' ? '▲' :
    result.status === 'fail' ? '✗' :
    '○';
  const logFn =
    result.status === 'fail' ? log.error :
    result.status === 'warn' ? log.warn :
    log.success;
  logFn(`${icon} ${result.name}: ${result.message}`);
}

async function offerInstall(
  ctx: SetupContext,
  name: string,
  brewPkg: string | null,
  aptPkg: string | null,
): Promise<boolean> {
  let cmd: string | null = null;
  if (ctx.os === 'darwin' && ctx.hasBrew && brewPkg) {
    cmd = `brew install ${brewPkg}`;
  } else if (ctx.os === 'linux' && ctx.hasApt && aptPkg) {
    cmd = `sudo apt-get install -y ${aptPkg}`;
  }

  if (!cmd) return false;

  let shouldInstall = ctx.nonInteractive;
  if (!ctx.nonInteractive) {
    const answer = await confirm({ message: `Install ${name} via \`${cmd}\`?` });
    if (isCancel(answer)) return false;
    shouldInstall = answer;
  }

  if (!shouldInstall) return false;

  log.info(`Running: ${cmd}`);
  const result = exec(cmd, { timeout: 120_000 });
  return result.code === 0;
}

export async function checkPrerequisites(ctx: SetupContext): Promise<void> {
  log.info('Checking prerequisites...');

  // Docker installed
  if (!commandExists('docker')) {
    addResult(ctx, {
      name: 'Docker',
      status: 'fail',
      message: 'Not installed. Get Docker Desktop: https://docs.docker.com/get-docker/',
    });
  } else {
    // Docker running
    const info = exec('docker info');
    if (info.code !== 0) {
      log.warn('Docker is installed but not running. Please start Docker Desktop.');
      if (!ctx.nonInteractive) {
        log.info('Waiting up to 30s for Docker to start...');
        let started = false;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (exec('docker info').code === 0) {
            started = true;
            break;
          }
        }
        if (!started) {
          addResult(ctx, {
            name: 'Docker',
            status: 'fail',
            message: 'Docker daemon not responding. Start Docker Desktop and re-run setup.',
          });
        } else {
          addResult(ctx, { name: 'Docker', status: 'pass', message: 'Running' });
        }
      } else {
        addResult(ctx, {
          name: 'Docker',
          status: 'fail',
          message: 'Docker daemon not running.',
        });
      }
    } else {
      addResult(ctx, { name: 'Docker', status: 'pass', message: 'Running' });
    }
  }

  // Docker Compose
  const compose = exec('docker compose version');
  if (compose.code !== 0) {
    const composeV1 = exec('docker-compose --version');
    if (composeV1.code !== 0) {
      addResult(ctx, {
        name: 'Docker Compose',
        status: 'fail',
        message: 'Not found. Comes with Docker Desktop, or install separately.',
      });
    } else {
      addResult(ctx, { name: 'Docker Compose', status: 'pass', message: 'v1 (legacy)' });
    }
  } else {
    const version = compose.stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown';
    addResult(ctx, { name: 'Docker Compose', status: 'pass', message: `v${version}` });
  }

  // Stripe CLI (optional)
  if (commandExists('stripe')) {
    const sv = exec('stripe --version');
    addResult(ctx, { name: 'Stripe CLI', status: 'pass', message: sv.stdout || 'Installed' });
  } else {
    const installed = await offerInstall(
      ctx,
      'Stripe CLI',
      'stripe/stripe-cli/stripe',
      null,
    );
    if (installed && commandExists('stripe')) {
      addResult(ctx, { name: 'Stripe CLI', status: 'pass', message: 'Just installed' });
    } else {
      addResult(ctx, {
        name: 'Stripe CLI',
        status: 'warn',
        message: 'Not installed. Needed for local webhook forwarding. https://stripe.com/docs/stripe-cli',
      });
    }
  }

  // ngrok (optional)
  if (commandExists('ngrok')) {
    addResult(ctx, { name: 'ngrok', status: 'pass', message: 'Installed' });
  } else {
    const installed = await offerInstall(ctx, 'ngrok', 'ngrok', null);
    if (installed && commandExists('ngrok')) {
      addResult(ctx, { name: 'ngrok', status: 'pass', message: 'Just installed' });
    } else {
      addResult(ctx, {
        name: 'ngrok',
        status: 'warn',
        message: 'Not installed. Needed for Telegram webhooks and real-time Stripe authorization.',
      });
    }
  }
}
