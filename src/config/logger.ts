import pino from 'pino';

const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'test';

export const logger = pino(
  {
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers["stripe-signature"]',
        'req.headers["x-worker-key"]',
      ],
      censor: '[REDACTED]',
    },
  },
  usePretty ? pino.transport({ target: 'pino-pretty', options: { colorize: true } }) : undefined,
);
