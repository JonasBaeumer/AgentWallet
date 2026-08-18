import Fastify from 'fastify';
import { logger } from '@/config/logger';
import rateLimit from '@fastify/rate-limit';
import { intentRoutes } from '@/api/routes/intents';
import { approvalRoutes } from '@/api/routes/approvals';
import { agentRoutes } from '@/api/routes/agent';
import { webhookRoutes } from '@/api/routes/webhooks';
import { debugRoutes } from '@/api/routes/debug';
import { telegramRoutes } from '@/api/routes/telegram';
import { checkoutRoutes } from '@/api/routes/checkout';
import { usersRoutes } from '@/api/routes/users';

export function buildApp() {
  const fastify = Fastify({
    loggerInstance: logger,
    // trustProxy unwraps x-forwarded-for set by a trusted upstream proxy so req.ip
    // returns the real client IP. Without this, reading x-forwarded-for directly is
    // client-spoofable and rate-limit keys can be bypassed.
    trustProxy: true,
  });

  // Register content-type parser: for Stripe webhook path pass raw buffer (required for
  // signature verification); for all other application/json parse as JSON.
  fastify.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const path = req.url?.split('?')[0];
    if (path === '/v1/webhooks/stripe') {
      done(null, body);
      return;
    }
    try {
      done(null, JSON.parse(body.toString()));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  // Global rate limit — 60 req/min per IP, Redis-backed in production
  if (process.env.NODE_ENV !== 'test') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getRedisClient } = require('@/config/redis');
    fastify.register(rateLimit, {
      global: true,
      max: 60,
      timeWindow: '1 minute',
      redis: getRedisClient(),
      keyGenerator: (req) => req.ip ?? 'unknown',
      errorResponseBuilder: (_req, context) => ({
        statusCode: 429,
        error: 'rate_limit_exceeded',
        message: `Too many requests. Please retry after ${context.after}.`,
        retryAfter: context.ttl / 1000,
      }),
      addHeadersOnExceeding: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
      },
      addHeaders: {
        'x-ratelimit-limit': true,
        'x-ratelimit-remaining': true,
        'x-ratelimit-reset': true,
        'retry-after': true,
      },
    });
  }

  // Use after() to ensure the rate-limit plugin is loaded before routes are registered,
  // so the global onRoute hook applies to all routes including /health.
  fastify.after(() => {
    // Register routes
    fastify.register(intentRoutes);
    fastify.register(approvalRoutes);
    fastify.register(agentRoutes);
    fastify.register(webhookRoutes);
    fastify.register(debugRoutes);
    fastify.register(telegramRoutes);
    fastify.register(checkoutRoutes);
    fastify.register(usersRoutes);

    fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));
  });

  return fastify;
}
