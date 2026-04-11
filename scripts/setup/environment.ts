import fs from 'fs';
import { text, confirm, password, log, note, isCancel } from '@clack/prompts';
import { SetupContext } from './types';
import {
  projectPath,
  readEnvFile,
  writeEnvFile,
  generateRandomHex,
  isPlaceholder,
} from './utils';

const ENV_PATH = projectPath('.env');
const ENV_EXAMPLE_PATH = projectPath('.env.example');

const DEFAULTS: Record<string, string> = {
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agentpay',
  REDIS_URL: 'redis://localhost:6379',
  WORKER_API_KEY: 'local-dev-worker-key',
  PORT: '3000',
  LOG_LEVEL: 'info',
  TELEGRAM_MOCK: 'false',
};

async function promptOrDefault(
  ctx: SetupContext,
  key: string,
  defaultVal: string,
): Promise<string> {
  if (ctx.nonInteractive) {
    return process.env[key] || defaultVal;
  }
  const result = await text({
    message: `${key}`,
    initialValue: defaultVal,
  });
  if (isCancel(result)) return defaultVal;
  return result || defaultVal;
}

export async function setupEnvironment(ctx: SetupContext): Promise<void> {
  log.info('Setting up environment...');

  // Copy .env.example if .env doesn't exist
  if (!fs.existsSync(ENV_PATH)) {
    fs.copyFileSync(ENV_EXAMPLE_PATH, ENV_PATH);
    log.success('Created .env from .env.example');
  } else {
    log.info('Found existing .env — updating missing values only');
  }

  const envVars = readEnvFile(ENV_PATH);

  // ── Stripe secret key (required) ────────────────────────────────
  if (isPlaceholder(envVars.STRIPE_SECRET_KEY)) {
    if (ctx.nonInteractive) {
      const fromEnv = process.env.STRIPE_SECRET_KEY;
      if (fromEnv && fromEnv.startsWith('sk_test_')) {
        envVars.STRIPE_SECRET_KEY = fromEnv;
      } else {
        log.warn('STRIPE_SECRET_KEY not set or invalid. Stripe features will be skipped.');
      }
    } else {
      note(
        'Get your test-mode secret key from:\n' +
        'Stripe Dashboard → Developers → API keys\n' +
        'https://dashboard.stripe.com/test/apikeys',
        'Stripe API Key',
      );

      const key = await password({
        message: 'STRIPE_SECRET_KEY (must start with sk_test_)',
        validate: (v) => {
          if (!v) return 'Required — enter your Stripe test secret key';
          if (!v.startsWith('sk_test_')) return 'Must start with sk_test_';
          return undefined;
        },
      });

      if (!isCancel(key) && key) {
        envVars.STRIPE_SECRET_KEY = key;
      }
    }
  } else {
    log.info('STRIPE_SECRET_KEY already configured');
  }

  // STRIPE_WEBHOOK_SECRET — will be auto-filled by Stripe CLI phase
  if (isPlaceholder(envVars.STRIPE_WEBHOOK_SECRET)) {
    envVars.STRIPE_WEBHOOK_SECRET = 'whsec_placeholder';
  }

  // ── Telegram opt-in ─────────────────────────────────────────────
  if (ctx.nonInteractive) {
    ctx.skipTelegram = !process.env.TELEGRAM_BOT_TOKEN;
  } else {
    const wantTelegram = await confirm({
      message: 'Set up Telegram bot integration?',
      initialValue: true,
    });
    ctx.skipTelegram = isCancel(wantTelegram) || !wantTelegram;
  }

  if (!ctx.skipTelegram) {
    if (isPlaceholder(envVars.TELEGRAM_BOT_TOKEN)) {
      if (ctx.nonInteractive) {
        envVars.TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
      } else {
        note(
          'Create a bot via @BotFather on Telegram.\n' +
          'Send /newbot, follow the prompts, and copy the token.',
          'Telegram Bot Token',
        );

        const token = await text({
          message: 'TELEGRAM_BOT_TOKEN',
          placeholder: '123456789:ABCdef...',
          validate: (v) => {
            if (!v) return 'Required for Telegram integration';
            if (!v.includes(':')) return 'Token format: <number>:<string>';
            return undefined;
          },
        });

        if (!isCancel(token) && token) {
          envVars.TELEGRAM_BOT_TOKEN = token;
        }
      }
    } else {
      log.info('TELEGRAM_BOT_TOKEN already configured');
    }

    // Auto-generate webhook secret
    if (isPlaceholder(envVars.TELEGRAM_WEBHOOK_SECRET)) {
      envVars.TELEGRAM_WEBHOOK_SECRET = generateRandomHex(32);
      log.info('Generated TELEGRAM_WEBHOOK_SECRET');
    }

    // Telegram chat ID
    if (!envVars.TELEGRAM_TEST_CHAT_ID) {
      if (ctx.nonInteractive) {
        envVars.TELEGRAM_TEST_CHAT_ID = process.env.TELEGRAM_TEST_CHAT_ID || '';
      } else {
        note(
          'Message @userinfobot on Telegram to get your numeric chat ID.\n' +
          'This lets the seed script link your Telegram to the demo user.',
          'Telegram Chat ID',
        );

        const chatId = await text({
          message: 'TELEGRAM_TEST_CHAT_ID (numeric)',
          placeholder: '123456789',
          validate: (v) => {
            if (!v) return undefined; // optional
            if (!/^\d+$/.test(v)) return 'Must be a numeric ID';
            return undefined;
          },
        });

        if (!isCancel(chatId) && chatId) {
          envVars.TELEGRAM_TEST_CHAT_ID = chatId;
        }
      }
    } else {
      log.info('TELEGRAM_TEST_CHAT_ID already configured');
    }
  }

  // ── Defaults with opt-in customization ──────────────────────────
  let useDefaults = true;
  if (!ctx.nonInteractive) {
    const defaultsDisplay = Object.entries(DEFAULTS)
      .map(([k, v]) => `  ${k}=${v}`)
      .join('\n');

    note(defaultsDisplay, 'Infrastructure Defaults');

    const acceptDefaults = await confirm({
      message: 'Use these defaults? (No to customize individually)',
      initialValue: true,
    });
    useDefaults = isCancel(acceptDefaults) || acceptDefaults;
  }

  for (const [key, defaultVal] of Object.entries(DEFAULTS)) {
    if (envVars[key] && envVars[key] !== defaultVal) {
      // User already has a custom value — keep it
      continue;
    }
    if (useDefaults) {
      envVars[key] = envVars[key] || defaultVal;
    } else {
      envVars[key] = await promptOrDefault(ctx, key, envVars[key] || defaultVal);
    }
  }

  // ── Write back ──────────────────────────────────────────────────
  writeEnvFile(ENV_PATH, envVars, ENV_EXAMPLE_PATH);
  ctx.envVars = envVars;
  ctx.envPath = ENV_PATH;

  ctx.results.push({
    name: 'Environment',
    status: 'pass',
    message: '.env configured',
  });
  log.success('.env file configured');
}
