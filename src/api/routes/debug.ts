import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@/db/client';

export async function debugRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/debug/intents', async (_request: FastifyRequest, reply: FastifyReply) => {
    const intents = await prisma.purchaseIntent.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        userId: true,
        query: true,
        status: true,
        createdAt: true,
        updatedAt: true,
        expiresAt: true,
      },
    });
    return reply.send({ intents });
  });

  fastify.get('/v1/debug/jobs', async (_request: FastifyRequest, reply: FastifyReply) => {
    // Queue depths will be populated once Agent 6 wires in BullMQ
    return reply.send({
      message: 'Queue debug info — BullMQ integration pending (Agent 6)',
      queues: [],
    });
  });

  fastify.get(
    '/v1/debug/ledger/:userId',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      const { userId } = request.params;
      const entries = await prisma.ledgerEntry.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
      });
      const pots = await prisma.pot.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } });
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { mainBalance: true, email: true },
      });
      return reply.send({ user, ledgerEntries: entries, pots });
    },
  );

  fastify.get(
    '/v1/debug/audit/:intentId',
    async (request: FastifyRequest<{ Params: { intentId: string } }>, reply: FastifyReply) => {
      const { intentId } = request.params;
      const events = await prisma.auditEvent.findMany({
        where: { intentId },
        orderBy: { createdAt: 'asc' },
      });
      const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
      return reply.send({ intent, auditEvents: events });
    },
  );
}
