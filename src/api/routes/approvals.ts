import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { idempotencyMiddleware, saveIdempotencyResponse } from '@/api/middleware/idempotency';
import { userAuthMiddleware } from '@/api/middleware/userAuth';
import { approvalDecisionSchema } from '@/api/validators/approvals';
import { prisma } from '@/db/client';
import {
  ApprovalDecisionType,
  IntentStatus,
  InsufficientFundsError,
  InsufficientIssuingBalanceError,
} from '@/contracts';
import { recordDecision } from '@/approval/approvalService';
import { reserveForIntent, returnIntent } from '@/ledger/potService';
import { getPaymentProvider } from '@/payments';
import { markCardIssued, startCheckout } from '@/orchestrator/intentService';
import { enqueueCheckout } from '@/queue/producers';

export async function approvalRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Params: { intentId: string } }>(
    '/v1/approvals/:intentId/decision',
    {
      config: {
        rateLimit: {
          max: 5,
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
    async (request, reply) => {
      const idempotencyKey = request.headers['x-idempotency-key'] as string;
      if (!idempotencyKey) {
        return reply.status(400).send({ error: 'X-Idempotency-Key header is required' });
      }

      const { intentId } = request.params;
      const parsed = approvalDecisionSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const intent = await prisma.purchaseIntent.findUnique({
        where: { id: intentId },
        include: { user: true },
      });
      if (!intent) {
        return reply.status(404).send({ error: `Intent not found: ${intentId}` });
      }

      const authUser = request.user!;
      if (intent.userId !== authUser.id) {
        return reply.status(403).send({ error: 'Forbidden: intent does not belong to this user' });
      }

      if (intent.status !== IntentStatus.AWAITING_APPROVAL) {
        return reply
          .status(409)
          .send({ error: `Intent is not in AWAITING_APPROVAL state (current: ${intent.status})` });
      }

      const { decision, reason } = parsed.data;
      const decisionType = decision as ApprovalDecisionType;
      const actorId = request.user!.id;

      try {
        let finalStatus: IntentStatus;

        if (decisionType === ApprovalDecisionType.APPROVED) {
          const metadata = intent.metadata as Record<string, unknown>;

          // 1. Check Stripe Issuing balance BEFORE persisting the decision
          const issuingBalance = await getPaymentProvider().getIssuingBalance(intent.currency);
          if (issuingBalance.available < intent.maxBudget) {
            throw new InsufficientIssuingBalanceError(
              issuingBalance.available,
              intent.maxBudget,
              intent.currency,
            );
          }

          // 2. Record decision — transitions intent to APPROVED
          await recordDecision(intentId, decisionType, actorId, reason);

          // 3. Reserve funds in ledger pot (deducts from user.mainBalance)
          await reserveForIntent(intent.userId, intentId, intent.maxBudget);

          let card;
          try {
            // 4. Issue restricted Stripe virtual card
            card = await getPaymentProvider().issueCard(
              intentId,
              intent.maxBudget,
              intent.currency,
              {
                mccAllowlist: intent.user.mccAllowlist,
              },
            );
          } catch (cardErr) {
            await returnIntent(intentId).catch(() => {});
            throw cardErr;
          }

          // 5. Transition APPROVED → CARD_ISSUED (via orchestrator)
          await markCardIssued(intentId);

          // 6. Transition CARD_ISSUED → CHECKOUT_RUNNING
          await startCheckout(intentId);

          // 7. Enqueue checkout job for the worker
          await enqueueCheckout(intentId, {
            intentId,
            userId: intent.userId,
            merchantName: (metadata.merchantName as string) ?? '',
            merchantUrl: (metadata.merchantUrl as string) ?? '',
            price: (metadata.price as number) ?? intent.maxBudget,
            currency: intent.currency,
            stripeCardId: card.stripeCardId,
            last4: card.last4,
          });

          finalStatus = IntentStatus.CHECKOUT_RUNNING;
        } else {
          // Record denial
          await recordDecision(intentId, decisionType, actorId, reason);
          finalStatus = IntentStatus.DENIED;
        }

        const responseBody = { intentId, decision, status: finalStatus };
        await saveIdempotencyResponse(idempotencyKey, responseBody);
        return reply.send(responseBody);
      } catch (err) {
        if (
          err instanceof InsufficientFundsError ||
          err instanceof InsufficientIssuingBalanceError
        ) {
          return reply.status(422).send({ error: err.message });
        }
        throw err;
      }
    },
  );
}
