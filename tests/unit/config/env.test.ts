const BASE_ENV: Record<string, string | undefined> = {
  DATABASE_URL: 'postgresql://localhost:5432/agentwallet_test',
  REDIS_URL: 'redis://localhost:6379',
  WORKER_API_KEY: 'test-worker-key',
  NODE_ENV: 'test',
};

function getLoader(): typeof import('@/config/env').loadEnv {
  jest.resetModules();
  process.env = { ...BASE_ENV };
  return require('@/config/env').loadEnv;
}

describe('Coinbase environment configuration', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it('starts in Stripe-only mode without Coinbase credentials', () => {
    const env = getLoader()(BASE_ENV);

    expect(env.CRYPTO_PAYMENTS_ENABLED).toBe(false);
    expect(env.CDP_API_KEY_ID).toBeUndefined();
    expect(env.CDP_API_KEY_SECRET).toBeUndefined();
    expect(env.CDP_WALLET_SECRET).toBeUndefined();
    expect(env.CDP_NETWORK).toBe('base-sepolia');
  });

  it('ignores checked-in credential placeholders while crypto is disabled', () => {
    const env = getLoader()({
      ...BASE_ENV,
      CRYPTO_PAYMENTS_ENABLED: 'false',
      CDP_API_KEY_ID: 'your-cdp-api-key-id',
      CDP_API_KEY_SECRET: 'your-cdp-api-key-secret',
      CDP_WALLET_SECRET: 'your-cdp-wallet-secret',
    });

    expect(env.CRYPTO_PAYMENTS_ENABLED).toBe(false);
    expect(env.CDP_API_KEY_ID).toBeUndefined();
    expect(env.CDP_API_KEY_SECRET).toBeUndefined();
    expect(env.CDP_WALLET_SECRET).toBeUndefined();
  });

  it('loads a complete Base Sepolia configuration with typed numeric values', () => {
    const env = getLoader()({
      ...BASE_ENV,
      CRYPTO_PAYMENTS_ENABLED: 'true',
      CDP_API_KEY_ID: 'organizations/test/apiKeys/key-id',
      CDP_API_KEY_SECRET: 'test-ed25519-private-key',
      CDP_WALLET_SECRET: 'test-wallet-secret',
      CDP_NETWORK: 'base-sepolia',
      CDP_EXECUTOR_ACCOUNT_PREFIX: 'agentwallet-test',
      X402_MAX_PAYMENT_ATOMIC_UNITS: '1000000',
      X402_CONFIRMATION_COUNT: '2',
      X402_MAX_SUBMISSION_RETRIES: '3',
    });

    expect(env).toMatchObject({
      CRYPTO_PAYMENTS_ENABLED: true,
      CDP_NETWORK: 'base-sepolia',
      CDP_EXECUTOR_ACCOUNT_PREFIX: 'agentwallet-test',
      X402_MAX_PAYMENT_ATOMIC_UNITS: 1_000_000n,
      X402_CONFIRMATION_COUNT: 2,
      X402_MAX_SUBMISSION_RETRIES: 3,
    });
  });

  it.each(['CDP_API_KEY_ID', 'CDP_API_KEY_SECRET', 'CDP_WALLET_SECRET'])(
    'rejects enabled mode when %s is missing without exposing other credentials',
    (missingName) => {
      const source: Record<string, string | undefined> = {
        ...BASE_ENV,
        CRYPTO_PAYMENTS_ENABLED: 'true',
        CDP_API_KEY_ID: 'sensitive-id',
        CDP_API_KEY_SECRET: 'sensitive-api-secret',
        CDP_WALLET_SECRET: 'sensitive-wallet-secret',
        X402_MAX_PAYMENT_ATOMIC_UNITS: '1000000',
        X402_CONFIRMATION_COUNT: '2',
        X402_MAX_SUBMISSION_RETRIES: '3',
      };
      delete source[missingName];

      expect(() => getLoader()(source)).toThrow(missingName);

      try {
        getLoader()(source);
      } catch (error) {
        const message = String(error);
        expect(message).not.toContain('sensitive-id');
        expect(message).not.toContain('sensitive-api-secret');
        expect(message).not.toContain('sensitive-wallet-secret');
      }
    },
  );

  it.each([
    ['CDP_API_KEY_ID', 'your-cdp-api-key-id'],
    ['CDP_API_KEY_SECRET', 'replace-me'],
    ['CDP_WALLET_SECRET', 'wallet-placeholder'],
  ])('rejects placeholder value for %s', (name, placeholder) => {
    const source = {
      ...BASE_ENV,
      CRYPTO_PAYMENTS_ENABLED: 'true',
      CDP_API_KEY_ID: 'valid-id',
      CDP_API_KEY_SECRET: 'valid-api-secret',
      CDP_WALLET_SECRET: 'valid-wallet-secret',
      X402_MAX_PAYMENT_ATOMIC_UNITS: '1000000',
      X402_CONFIRMATION_COUNT: '2',
      X402_MAX_SUBMISSION_RETRIES: '3',
      [name]: placeholder,
    };

    expect(() => getLoader()(source)).toThrow(`${name} must not be a placeholder`);
  });

  it.each(['base', 'ethereum', 'base-mainnet'])('rejects forbidden network %s', (network) => {
    expect(() => getLoader()({ ...BASE_ENV, CDP_NETWORK: network })).toThrow(
      'CDP_NETWORK must be base-sepolia',
    );
  });

  it.each([
    ['X402_MAX_PAYMENT_ATOMIC_UNITS', '0'],
    ['X402_MAX_PAYMENT_ATOMIC_UNITS', '1.5'],
    ['X402_CONFIRMATION_COUNT', '0'],
    ['X402_CONFIRMATION_COUNT', '65'],
    ['X402_MAX_SUBMISSION_RETRIES', '11'],
  ])('rejects out-of-bounds %s=%s', (name, value) => {
    const source = {
      ...BASE_ENV,
      CRYPTO_PAYMENTS_ENABLED: 'true',
      CDP_API_KEY_ID: 'valid-id',
      CDP_API_KEY_SECRET: 'valid-api-secret',
      CDP_WALLET_SECRET: 'valid-wallet-secret',
      X402_MAX_PAYMENT_ATOMIC_UNITS: '1000000',
      X402_CONFIRMATION_COUNT: '2',
      X402_MAX_SUBMISSION_RETRIES: '3',
      [name]: value,
    };

    expect(() => getLoader()(source)).toThrow(name);
  });

  it('rejects a maximum payment that overflows uint256', () => {
    const uint256Overflow = (1n << 256n).toString();

    expect(() =>
      getLoader()({
        ...BASE_ENV,
        CRYPTO_PAYMENTS_ENABLED: 'true',
        CDP_API_KEY_ID: 'valid-id',
        CDP_API_KEY_SECRET: 'valid-api-secret',
        CDP_WALLET_SECRET: 'valid-wallet-secret',
        X402_MAX_PAYMENT_ATOMIC_UNITS: uint256Overflow,
        X402_CONFIRMATION_COUNT: '2',
        X402_MAX_SUBMISSION_RETRIES: '3',
      }),
    ).toThrow('X402_MAX_PAYMENT_ATOMIC_UNITS must fit in an unsigned 256-bit integer');
  });

  it.each([
    'X402_MAX_PAYMENT_ATOMIC_UNITS',
    'X402_CONFIRMATION_COUNT',
    'X402_MAX_SUBMISSION_RETRIES',
  ])('requires %s when crypto is enabled', (missingName) => {
    const source: Record<string, string | undefined> = {
      ...BASE_ENV,
      CRYPTO_PAYMENTS_ENABLED: 'true',
      CDP_API_KEY_ID: 'valid-id',
      CDP_API_KEY_SECRET: 'valid-api-secret',
      CDP_WALLET_SECRET: 'valid-wallet-secret',
      X402_MAX_PAYMENT_ATOMIC_UNITS: '1000000',
      X402_CONFIRMATION_COUNT: '2',
      X402_MAX_SUBMISSION_RETRIES: '3',
    };
    delete source[missingName];

    expect(() => getLoader()(source)).toThrow(missingName);
  });

  it.each(['UPPERCASE', 'two words', 'a', 'trailing-', 'starts_with_underscore'])(
    'rejects invalid executor account prefix %s',
    (prefix) => {
      expect(() => getLoader()({ ...BASE_ENV, CDP_EXECUTOR_ACCOUNT_PREFIX: prefix })).toThrow(
        'CDP_EXECUTOR_ACCOUNT_PREFIX',
      );
    },
  );

  it('rejects non-boolean feature flag values', () => {
    expect(() => getLoader()({ ...BASE_ENV, CRYPTO_PAYMENTS_ENABLED: 'yes' })).toThrow(
      'CRYPTO_PAYMENTS_ENABLED must be either "true" or "false"',
    );
  });

  it('never exposes the frontend Project ID through server configuration', () => {
    const env = getLoader()({ ...BASE_ENV, VITE_CDP_PROJECT_ID: 'public-project-id' });

    expect(env).not.toHaveProperty('VITE_CDP_PROJECT_ID');
  });
});

