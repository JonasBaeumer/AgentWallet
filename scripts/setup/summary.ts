import { note, outro } from '@clack/prompts';
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

export function printSummary(ctx: SetupContext): void {
  // Build status table
  const nameWidth = Math.max(...ctx.results.map((r) => r.name.length), 20);
  const lines = ctx.results.map((r) => {
    const icon = statusIcon(r.status);
    const name = padRight(r.name, nameWidth);
    return `  ${icon} ${name}  ${color.dim(r.message)}`;
  });

  note(lines.join('\n'), 'Setup Results');

  // API key reminder
  if (ctx.generatedApiKey) {
    note(
      `API Key: ${color.bold(ctx.generatedApiKey)}\n` +
      `${color.dim('Save this — it won\'t be shown again.')}`,
      'Demo User API Key',
    );
  }

  // Next steps
  const port = ctx.envVars.PORT || '3000';
  const steps = [
    `${color.bold('npm run dev')}          Start the API server (port ${port})`,
    `${color.bold('npm run worker')}       Start the stub worker`,
    `${color.bold('stripe listen')} ${color.dim(`--forward-to localhost:${port}/v1/webhooks/stripe`)}`,
  ];

  if (!ctx.skipTelegram) {
    steps.push(
      `${color.bold('ngrok http ' + port)}        Expose for Telegram webhooks`,
      `${color.dim('Then register the webhook — see docs/telegram-setup.md step 4')}`,
    );
  }

  steps.push(
    `${color.bold('npm run test:integration')}  Run integration tests (after Stripe + Telegram setup)`,
  );

  note(steps.map((s, i) => `  ${i + 1}. ${s}`).join('\n'), 'Next Steps');

  // Final message
  const hasFails = ctx.results.some((r) => r.status === 'fail');
  if (hasFails) {
    outro(color.yellow('Setup completed with errors — review the results above.'));
  } else {
    outro(color.green('Setup complete! Happy building.'));
  }
}
