import { log, confirm, isCancel, spinner } from '@clack/prompts';
import { SetupContext } from './types';
import { exec, commandExists, SubStep, subStepPass, subStepFail, subStepWarn, logSubSteps } from './utils';

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
  const s = spinner();
  s.start('Checking prerequisites...');

  const steps: SubStep[] = [];

  // Docker installed + running
  s.message('Checking Docker...');
  if (!commandExists('docker')) {
    steps.push(subStepFail('Docker', 'Not installed — https://docs.docker.com/get-docker/'));
    ctx.results.push({ name: 'Docker', status: 'fail', message: 'Not installed. Get Docker Desktop: https://docs.docker.com/get-docker/' });
  } else {
    const info = exec('docker info');
    if (info.code !== 0) {
      s.stop('Docker is installed but not running');
      log.warn('Please start Docker Desktop.');

      if (!ctx.nonInteractive) {
        const s2 = spinner();
        s2.start('Waiting for Docker to start (up to 30s)...');
        let started = false;
        for (let i = 0; i < 15; i++) {
          await new Promise((r) => setTimeout(r, 2000));
          if (exec('docker info').code === 0) {
            started = true;
            break;
          }
        }
        if (started) {
          s2.stop('Docker is now running');
          steps.push(subStepPass('Docker', 'Running'));
          ctx.results.push({ name: 'Docker', status: 'pass', message: 'Running' });
        } else {
          s2.stop('Docker did not start');
          steps.push(subStepFail('Docker', 'Daemon not responding'));
          ctx.results.push({ name: 'Docker', status: 'fail', message: 'Docker daemon not responding. Start Docker Desktop and re-run setup.' });
        }
      } else {
        steps.push(subStepFail('Docker', 'Daemon not running'));
        ctx.results.push({ name: 'Docker', status: 'fail', message: 'Docker daemon not running.' });
      }
      // Restart spinner for remaining checks
      s.start('Checking remaining prerequisites...');
    } else {
      steps.push(subStepPass('Docker', 'Running'));
      ctx.results.push({ name: 'Docker', status: 'pass', message: 'Running' });
    }
  }

  // Docker Compose
  s.message('Checking Docker Compose...');
  const compose = exec('docker compose version');
  if (compose.code !== 0) {
    const composeV1 = exec('docker-compose --version');
    if (composeV1.code !== 0) {
      steps.push(subStepFail('Docker Compose', 'Not found'));
      ctx.results.push({ name: 'Docker Compose', status: 'fail', message: 'Not found. Comes with Docker Desktop, or install separately.' });
    } else {
      steps.push(subStepPass('Docker Compose', 'v1 (legacy)'));
      ctx.results.push({ name: 'Docker Compose', status: 'pass', message: 'v1 (legacy)' });
    }
  } else {
    const version = compose.stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1] ?? 'unknown';
    steps.push(subStepPass('Docker Compose', `v${version}`));
    ctx.results.push({ name: 'Docker Compose', status: 'pass', message: `v${version}` });
  }

  // Stripe CLI (optional) — may need interactive prompt
  s.message('Checking Stripe CLI...');
  if (commandExists('stripe')) {
    const sv = exec('stripe --version');
    const msg = sv.stdout || 'Installed';
    steps.push(subStepPass('Stripe CLI', msg));
    ctx.results.push({ name: 'Stripe CLI', status: 'pass', message: msg });
  } else {
    s.stop('Stripe CLI not found');
    const installed = await offerInstall(ctx, 'Stripe CLI', 'stripe/stripe-cli/stripe', null);
    if (installed && commandExists('stripe')) {
      steps.push(subStepPass('Stripe CLI', 'Just installed'));
      ctx.results.push({ name: 'Stripe CLI', status: 'pass', message: 'Just installed' });
    } else {
      steps.push(subStepWarn('Stripe CLI', 'Not installed — needed for webhook forwarding'));
      ctx.results.push({ name: 'Stripe CLI', status: 'warn', message: 'Not installed. Needed for local webhook forwarding.' });
    }
    s.start('Checking remaining prerequisites...');
  }

  // ngrok (optional)
  s.message('Checking ngrok...');
  if (commandExists('ngrok')) {
    steps.push(subStepPass('ngrok', 'Installed'));
    ctx.results.push({ name: 'ngrok', status: 'pass', message: 'Installed' });
  } else {
    s.stop('ngrok not found');
    const installed = await offerInstall(ctx, 'ngrok', 'ngrok', null);
    if (installed && commandExists('ngrok')) {
      steps.push(subStepPass('ngrok', 'Just installed'));
      ctx.results.push({ name: 'ngrok', status: 'pass', message: 'Just installed' });
    } else {
      steps.push(subStepWarn('ngrok', 'Not installed — needed for Telegram webhooks'));
      ctx.results.push({ name: 'ngrok', status: 'warn', message: 'Not installed. Needed for Telegram webhooks.' });
    }
    s.start('Finishing prerequisites...');
  }

  // Stop and show all sub-steps
  const fails = ctx.results.filter((r) => r.status === 'fail').length;
  const warns = ctx.results.filter((r) => r.status === 'warn').length;
  s.stop(fails > 0 ? 'Prerequisites checked — issues found' : warns > 0 ? 'Prerequisites checked — warnings' : 'All prerequisites satisfied');

  logSubSteps(steps);
}
