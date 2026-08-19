import { Writable } from 'stream';
import { createLogger } from '@/config/logger';

describe('Coinbase credential redaction', () => {
  it('redacts top-level and nested Coinbase credential fields', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(destination);

    logger.info({
      CDP_API_KEY_ID: 'sensitive-key-id',
      config: { CDP_API_KEY_SECRET: 'sensitive-api-secret' },
      coinbase: { credentials: { walletSecret: 'sensitive-wallet-secret' } },
      unrelated: 'visible-value',
    });

    expect(output).not.toContain('sensitive-key-id');
    expect(output).not.toContain('sensitive-api-secret');
    expect(output).not.toContain('sensitive-wallet-secret');
    expect(output).toContain('[REDACTED]');
    expect(output).toContain('visible-value');
  });

  it('redacts camel-case credentials used by CDP client configuration', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger(destination);

    logger.info({
      cdp: {
        apiKeyId: 'camel-key-id',
        apiKeySecret: 'camel-api-secret',
        walletSecret: 'camel-wallet-secret',
      },
    });

    expect(output).not.toContain('camel-key-id');
    expect(output).not.toContain('camel-api-secret');
    expect(output).not.toContain('camel-wallet-secret');
  });
});
