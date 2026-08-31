import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config({ quiet: true });

type EnvironmentSource = Record<string, string | undefined>;

const UINT256_MAX = (1n << 256n) - 1n;
const MIN_EXECUTOR_ACCOUNT_PREFIX_LENGTH = 2;
const MAX_EXECUTOR_ACCOUNT_PREFIX_LENGTH = 20;
const MAX_X402_CONFIRMATION_COUNT = 64;
const MAX_X402_SUBMISSION_RETRIES = 10;

// NOTE: `required_error` is Zod 3 syntax. Zod 4 replaces it (and
// `invalid_type_error`) with the unified `error` parameter, at which point these
// custom messages silently revert to Zod defaults. The three call sites in this
// file are part of the migration surface tracked by #183.
const nonEmptyString = (name: string) =>
  z
    .string({ required_error: `${name} is required` })
    .trim()
    .min(1, `${name} is required`);

const integerString = (name: string, minimum: number, maximum: number) =>
  z
    .string({ required_error: `${name} is required when crypto payments are enabled` })
    .trim()
    .regex(/^\d+$/, `${name} must be an integer between ${minimum} and ${maximum}`)
    .transform(Number)
    .refine(
      (value) => Number.isSafeInteger(value) && value >= minimum && value <= maximum,
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );

function isPlaceholder(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return (
    normalized.includes('placeholder') ||
    normalized.includes('replace-me') ||
    normalized.includes('replace_me') ||
    normalized.startsWith('your-') ||
    normalized.startsWith('your_') ||
    normalized === 'changeme' ||
    normalized === 'todo'
  );
}

const credential = (name: string) =>
  nonEmptyString(name).refine(
    (value) => !isPlaceholder(value),
    `${name} must not be a placeholder`,
  );

const commonSchema = z.object({
  DATABASE_URL: nonEmptyString('DATABASE_URL'),
  REDIS_URL: nonEmptyString('REDIS_URL'),
  STRIPE_SECRET_KEY: z.string().default('sk_test_placeholder'),
  STRIPE_WEBHOOK_SECRET: z.string().default('whsec_placeholder'),
  WORKER_API_KEY: nonEmptyString('WORKER_API_KEY'),
  PORT: integerString('PORT', 1, 65_535).default('3000'),
  NODE_ENV: z.string().default('development'),
  TELEGRAM_BOT_TOKEN: z.string().default(''),
  TELEGRAM_WEBHOOK_SECRET: z.string().default(''),
  TELEGRAM_TEST_CHAT_ID: z.string().default(''),
  TELEGRAM_TEST_CHANNEL_ID: z.string().default(''),
  // Deliberately stricter than the previous `=== 'true'` test. That form treated
  // a typo such as TELEGRAM_MOCK=1 as "not mocked", which sends real Telegram
  // traffic from a run that was meant to be mocked; failing at startup surfaces
  // it immediately. Blank stays equivalent to unset -- see normalizeSource.
  TELEGRAM_MOCK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  PAYMENT_PROVIDER: z.string().default('stripe'),
  LOG_LEVEL: z.string().default('info'),
  CDP_NETWORK: z
    .literal('base-sepolia', {
      errorMap: () => ({ message: 'CDP_NETWORK must be base-sepolia' }),
    })
    .default('base-sepolia'),
  CDP_EXECUTOR_ACCOUNT_PREFIX: z
    .string()
    .min(
      MIN_EXECUTOR_ACCOUNT_PREFIX_LENGTH,
      `CDP_EXECUTOR_ACCOUNT_PREFIX must contain at least ${MIN_EXECUTOR_ACCOUNT_PREFIX_LENGTH} characters`,
    )
    .max(
      MAX_EXECUTOR_ACCOUNT_PREFIX_LENGTH,
      `CDP_EXECUTOR_ACCOUNT_PREFIX must not exceed ${MAX_EXECUTOR_ACCOUNT_PREFIX_LENGTH} characters`,
    )
    .regex(
      /^[a-z][a-z0-9-]*[a-z0-9]$/,
      'CDP_EXECUTOR_ACCOUNT_PREFIX must use lowercase letters, digits, or hyphens and end with a letter or digit',
    )
    .default('agentwallet-executor'),
});

