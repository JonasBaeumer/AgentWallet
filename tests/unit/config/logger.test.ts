import { Writable } from 'stream';
import { createLogger, MAX_REDACTION_DEPTH, redactCredentials } from '@/config/logger';

function capture(): { destination: Writable; read: () => string } {
  let output = '';
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  });
  return { destination, read: () => output };
}

function nest(depth: number, leaf: Record<string, unknown>): Record<string, unknown> {
  let value: Record<string, unknown> = leaf;
  for (let index = 0; index < depth; index += 1) {
    value = { [`level${index}`]: value };
  }
  return value;
}

describe('Coinbase credential redaction', () => {
  it('redacts top-level and nested Coinbase credential fields', () => {
    const { destination, read } = capture();
    const logger = createLogger(destination);

    logger.info({
      CDP_API_KEY_ID: 'sensitive-key-id',
      config: { CDP_API_KEY_SECRET: 'sensitive-api-secret' },
      coinbase: { credentials: { walletSecret: 'sensitive-wallet-secret' } },
      unrelated: 'visible-value',
    });

    expect(read()).not.toContain('sensitive-key-id');
    expect(read()).not.toContain('sensitive-api-secret');
    expect(read()).not.toContain('sensitive-wallet-secret');
    expect(read()).toContain('[REDACTED]');
    expect(read()).toContain('visible-value');
  });

  it('redacts camel-case credentials used by CDP client configuration', () => {
    const { destination, read } = capture();
    const logger = createLogger(destination);

    logger.info({
      cdp: {
        apiKeyId: 'camel-key-id',
        apiKeySecret: 'camel-api-secret',
        walletSecret: 'camel-wallet-secret',
      },
    });

    expect(read()).not.toContain('camel-key-id');
    expect(read()).not.toContain('camel-api-secret');
    expect(read()).not.toContain('camel-wallet-secret');
  });

  // The previous implementation expanded each field to `field`, `*.field`,
  // `*.*.field`, `*.*.*.field`. `fast-redact`'s `*` matches exactly one level, so
  // anything nested deeper leaked. These cases pin that the cliff is gone.
  it.each([0, 1, 2, 3, 4, 6, 9, MAX_REDACTION_DEPTH - 1])(
    'redacts a credential nested %i levels deep',
    (depth) => {
      const { destination, read } = capture();
      const logger = createLogger(destination);

      logger.info(nest(depth, { apiKeySecret: `secret-at-depth-${depth}` }));

      expect(read()).not.toContain(`secret-at-depth-${depth}`);
      expect(read()).toContain('[REDACTED]');
    },
  );

  it('stops walking past MAX_REDACTION_DEPTH', () => {
    const beyond = nest(MAX_REDACTION_DEPTH + 2, { apiKeySecret: 'past-the-bound' });

    // Documents the one remaining bound. If this ever matters in practice, raise
    // the constant rather than reintroducing finite Pino paths.
    expect(JSON.stringify(redactCredentials(beyond))).toContain('past-the-bound');
  });

  it('redacts credentials inside arrays', () => {
    const { destination, read } = capture();
    const logger = createLogger(destination);

    logger.info({ accounts: [{ nested: { walletSecret: 'array-wallet-secret' } }] });

    expect(read()).not.toContain('array-wallet-secret');
  });

  it('redacts credentials carried on a logged error and keeps message and stack', () => {
    const { destination, read } = capture();
    const logger = createLogger(destination);

    const error = Object.assign(new Error('cdp request failed'), {
      config: { headers: { auth: { apiKeySecret: 'error-api-secret' } } },
    });
    logger.error({ err: error }, 'submission failed');

    expect(read()).not.toContain('error-api-secret');
    expect(read()).toContain('cdp request failed');
    expect(read()).toContain('"stack"');
  });

  // Pino bakes child() bindings into a serialized string at creation and never
  // routes them through a formatter, so they are outside the walk. Overriding
  // child() to cover them breaks Fastify's per-request logger, so callers binding
  // dynamic configuration censor it themselves. This pins both halves.
  it('does not walk bindings passed to child(), but redactCredentials covers them', () => {
    const unguarded = capture();
    createLogger(unguarded.destination)
      .child({ cdp: { apiKeySecret: 'child-binding-secret' } })
      .info('child line');
    expect(unguarded.read()).toContain('child-binding-secret');

    const guarded = capture();
    createLogger(guarded.destination)
      .child(redactCredentials({ cdp: { apiKeySecret: 'child-binding-secret' } }))
      .info('child line');
    expect(guarded.read()).not.toContain('child-binding-secret');
  });

  it('does not fail on circular references', () => {
    const circular: Record<string, unknown> = { walletSecret: 'circular-secret' };
    circular.self = circular;

    const { destination, read } = capture();
    const logger = createLogger(destination);

    expect(() => logger.info(circular)).not.toThrow();
    expect(read()).not.toContain('circular-secret');
  });

  it('leaves objects without credentials untouched', () => {
    const input = { a: { b: { c: 'value' } } };
    expect(redactCredentials(input)).toBe(input);
  });
});
