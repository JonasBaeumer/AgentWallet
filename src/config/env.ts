import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const nonEmpty = (label: string) =>
  z
    .string({ required_error: `${label} is required` })
    .trim()
    .min(1, `${label} is required`);

export const envSchema = z.object({
  DATABASE_URL: nonEmpty('DATABASE_URL').pipe(
    z
      .string()
      .regex(
        /^postgres(ql)?:\/\//,
        'DATABASE_URL must be a PostgreSQL connection string (postgresql://...)',
      ),
  ),
  REDIS_URL: nonEmpty('REDIS_URL').pipe(
    z
      .string()
      .regex(
        /^redis(s)?:\/\//,
        'REDIS_URL must be a Redis connection string (redis://... or rediss://...)',
      ),
  ),
  WORKER_API_KEY: nonEmpty('WORKER_API_KEY'),
  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),
  PORT: z
    .string()
    .default('3000')
    .transform((v) => Number.parseInt(v, 10))
    .pipe(z.number().int().positive().max(65535)),
  NODE_ENV: z.string().default('development'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_TEST_CHAT_ID: z.string().default(''),
  TELEGRAM_MOCK: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  PAYMENT_PROVIDER: z.string().default('stripe'),
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
});

export type Env = z.infer<typeof envSchema>;

export function formatEnvValidationErrors(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const name = issue.path.join('.') || '(root)';
    return `  - ${name}: ${issue.message}`;
  });
  return [
    '',
    'Environment configuration is invalid. Please fix the following before starting:',
    ...lines,
    '',
    'Tip: copy .env.example to .env and fill in the required values,',
    'or run `./scripts/setup.sh` for a guided setup.',
    '',
  ].join('\n');
}

export function validateEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const message = formatEnvValidationErrors(parsed.error);
    const err = new Error(message);
    err.name = 'EnvValidationError';
    throw err;
  }
  return parsed.data;
}

function loadEnv(): Env {
  try {
    return validateEnv();
  } catch (err) {
    if (err instanceof Error && err.name === 'EnvValidationError') {
      process.stderr.write(`${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }
}

export const env: Env = loadEnv();
