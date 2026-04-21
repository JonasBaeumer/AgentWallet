import { validateEnv, formatEnvValidationErrors, envSchema } from '@/config/env';

type EnvSource = Record<string, string | undefined>;

describe('env validator', () => {
  const VALID: EnvSource = {
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/agentpay',
    REDIS_URL: 'redis://localhost:6379',
    WORKER_API_KEY: 'local-dev-worker-key',
  };

  it('accepts a minimal valid configuration and applies defaults', () => {
    const env = validateEnv(VALID);
    expect(env.DATABASE_URL).toBe(VALID.DATABASE_URL);
    expect(env.PORT).toBe(3000);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.TELEGRAM_MOCK).toBe(false);
    expect(env.PAYMENT_PROVIDER).toBe('stripe');
  });

  it('coerces PORT and TELEGRAM_MOCK from strings', () => {
    const env = validateEnv({ ...VALID, PORT: '8080', TELEGRAM_MOCK: 'true' });
    expect(env.PORT).toBe(8080);
    expect(env.TELEGRAM_MOCK).toBe(true);
  });

  it('throws an EnvValidationError listing every missing required variable', () => {
    expect.assertions(6);
    try {
      validateEnv({});
    } catch (err) {
      const e = err as Error;
      expect(e.name).toBe('EnvValidationError');
      expect(e.message).toContain('DATABASE_URL');
      expect(e.message).toContain('REDIS_URL');
      expect(e.message).toContain('WORKER_API_KEY');
      expect(e.message).toContain('Environment configuration is invalid');
      expect(e.message).toContain('./scripts/setup.sh');
    }
  });

  it('rejects malformed DATABASE_URL and REDIS_URL values', () => {
    let caught: Error | undefined;
    try {
      validateEnv({
        ...VALID,
        DATABASE_URL: 'mysql://localhost',
        REDIS_URL: 'http://localhost',
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.name).toBe('EnvValidationError');
    expect(caught?.message).toMatch(/DATABASE_URL.*PostgreSQL/);
    expect(caught?.message).toMatch(/REDIS_URL.*Redis/);
  });

  it('rejects invalid LOG_LEVEL values', () => {
    expect(() => validateEnv({ ...VALID, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
  });

  it('formatEnvValidationErrors produces one bullet per issue', () => {
    const parsed = envSchema.safeParse({});
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const formatted = formatEnvValidationErrors(parsed.error);
      const bullets = formatted.split('\n').filter((line) => line.startsWith('  - '));
      expect(bullets.length).toBeGreaterThanOrEqual(3);
      expect(bullets.join('\n')).toMatch(/DATABASE_URL/);
    }
  });
});
