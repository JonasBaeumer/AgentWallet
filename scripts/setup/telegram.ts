import { spinner } from '@clack/prompts';
import https from 'https';
import { SetupContext } from './types';
import { isPlaceholder, subStepPass, subStepFail, logSubSteps } from './utils';

function telegramGetMe(token: string): Promise<{ ok: boolean; username?: string }> {
  return new Promise((resolve) => {
    const url = `https://api.telegram.org/bot${token}/getMe`;
    https
      .get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({
              ok: json.ok === true,
              username: json.result?.username,
            });
          } catch {
            resolve({ ok: false });
          }
        });
      })
      .on('error', () => resolve({ ok: false }));
  });
}

export async function setupTelegram(ctx: SetupContext): Promise<void> {
  if (ctx.skipTelegram) {
    ctx.results.push({ name: 'Telegram', status: 'skip', message: 'Skipped by user' });
    return;
  }

  const token = ctx.envVars.TELEGRAM_BOT_TOKEN;
  if (isPlaceholder(token)) {
    ctx.results.push({ name: 'Telegram', status: 'warn', message: 'No bot token configured' });
    return;
  }

  const s = spinner();
  s.start('Validating Telegram bot...');

  s.message('Checking bot token...');
  const result = await telegramGetMe(token);

  if (result.ok) {
    s.stop('Telegram bot validated');
    logSubSteps([subStepPass('Bot token', `@${result.username} verified`)]);
    ctx.results.push({ name: 'Telegram', status: 'pass', message: `@${result.username} verified` });
  } else {
    s.stop('Telegram validation failed');
    logSubSteps([subStepFail('Bot token', 'Invalid — check TELEGRAM_BOT_TOKEN in .env')]);
    ctx.results.push({ name: 'Telegram', status: 'fail', message: 'Invalid bot token — check TELEGRAM_BOT_TOKEN in .env' });
  }
}
