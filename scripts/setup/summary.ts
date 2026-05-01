import { log, note, outro } from '@clack/prompts';
import color from 'picocolors';
import { SetupContext, StepResult } from './types';

function statusIcon(status: StepResult['status']): string {
  switch (status) {
    case 'pass': return color.green('✓');
    case 'fail': return color.red('✗');
    case 'warn': return color.yellow('▲');
    case 'skip': return color.dim('○');
  }
}

function padRight(str: string, len: number): string {
  return str + ' '.repeat(Math.max(0, len - str.length));
}

// Service names that are already shown in the Services block
const SERVICE_NAMES = new Set([
  'Dev server', 'Stub worker', 'Stripe listener', 'ngrok tunnel', 'Telegram webhook',
]);

export function printSummary(ctx: SetupContext): void {
  // Filter out service results (already shown in Services block)
  const setupResults = ctx.results.filter((r) => !SERVICE_NAMES.has(r.name));

  // Build compact two-column status table
  const nameWidth = Math.max(...setupResults.map((r) => r.name.length), 18);
  const msgWidth = Math.max(...setupResults.map((r) => r.message.length), 10);
  const colWidth = 4 + nameWidth + 2 + msgWidth; // icon + name + gap + msg

  // Try two-column layout if terminal is wide enough
  const termWidth = process.stdout.columns || 80;
  const useTwoCol = termWidth >= colWidth * 2 + 6;

  const entries = setupResults.map((r) => {
    const icon = statusIcon(r.status);
    const name = padRight(r.name, nameWidth);
    return `${icon} ${name}  ${color.dim(r.message)}`;
  });

  let lines: string[];
  if (useTwoCol && entries.length > 4) {
    const mid = Math.ceil(entries.length / 2);
    const left = entries.slice(0, mid);
    const right = entries.slice(mid);
    lines = [];
    for (let i = 0; i < mid; i++) {
      const l = padRight(left[i] || '', colWidth);
      const r = right[i] || '';
      lines.push(`  ${l}  ${r}`);
    }
  } else {
    lines = entries.map((e) => `  ${e}`);
  }

  note(lines.join('\n'), 'Setup Results');

  // API key — compact inline
  if (ctx.generatedApiKey) {
    log.info(`API Key: ${color.bold(ctx.generatedApiKey)}  ${color.dim("(save this — shown once)")}`);
  }

  // Next steps — only show items that weren't auto-launched
  const port = ctx.envVars.PORT || '3000';
  const launched = ctx.launchedServices;
  const steps: string[] = [];

  if (!launched.has('dev')) {
    steps.push(`${color.bold('npm run dev')}  ${color.dim(`API server (port ${port})`)}`);
  }
  if (!launched.has('worker')) {
    steps.push(`${color.bold('npm run worker')}  ${color.dim('stub worker')}`);
  }
  if (!launched.has('stripe-listen')) {
    steps.push(`${color.bold('stripe listen')} ${color.dim(`--forward-to localhost:${port}/v1/webhooks/stripe`)}`);
  }
  if (!ctx.skipTelegram) {
    if (!launched.has('ngrok')) {
      steps.push(`${color.bold('ngrok http ' + port)}  ${color.dim('Telegram webhooks')}`);
    }
    if (!launched.has('telegram-webhook')) {
      steps.push(color.dim('Register webhook — see docs/telegram-setup.md'));
    }
  }
  if (steps.length > 0) {
    log.step('Next steps:');
    for (const [i, step] of steps.entries()) {
      log.message(`  ${i + 1}. ${step}`);
    }
  }

  // Final message
  const hasFails = ctx.results.some((r) => r.status === 'fail');
  if (hasFails) {
    outro(color.yellow('Setup completed with errors — review the results above.'));
  } else {
    outro(color.green('Setup complete! Happy building.'));
  }
}
