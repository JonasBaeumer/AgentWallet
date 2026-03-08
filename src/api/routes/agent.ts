import { randomUUID } from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { workerAuthMiddleware } from '@/api/middleware/auth';
import { agentQuoteSchema, agentResultSchema, agentRegisterSchema } from '@/api/validators/agent';
import { IntentStatus } from '@/contracts';
import { receiveQuote, requestApproval, completeCheckout, failCheckout } from '@/orchestrator/intentService';
import { settleIntent, returnIntent } from '@/ledger/potService';
import { getPaymentProvider } from '@/payments';
import { prisma } from '@/db/client';
import { sendApprovalRequest } from '@/telegram/notificationService';

const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const PAIRING_CODE_RENEWAL_COOLDOWN_MS = 5 * 60 * 1000; // min gap between renewals per agentId
const PAIRING_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous O/0/I/1

function generatePairingCode(): string {
  return Array.from({ length: 8 }, () =>
    PAIRING_CODE_CHARS[Math.floor(Math.random() * PAIRING_CODE_CHARS.length)],
  ).join('');
}

export async function agentRoutes(fastify: FastifyInstance): Promise<void> {
  // POST /v1/agent/quote — worker posts search result
  // Flow: SEARCHING → QUOTED → AWAITING_APPROVAL
  fastify.post('/v1/agent/quote', {
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = agentQuoteSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
    }

    const { intentId, merchantName, merchantUrl, price, currency } = parsed.data;
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
    if (!intent) return reply.status(404).send({ error: `Intent not found: ${intentId}` });
    if (intent.status !== IntentStatus.SEARCHING) {
      return reply.status(409).send({ error: `Intent must be in SEARCHING state (current: ${intent.status})` });
    }

    // SEARCHING → QUOTED (stores quote data in metadata via orchestrator)
    await receiveQuote(intentId, { merchantName, merchantUrl, price, currency });

    // QUOTED → AWAITING_APPROVAL
    await requestApproval(intentId);

    // Fire-and-forget Telegram notification — must not block the HTTP response
    sendApprovalRequest(intentId).catch((err: unknown) =>
      fastify.log.error({ message: 'Telegram notification failed', intentId, error: String(err) })
    );

    return reply.send({ intentId, status: IntentStatus.AWAITING_APPROVAL });
  });

  // POST /v1/agent/result — worker posts checkout outcome
  // Flow on success: CHECKOUT_RUNNING → DONE, settle ledger, cancel card
  // Flow on failure: CHECKOUT_RUNNING → FAILED, return ledger funds, cancel card
  fastify.post('/v1/agent/result', {
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = agentResultSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
    }

    const { intentId, success, actualAmount, receiptUrl, errorMessage } = parsed.data;
    const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
    if (!intent) return reply.status(404).send({ error: `Intent not found: ${intentId}` });
    if (intent.status !== IntentStatus.CHECKOUT_RUNNING) {
      return reply.status(409).send({ error: `Intent must be in CHECKOUT_RUNNING state (current: ${intent.status})` });
    }

    if (success) {
      await completeCheckout(intentId, actualAmount ?? 0);
      await settleIntent(intentId, actualAmount ?? 0);
    } else {
      await failCheckout(intentId, errorMessage ?? 'Checkout failed');
      await returnIntent(intentId);
    }

    // Cancel the virtual card — one purchase, one card (best-effort)
    await getPaymentProvider().cancelCard(intentId).catch(() => {});

    // Store receipt/error info in metadata
    await prisma.purchaseIntent.update({
      where: { id: intentId },
      data: { metadata: { ...(intent.metadata as object), actualAmount, receiptUrl, errorMessage } as any },
    });

    const finalStatus = success ? IntentStatus.DONE : IntentStatus.FAILED;
    return reply.send({ intentId, status: finalStatus });
  });

  // GET /v1/agent/decision/:intentId — poll for approval decision + card details
  // Returns AWAITING_APPROVAL, DENIED, or APPROVED (with one-time card on first call)
  fastify.get('/v1/agent/decision/:intentId', {
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest<{ Params: { intentId: string } }>, reply: FastifyReply) => {
    const { intentId } = request.params;

    const intent = await prisma.purchaseIntent.findUnique({
      where: { id: intentId },
      include: { virtualCard: true },
    });
    if (!intent) return reply.status(404).send({ error: `Intent not found: ${intentId}` });

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
  });

  // GET /v1/agent/card/:intentId — one-time card reveal via Stripe
  // cardService enforces the single-reveal rule and fetches PAN/CVC from Stripe
  fastify.get('/v1/agent/card/:intentId', {
    config: {
      rateLimit: {
        max: 2,
        timeWindow: '1 minute',
        keyGenerator: (req: FastifyRequest) => {
          const workerKey = req.headers['x-worker-key'] ?? '';
          const intentId = (req.params as { intentId: string }).intentId ?? '';
          return `${workerKey}:${intentId}`;
        },
      },
    },
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest<{ Params: { intentId: string } }>, reply: FastifyReply) => {
    const { intentId } = request.params;

    try {
      const reveal = await getPaymentProvider().revealCard(intentId);
      return reply.send({ intentId, ...reveal });
    } catch (err: any) {
      if (err.name === 'CardAlreadyRevealedError') {
        return reply.status(409).send({ error: 'Card has already been revealed' });
      }
      if (err.name === 'IntentNotFoundError') {
        return reply.status(404).send({ error: `No card found for intent: ${intentId}` });
      }
      throw err;
    }
  });

  // POST /v1/agent/register — register OpenClaw instance and get a pairing code
  // Body: { agentId?: string }  — omit on first call; pass existing agentId to renew code
  // Returns: { agentId, pairingCode, expiresAt }
  fastify.post('/v1/agent/register', {
    config: {
      rateLimit: {
        max: 3,
        timeWindow: '10 minutes',
        keyGenerator: (req: FastifyRequest) => req.ip ?? 'unknown',
      },
    },
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = agentRegisterSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: 'Invalid input', details: parsed.error.errors });
    }

    const { agentId: existingAgentId } = parsed.data;
    const expiresAt = new Date(Date.now() + PAIRING_CODE_TTL_MS);
    const code = generatePairingCode();

    if (existingAgentId) {
      // Renewal: look up existing record by agentId
      const existing = await prisma.pairingCode.findUnique({ where: { agentId: existingAgentId } });
      if (!existing) {
        return reply.status(404).send({ error: `Agent not found: ${existingAgentId}` });
      }
      if (existing.claimedByUserId) {
        return reply.status(409).send({ error: 'Agent already has a linked user — re-registration not needed' });
      }
      // Per-agentId rate limit: use createdAt (set at issuance) to measure the cooldown
      const lastIssuedAt = existing.createdAt.getTime();
      if (Date.now() - lastIssuedAt < PAIRING_CODE_RENEWAL_COOLDOWN_MS) {
        return reply.status(429).send({ error: 'Too many renewal requests for this agent — please wait before retrying' });
      }
      // Issue a fresh code
      const updated = await prisma.pairingCode.update({
        where: { agentId: existingAgentId },
        data: { code, expiresAt },
      });
      return reply.send({ agentId: updated.agentId, pairingCode: updated.code, expiresAt: updated.expiresAt });
    }

    // First registration: generate a stable agentId
    const agentId = `ag_${randomUUID().replace(/-/g, '')}`;
    const record = await prisma.pairingCode.create({
      data: { agentId, code, expiresAt },
    });
    return reply.send({ agentId: record.agentId, pairingCode: record.code, expiresAt: record.expiresAt });
  });

  // GET /v1/agent/user — resolve the userId linked to an agentId
  // Header: X-Agent-Id: <agentId>
  // Returns: { status: "unclaimed" } | { status: "claimed", userId }
  fastify.get('/v1/agent/user', {
    preHandler: workerAuthMiddleware,
  }, async (request: FastifyRequest, reply: FastifyReply) => {
    const agentId = request.headers['x-agent-id'] as string | undefined;
    if (!agentId) {
      return reply.status(400).send({ error: 'Missing X-Agent-Id header' });
    }

    const record = await prisma.pairingCode.findUnique({ where: { agentId } });
    if (!record) {
      return reply.status(404).send({ error: `Agent not found: ${agentId}` });
    }

    if (!record.claimedByUserId) {
      return reply.send({ status: 'unclaimed' });
    }
    return reply.send({ status: 'claimed', userId: record.claimedByUserId });
  });
}