const enabledCryptoSchema = z.object({
  CDP_API_KEY_ID: credential('CDP_API_KEY_ID'),
  CDP_API_KEY_SECRET: credential('CDP_API_KEY_SECRET'),
  CDP_WALLET_SECRET: credential('CDP_WALLET_SECRET'),
  X402_MAX_PAYMENT_ATOMIC_UNITS: z
    .string({
      required_error: 'X402_MAX_PAYMENT_ATOMIC_UNITS is required when crypto payments are enabled',
    })
    .regex(/^[1-9]\d*$/, 'X402_MAX_PAYMENT_ATOMIC_UNITS must be a positive integer')
    .transform(BigInt)
    .refine(
      (value) => value <= UINT256_MAX,
      'X402_MAX_PAYMENT_ATOMIC_UNITS must fit in an unsigned 256-bit integer',
    ),
  X402_CONFIRMATION_COUNT: integerString('X402_CONFIRMATION_COUNT', 1, MAX_X402_CONFIRMATION_COUNT),
  X402_MAX_SUBMISSION_RETRIES: integerString(
    'X402_MAX_SUBMISSION_RETRIES',
    0,
    MAX_X402_SUBMISSION_RETRIES,
  ),
});

type CommonEnv = z.infer<typeof commonSchema>;

type CryptoEnabledEnv = z.infer<typeof enabledCryptoSchema> & {
  CRYPTO_PAYMENTS_ENABLED: true;
};

type CryptoDisabledEnv = {
  CRYPTO_PAYMENTS_ENABLED: false;
  CDP_API_KEY_ID: undefined;
  CDP_API_KEY_SECRET: undefined;
  CDP_WALLET_SECRET: undefined;
  X402_MAX_PAYMENT_ATOMIC_UNITS: undefined;
  X402_CONFIRMATION_COUNT: undefined;
  X402_MAX_SUBMISSION_RETRIES: undefined;
};

export type Env = CommonEnv & (CryptoEnabledEnv | CryptoDisabledEnv);

export class EnvironmentValidationError extends Error {
  constructor(issues: string[]) {
    super(`Invalid environment configuration: ${issues.join('; ')}`);
    this.name = 'EnvironmentValidationError';
  }
}

function parseSchema<TSchema extends z.ZodTypeAny>(
  schema: TSchema,
  source: EnvironmentSource,
): z.infer<TSchema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;

  throw new EnvironmentValidationError(
    result.error.issues.map((issue) => {
      const path = issue.path.join('.');
      return path ? `${path}: ${issue.message}` : issue.message;
    }),
  );
}

/**
 * `dotenv` sets a key declared without a value to `''`, and `z.string().default()`
 * only fires on `undefined`. Without this, a bare `PORT=` line -- the shape
 * .env.example already uses for the optional Telegram keys -- is a hard startup
 * failure, and a blank STRIPE_SECRET_KEY reaches the Stripe client as `''`
 * instead of the placeholder. Both previously fell back to their defaults via
 * `process.env.X || fallback`, so treat blank as absent everywhere rather than
 * letting the two disagree.
 */
function normalizeSource(source: EnvironmentSource): EnvironmentSource {
  const normalized: EnvironmentSource = {};
  for (const [key, value] of Object.entries(source)) {
    normalized[key] = value === undefined || value.trim() === '' ? undefined : value;
  }
  return normalized;
}

function parseCryptoEnabled(value: string | undefined): boolean {
  if (value === undefined || value === 'false') return false;
  if (value === 'true') return true;
  throw new EnvironmentValidationError([
    'CRYPTO_PAYMENTS_ENABLED must be either "true" or "false"',
  ]);
}

export function loadEnv(rawSource: EnvironmentSource = process.env): Env {
  const source = normalizeSource(rawSource);
  const common = parseSchema(commonSchema, source);

  if (!parseCryptoEnabled(source.CRYPTO_PAYMENTS_ENABLED)) {
    return {
      ...common,
      CRYPTO_PAYMENTS_ENABLED: false,
      CDP_API_KEY_ID: undefined,
      CDP_API_KEY_SECRET: undefined,
      CDP_WALLET_SECRET: undefined,
      X402_MAX_PAYMENT_ATOMIC_UNITS: undefined,
      X402_CONFIRMATION_COUNT: undefined,
      X402_MAX_SUBMISSION_RETRIES: undefined,
    };
  }

  return {
    ...common,
    ...parseSchema(enabledCryptoSchema, source),
    CRYPTO_PAYMENTS_ENABLED: true,
  };
}

export const env = loadEnv();
