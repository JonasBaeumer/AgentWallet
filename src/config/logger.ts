import pino from 'pino';

const isDev = process.env.NODE_ENV === 'development';

export const logger = pino(
  { level: process.env.LOG_LEVEL ?? 'info' },
  isDev
    ? pino.transport({ target: 'pino-pretty', options: { colorize: true } })
    : undefined,
);