describe('blank environment values', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  // dotenv turns a bare `KEY=` line into '', which `z.string().default()` does
  // not treat as absent. The previous `process.env.X || fallback` form did, so
  // blank has to keep meaning "unset" or existing .env files stop booting.
  it.each([
    ['PORT', 'PORT', 3000],
    ['STRIPE_SECRET_KEY', 'STRIPE_SECRET_KEY', 'sk_test_placeholder'],
    ['STRIPE_WEBHOOK_SECRET', 'STRIPE_WEBHOOK_SECRET', 'whsec_placeholder'],
    ['CDP_NETWORK', 'CDP_NETWORK', 'base-sepolia'],
    ['CDP_EXECUTOR_ACCOUNT_PREFIX', 'CDP_EXECUTOR_ACCOUNT_PREFIX', 'agentwallet-executor'],
    ['PAYMENT_PROVIDER', 'PAYMENT_PROVIDER', 'stripe'],
    ['LOG_LEVEL', 'LOG_LEVEL', 'info'],
  ])('treats a blank %s as unset and applies the default', (_label, key, expected) => {
    const env = getLoader()({ ...BASE_ENV, [key]: '' }) as Record<string, unknown>;

    expect(env[key]).toBe(expected);
  });

  it('treats a whitespace-only value as unset', () => {
    expect(getLoader()({ ...BASE_ENV, PORT: '   ' }).PORT).toBe(3000);
  });

  it('accepts a numeric value padded with whitespace, as parseInt did', () => {
    expect(getLoader()({ ...BASE_ENV, PORT: ' 3000 ' }).PORT).toBe(3000);
  });

  it('treats a blank CRYPTO_PAYMENTS_ENABLED as disabled', () => {
    expect(getLoader()({ ...BASE_ENV, CRYPTO_PAYMENTS_ENABLED: '' }).CRYPTO_PAYMENTS_ENABLED).toBe(
      false,
    );
  });

  it('still rejects a required value that is blank', () => {
    expect(() => getLoader()({ ...BASE_ENV, DATABASE_URL: '' })).toThrow(
      /DATABASE_URL is required/,
    );
  });
});

describe('TELEGRAM_MOCK parsing', () => {
  const originalEnv = process.env;

  afterEach(() => {
    process.env = originalEnv;
  });

  it.each([
    ['unset', undefined, false],
    ['blank', '', false],
    ['false', 'false', false],
    ['true', 'true', true],
  ])('resolves %s to %s', (_label, value, expected) => {
    expect(getLoader()({ ...BASE_ENV, TELEGRAM_MOCK: value }).TELEGRAM_MOCK).toBe(expected);
  });

  // Intentional tightening of the old `=== 'true'` test, which silently read a
  // typo as "not mocked" and sent real Telegram traffic.
  it.each(['1', 'TRUE', 'yes', 'on'])('rejects the non-canonical value %s', (value) => {
    expect(() => getLoader()({ ...BASE_ENV, TELEGRAM_MOCK: value })).toThrow(
      /Invalid environment configuration/,
    );
  });
});
