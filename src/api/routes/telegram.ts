import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { env } from '@/config/env';
import { prisma } from '@/db/client';
import { handleTelegramCallback } from '@/telegram/callbackHandler';
import { handleTelegramMessage } from '@/telegram/signupHandler';
import { linkTelegramSchema } from '@/api/validators/telegram';

export async function telegramRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/webhooks/telegram — receives Telegram updates (callback queries)
  fastify.post(
    '/v1/webhooks/telegram',
    {
      config: {
        rateLimit: {
          max: 200,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => req.ip ?? 'unknown',
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const secretToken = request.headers['x-telegram-bot-api-secret-token'];
      if (!env.TELEGRAM_WEBHOOK_SECRET || secretToken !== env.TELEGRAM_WEBHOOK_SECRET) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const update = request.body as any;

      if (update?.callback_query) {
        handleTelegramCallback(update).catch((err: unknown) => {
          fastify.log.error({ message: 'Telegram callback handler error', error: String(err) });
        });
      }

      if (update?.message) {
        handleTelegramMessage(update).catch((err: unknown) => {
          fastify.log.error({ message: 'Telegram message handler error', error: String(err) });
        });
      }

      return reply.send({ received: true });
    },
  );

  // POST /v1/users/:userId/link-telegram — persist telegramChatId on user
  fastify.post(
    '/v1/users/:userId/link-telegram',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;

      const parsed = linkTelegramSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const { telegramChatId } = parsed.data;

      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) {
        return reply.status(404).send({ error: `User not found: ${userId}` });
      }

      await prisma.user.update({
        where: { id: userId },
        data: { telegramChatId },
      });

      return reply.send({ userId, telegramChatId, linked: true });
    },
  );
}
