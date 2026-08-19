import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { agentContextHook } from '@/api/middleware/agentContext';
import {
  agentAuthMiddleware,
  agentRegistrationAuthMiddleware,
  claimedAgentAuthMiddleware,
  requireOwnedIntent,
} from '@/api/middleware/agentAuth';
import { agentQuoteSchema, agentResultSchema, agentRegisterSchema } from '@/api/validators/agent';
import { IntentStatus } from '@/contracts';
import {
  receiveQuote,
  requestApproval,
  completeCheckout,
  failCheckout,
} from '@/orchestrator/intentService';
import { settleIntent, returnIntent } from '@/ledger/potService';
import { getProviderForIntent } from '@/payments';
import { prisma } from '@/db/client';
import { sendApprovalRequest } from '@/telegram/notificationService';
import { issueAgentCredential } from '@/security/agentCredentials';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAIRING_CODE_RENEWAL_COOLDOWN_MS = 5 * 60 * 1000; // min gap between renewals per agentId
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1

function generatePairingCode(): string {
  return Array.from(
    { length: 8 },
    () => PAIRING_CODE_CHARS[Math.floor(Math.random() * PAIRING_CODE_CHARS.length)],
  ).join('');
}

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/agent/quote — authenticated agent posts a search result
  // Flow: SEARCHING → QUOTED → AWAITING_APPROVAL
  fastify.post(
    '/v1/agent/quote',
    {
      onRequest: [claimedAgentAuthMiddleware, agentContextHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = agentQuoteSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const { intentId, merchantName, merchantUrl, price, currency } = parsed.data;
      const intent = await requireOwnedIntent(request, reply, intentId);
      if (!intent) return;
      if (intent.status !== IntentStatus.SEARCHING) {
        return reply
          .status(409)
          .send({ error: `Intent must be in SEARCHING state (current: ${intent.status})` });
      }

      // SEARCHING → QUOTED (stores quote data in metadata via orchestrator)
      const agentId = request.authenticatedAgent!.id;
      await receiveQuote(intentId, { merchantName, merchantUrl, price, currency }, agentId);

      // QUOTED → AWAITING_APPROVAL
      await requestApproval(intentId, agentId);

      // Fire-and-forget Telegram notification — must not block the HTTP response
      sendApprovalRequest(intentId).catch((err: unknown) =>
        fastify.log.error({
          message: 'Telegram notification failed',
          intentId,
          error: String(err),
        }),
      );

      return reply.send({ intentId, status: IntentStatus.AWAITING_APPROVAL });
    },
  );

  // POST /v1/agent/result — authenticated agent posts a checkout outcome
  // Flow on success: CHECKOUT_RUNNING → DONE, settle ledger, cancel card
  // Flow on failure: CHECKOUT_RUNNING → FAILED, return ledger funds, cancel card
  fastify.post(
    '/v1/agent/result',
    {
      onRequest: [claimedAgentAuthMiddleware, agentContextHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = agentResultSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const { intentId, success, actualAmount, receiptUrl, errorMessage } = parsed.data;
      const intent = await requireOwnedIntent(request, reply, intentId);
      if (!intent) return;
      if (intent.status !== IntentStatus.CHECKOUT_RUNNING) {
        return reply
          .status(409)
          .send({ error: `Intent must be in CHECKOUT_RUNNING state (current: ${intent.status})` });
      }

      const agentId = request.authenticatedAgent!.id;
      if (success) {
        await completeCheckout(intentId, actualAmount ?? 0, agentId);
        await settleIntent(intentId, actualAmount ?? 0);
      } else {
        await failCheckout(intentId, errorMessage ?? 'Checkout failed', agentId);
        await returnIntent(intentId);
      }

      // Cancel the virtual card — one purchase, one card (best-effort).
      // Failures must not block the agent response, but a swallowed error can
      // leave a live card on Stripe — log so it shows up in oncall.
      await getProviderForIntent(intentId)
        .then((p) => p.cancelCard(intentId))
        .catch((err: unknown) => {
          fastify.log.warn({ intentId, err }, 'Failed to cancel virtual card after agent result');
        });

      // Store receipt/error info in metadata
      await prisma.purchaseIntent.update({
        where: { id: intentId },
        data: {
          metadata: {
            ...(intent.metadata as object),
            actualAmount,
            receiptUrl,
            errorMessage,
          } as any,
        },
      });

      const finalStatus = success ? IntentStatus.DONE : IntentStatus.FAILED;
      return reply.send({ intentId, status: finalStatus });
    },
  );

  // GET /v1/agent/decision/:intentId — poll for approval decision + card details
  // Returns AWAITING_APPROVAL, DENIED, or APPROVED (with one-time card on first call)
  fastify.get<{ Params: { intentId: string } }>(
    '/v1/agent/decision/:intentId',
    {
      onRequest: [claimedAgentAuthMiddleware, agentContextHook],
    },
    async (request, reply) => {
      const { intentId } = request.params;

      const intent = await requireOwnedIntent(request, reply, intentId);
      if (!intent) return;

      switch (intent.status) {
        case IntentStatus.AWAITING_APPROVAL:
          return reply.send({ intentId, status: IntentStatus.AWAITING_APPROVAL });

        case IntentStatus.DENIED:
          return reply.send({ intentId, status: IntentStatus.DENIED });

        case IntentStatus.CARD_ISSUED:
        case IntentStatus.CHECKOUT_RUNNING:
        case IntentStatus.DONE: {
          // Return checkout params directly — OpenClaw passes these to POST /v1/checkout/simulate
          // Quote price takes priority over maxBudget when available
          const meta = intent.metadata as any;
          const amount = meta?.quote?.price ?? intent.maxBudget;
          return reply.send({
            intentId,
            status: IntentStatus.APPROVED,
            checkout: { intentId, amount, currency: intent.currency },
          });
        }

        case IntentStatus.APPROVED:
          // Brief transition between recordDecision and issueVirtualCard — keep polling
          return reply.send({ intentId, status: IntentStatus.AWAITING_APPROVAL });

        default:
          return reply.send({ intentId, status: intent.status });
      }
    },
  );

  // GET /v1/agent/card/:intentId — one-time card reveal via Stripe
  // cardService enforces the single-reveal rule and fetches PAN/CVC from Stripe
  fastify.get<{ Params: { intentId: string } }>(
    '/v1/agent/card/:intentId',
    {
      config: {
        rateLimit: {
          max: 2,
          timeWindow: '1 minute',
          keyGenerator: (req: FastifyRequest) => {
            return `card-reveal:${req.authenticatedAgent?.id ?? 'unauthenticated'}`;
          },
        },
      },
      onRequest: [claimedAgentAuthMiddleware, agentContextHook],
    },
    async (request, reply) => {
      const { intentId } = request.params;
      const intent = await requireOwnedIntent(request, reply, intentId);
      if (!intent) return;

      try {
        const provider = await getProviderForIntent(intentId);
        const reveal = await provider.revealCard(intentId);
        return reply.send({ intentId, ...reveal });
      } catch (err: any) {
        if (err.name === 'CardAlreadyRevealedError') {
          return reply.status(409).send({ error: 'Card has already been revealed' });
        }
        if (err.name === 'IntentNotFoundError' || err.code === 'P2025') {
          return reply.status(404).send({ error: `No card found for intent: ${intentId}` });
        }
        throw err;
      }
    },
  );

  // POST /v1/agent/register — bootstrap a new agent or renew its pairing code.
  // Bootstrap uses X-Worker-Key and returns X-Agent-Key material once. Renewal
  // requires the existing X-Agent-Key and never trusts a caller-supplied agent ID.
  fastify.post(
    '/v1/agent/register',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: '10 minutes',
          keyGenerator: (req: FastifyRequest) =>
            req.authenticatedAgent?.id
              ? `agent-registration:${req.authenticatedAgent.id}`
              : (req.ip ?? 'unknown'),
        },
      },
      onRequest: [agentRegistrationAuthMiddleware, agentContextHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = agentRegisterSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
      }

      const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
      const code = generatePairingCode();

      if (request.authenticatedAgent) {
        const agentId = request.authenticatedAgent.id;
        const existing = await prisma.pairingCode.findUnique({
          where: { agentId },
        });
        if (!existing) {
          return reply.status(401).send({
            error: 'Unauthorized: invalid or rotated agent credential',
            code: 'agent_credential_invalid',
          });
        }
        if (existing.claimedByUserId) {
          return reply
            .status(409)
            .send({ error: 'Agent already has a linked user — re-registration not needed' });
        }
        const lastIssuedAt = existing.codeIssuedAt.getTime();
        if (Date.now() - lastIssuedAt < PAIRING_CODE_RENEWAL_COOLDOWN_MS) {
          return reply.status(429).send({
            error: 'Too many renewal requests for this agent — please wait before retrying',
          });
        }
        // Issue a fresh code
        const updated = await prisma.pairingCode.update({
          where: { agentId },
          data: { code, expiresAt, codeIssuedAt: new Date() },
        });
        return reply.send({
          agentId: updated.agentId,
          pairingCode: updated.code,
          expiresAt: updated.expiresAt,
        });
      }

      if (request.headers['x-agent-id']) {
        return reply.status(400).send({
          error: 'X-Agent-Id is not accepted during initial registration',
          code: 'untrusted_agent_id',
        });
      }

      const agentId = `ag_${randomUUID().replace(/-/g, '')}`;
      const credential = await issueAgentCredential();
      const record = await prisma.pairingCode.create({
        data: {
          agentId,
          code,
          expiresAt,
          codeIssuedAt: new Date(),
          credentialHash: credential.hash,
          credentialPrefix: credential.prefix,
          credentialExpiresAt: credential.expiresAt,
          credentialVersion: 1,
          credentialRevokedAt: null,
        },
      });
      return reply.send({
        agentId: record.agentId,
        pairingCode: record.code,
        expiresAt: record.expiresAt,
        agentKey: credential.raw,
        agentKeyExpiresAt: credential.expiresAt,
      });
    },
  );

  fastify.post(
    '/v1/agent/credential/rotate',
    {
      onRequest: [agentAuthMiddleware, agentContextHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const agent = request.authenticatedAgent!;
      const credential = await issueAgentCredential();

      const rotated = await prisma.$transaction(async (tx) => {
        const result = await tx.pairingCode.updateMany({
          where: {
            agentId: agent.id,
            credentialVersion: agent.credentialVersion,
            credentialRevokedAt: null,
          },
          data: {
            credentialHash: credential.hash,
            credentialPrefix: credential.prefix,
            credentialExpiresAt: credential.expiresAt,
            credentialVersion: { increment: 1 },
          },
        });
        if (result.count !== 1) return false;

        await tx.auditEvent.create({
          data: {
            intentId: null,
            actor: agent.id,
            agentId: agent.id,
            event: 'AGENT_CREDENTIAL_ROTATED',
            payload: { credentialVersion: agent.credentialVersion + 1 },
          },
        });
        return true;
      });

      if (!rotated) {
        return reply.status(409).send({
          error: 'Agent credential was rotated by another request',
          code: 'agent_credential_rotation_conflict',
        });
      }

      return reply.send({
        agentId: agent.id,
        agentKey: credential.raw,
        agentKeyExpiresAt: credential.expiresAt,
        credentialVersion: agent.credentialVersion + 1,
      });
    },
  );

  // GET /v1/agent/user — resolve the user linked to the authenticated agent
  // Returns: { status: "unclaimed" } | { status: "claimed", userId }
  fastify.get(
    '/v1/agent/user',
    {
      onRequest: [agentAuthMiddleware, agentContextHook],
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const agent = request.authenticatedAgent!;
      if (!agent.userId) {
        return reply.send({ status: 'unclaimed' });
      }
      return reply.send({ status: 'claimed', userId: agent.userId });
    },
  );
}
