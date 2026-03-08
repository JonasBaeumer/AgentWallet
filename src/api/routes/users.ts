import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { userAuthMiddleware } from '@/api/middleware/userAuth';
import { prisma } from '@/db/client';
import { expireIntent } from '@/orchestrator/intentService';
import { IntentStatus } from '@/contracts';

const ACTIVE_INTENT_STATUSES: IntentStatus[] = [
  IntentStatus.RECEIVED,
  IntentStatus.SEARCHING,
  IntentStatus.QUOTED,
  IntentStatus.AWAITING_APPROVAL,
  IntentStatus.APPROVED,
  IntentStatus.CARD_ISSUED,
  IntentStatus.CHECKOUT_RUNNING,
];

export async function usersRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/users/me', {
    preHandler: userAuthMiddleware,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const user = request.user!;
    return reply.send({
      id: user.id,
      email: user.email,
      mainBalance: user.mainBalance,
      maxBudgetPerIntent: user.maxBudgetPerIntent,
      createdAt: user.createdAt,
    });
  });

  // POST /v1/users/:userId/unlink-agent
  // Cancels all active intents for the linked agent, then removes the agent link.
  // Only the authenticated user may unlink their own agent.
  fastify.post('/v1/users/:userId/unlink-agent', {
    preHandler: userAuthMiddleware,
  }, async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
    const authedUser = request.user!;
    const { userId } = request.params;

    if (authedUser.id !== userId) {
      return reply.status(403).send({ error: 'Forbidden: you may only unlink your own agent' });
    }

    if (!authedUser.agentId) {
      return reply.status(409).send({ error: 'No agent is currently linked to this account' });
    }

    const agentId = authedUser.agentId;

    // Cancel all non-terminal intents for this user (best-effort — continue even on partial failure)
    const activeIntents = await prisma.purchaseIntent.findMany({
      where: { userId, status: { in: ACTIVE_INTENT_STATUSES } },
      select: { id: true },
    });

    const cancelledIntentIds: string[] = [];
    for (const intent of activeIntents) {
      try {
        await expireIntent(intent.id);
        cancelledIntentIds.push(intent.id);
      } catch {
        // Log and continue — unlinking must not be blocked by a single failed expiry
        fastify.log.warn({ message: 'Failed to expire intent during agent unlink', intentId: intent.id, userId });
      }
    }

    // Remove agentId from user and clear the pairing code claim atomically
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { agentId: null },
      });

      await tx.pairingCode.updateMany({
        where: { agentId, claimedByUserId: userId },
        data: { claimedByUserId: null },
      });

      await tx.auditEvent.create({
        data: {
          intentId: null,
          actor: userId,
          event: 'AGENT_UNLINKED',
          payload: { agentId, cancelledIntentIds },
        },
      });
    });

    return reply.send({ unlinked: true, agentId, cancelledIntentIds });
  });
}
