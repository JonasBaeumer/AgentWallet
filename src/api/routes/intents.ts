import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@/db/client';
import { idempotencyMiddleware, saveIdempotencyResponse } from '@/api/middleware/idempotency';
import { userAuthMiddleware } from '@/api/middleware/userAuth';
import { createIntentSchema } from '@/api/validators/intents';
import { IntentStatus } from '@/contracts';
import { startSearching } from '@/orchestrator/intentService';
import { enqueueSearch } from '@/queue/producers';

export async function intentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/intents
  fastify.post(
    '/v1/intents',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => {
            const auth = req.headers.authorization ?? '';
            // Use the non-secret 16-char prefix (same value as apiKeyPrefix in DB)
            const keyPart = auth.startsWith('Bearer ') ? auth.slice(7, 23) : 'anon';
            return `${keyPart}:${req.ip ?? 'unknown'}`;
          },
        },
      },
      preHandler: [userAuthMiddleware, idempotencyMiddleware],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const idempotencyKey = request.headers['x-idempotency-key'] as string;
      if (!idempotencyKey) {
        return reply.status(400).send({ error: 'X-Idempotency-Key header is required' });
      }

      const parsed = createIntentSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const user = request.user!;
      const userId = user.id;
      const { query, subject, maxBudget, currency, expiresAt } = parsed.data;

      const intent = await prisma.purchaseIntent.create({
        data: {
          userId,
          query,
          subject: subject ?? null,
          maxBudget,
          currency,
          status: IntentStatus.RECEIVED,
          idempotencyKey,
          expiresAt: expiresAt ? new Date(expiresAt) : null,
        },
      });

      // Advance to SEARCHING and enqueue search job
      await startSearching(intent.id);
      await enqueueSearch(intent.id, {
        intentId: intent.id,
        userId,
        query,
        maxBudget,
        currency,
        subject,
      });

      const responseBody = {
        intentId: intent.id,
        status: IntentStatus.SEARCHING,
        createdAt: intent.createdAt,
      };
      await saveIdempotencyResponse(idempotencyKey, responseBody);

      return reply.status(201).send(responseBody);
    },
  );

  // GET /v1/intents/:intentId
  fastify.get<{ Params: { intentId: string } }>(
    '/v1/intents/:intentId',
    {
      preHandler: userAuthMiddleware,
    },
    async (request, reply) => {
      const { intentId } = request.params;
      const intent = await prisma.purchaseIntent.findUnique({
        where: { id: intentId },
        include: { virtualCard: true, auditEvents: { orderBy: { createdAt: 'asc' } } },
      });

      if (!intent) {
        return reply.status(404).send({ error: `Intent not found: ${intentId}` });
      }

      const user = request.user!;
      if (intent.userId !== user.id) {
        return reply.status(403).send({ error: 'Forbidden: intent does not belong to this user' });
      }

      return reply.send({ intent });
    },
  );
}
