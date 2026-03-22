import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { userAuthMiddleware } from '@/api/middleware/userAuth';
import { prisma } from '@/db/client';
import { expireIntent } from '@/orchestrator/intentService';
import { IntentStatus, CardCancelPolicy } from '@/contracts';

const PreferencesSchema = z.object({
  cancelPolicy: z.nativeEnum(CardCancelPolicy).optional(),
  cardTtlMinutes: z.number().int().min(1).max(10080).nullable().optional(),
}).superRefine((data, ctx) => {
  if (data.cardTtlMinutes != null && data.cancelPolicy !== CardCancelPolicy.AFTER_TTL) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'cardTtlMinutes can only be set when cancelPolicy is AFTER_TTL',
      path: ['cardTtlMinutes'],
    });
  }
});

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

    const results = await Promise.allSettled(activeIntents.map((i) => expireIntent(i.id)));
    const cancelledIntentIds = activeIntents
      .filter((_, idx) => results[idx].status === 'fulfilled')
      .map((i) => i.id);

    results.forEach((result, idx) => {
      if (result.status === 'rejected') {
        fastify.log.warn({ message: 'Failed to expire intent during agent unlink', intentId: activeIntents[idx].id, userId });
      }
    });

    // Remove agentId from user and invalidate the pairing code atomically.
    // Setting expiresAt to epoch (new Date(0)) prevents the code from being re-claimed
    // during the remaining TTL window after unlinking.
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { agentId: null },
      });

      await tx.pairingCode.updateMany({
        where: { agentId, claimedByUserId: userId },
        data: { claimedByUserId: null, expiresAt: new Date(0) },
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

  // PATCH /v1/users/:userId/preferences
  // Update cancel policy and optional TTL. No auth required (internal/Telegram use).
  fastify.patch('/v1/users/:userId/preferences', async (
    request: FastifyRequest<{ Params: { userId: string } }>,
    reply: FastifyReply,
  ) => {
    const { userId } = request.params;

    const parsed = PreferencesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message ?? 'Invalid request body' });
    }

    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const updated = await prisma.user.update({
      where: { id: userId },
      data: parsed.data,
    });

    return reply.send({
      userId: updated.id,
      cancelPolicy: updated.cancelPolicy,
      cardTtlMinutes: updated.cardTtlMinutes,
    });
  });
}
