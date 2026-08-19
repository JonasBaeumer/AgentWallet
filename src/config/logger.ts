import pino, { DestinationStream, Logger, LoggerOptions } from 'pino';

const usePretty = process.stdout.isTTY && process.env.NODE_ENV !== 'test';

const coinbaseCredentialFields = [
  'CDP_API_KEY_ID',
  'CDP_API_KEY_SECRET',
  'CDP_WALLET_SECRET',
  'cdpApiKeyId',
  'cdpApiKeySecret',
  'cdpWalletSecret',
  'apiKeyId',
  'apiKeySecret',
  'walletSecret',
];

export const COINBASE_REDACTION_PATHS = coinbaseCredentialFields.flatMap((field) => [
  field,
  `*.${field}`,
  `*.*.${field}`,
  `*.*.*.${field}`,
]);

const options: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers["stripe-signature"]',
      'req.headers["x-worker-key"]',
      ...COINBASE_REDACTION_PATHS,
    ],
    censor: '[REDACTED]',
  },
};

export function createLogger(destination?: DestinationStream): Logger {
  return destination ? pino(options, destination) : pino(options);
}

export const logger = usePretty
  ? pino(options, pino.transport({ target: 'pino-pretty', options: { colorize: true } }))
  : createLogger();
