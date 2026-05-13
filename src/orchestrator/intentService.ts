import { prisma } from '@/db/client';
import { IntentEvent, PurchaseIntentData, AuditEventData, IntentNotFoundError } from '@/contracts';
import { logger } from '@/config/logger';
import { transitionIntent, TransitionResult } from './stateMachine';
import { getPaymentProvider, getProviderForIntent } from '@/payments';
import { returnIntent } from '@/ledger/potService';
import { enqueueCancelCard } from '@/queue/producers';
import { sendManualCardPendingNotice } from '@/telegram/notificationService';

const log = logger.child({ module: 'orchestrator/intentService' });

export async function getIntentWithHistory(intentId: string): Promise<{
  intent: PurchaseIntentData;
  auditEvents: AuditEventData[];
}> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { auditEvents: { orderBy: { createdAt: 'asc' } } },
  });

  if (!intent) throw new IntentNotFoundError(intentId);

  return {
    intent: intent as unknown as PurchaseIntentData,
    auditEvents: intent.auditEvents as unknown as AuditEventData[],
  };
}

export async function startSearching(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.INTENT_CREATED);
}

export async function receiveQuote(
  intentId: string,
  quotePayload: Record<string, unknown>,
  agentId?: string,
): Promise<TransitionResult> {
  // Persist quote data in metadata so the approval route can read merchant/price info
  await prisma.purchaseIntent.update({
    where: { id: intentId },
    data: { metadata: quotePayload as any },
  });
  return transitionIntent(intentId, IntentEvent.QUOTE_RECEIVED, quotePayload, { agentId });
}

export async function requestApproval(
  intentId: string,
  agentId?: string,
): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.APPROVAL_REQUESTED, {}, { agentId });
}

export async function approveIntent(intentId: string, actorId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.USER_APPROVED, {}, { actor: actorId });
}

export async function denyIntent(
  intentId: string,
  actorId: string,
  reason?: string,
): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.USER_DENIED, { reason }, { actor: actorId });
}

export async function markCardIssued(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CARD_ISSUED);
}

export async function startCheckout(intentId: string, agentId?: string): Promise<TransitionResult> {
  return transitionIntent(
    intentId,
    IntentEvent.CHECKOUT_STARTED,
    {},
    { actor: agentId ?? 'worker', agentId },
  );
}

export async function completeCheckout(
  intentId: string,
  actualAmount: number,
  agentId?: string,
): Promise<TransitionResult> {
  const result = await transitionIntent(
    intentId,
    IntentEvent.CHECKOUT_SUCCEEDED,
    { actualAmount },
    { agentId },
  );

  // Apply cancel policy — fire-and-forget so policy errors never block the checkout response
  applyPostCheckoutCancelPolicy(intentId).catch((err) => {
    log.error({ intentId, err }, 'Post-checkout cancel policy failed');
  });

  return result;
}

async function applyPostCheckoutCancelPolicy(intentId: string): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: {
      user: {
        select: {
          cancelPolicy: true,
          cardTtlMinutes: true,
          telegramChatId: true,
          paymentProvider: true,
        },
      },
      virtualCard: true,
    },
  });
  if (!intent?.user) return;

  const { cancelPolicy, cardTtlMinutes, telegramChatId, paymentProvider } = intent.user;
  const provider = getPaymentProvider(paymentProvider);

  if (cancelPolicy === 'ON_TRANSACTION') {
    // Cancellation is handled by the issuing_transaction.created Stripe webhook.
    // Fallback for stub/test flows where no real Stripe transaction fires:
    if (!intent.virtualCard) {
      await provider.cancelCard(intentId).catch((err) => {
        log.error({ intentId, err }, 'ON_TRANSACTION stub fallback cancel failed');
      });
    }
  } else if (cancelPolicy === 'IMMEDIATE') {
    await provider.cancelCard(intentId).catch((err) => {
      log.error({ intentId, err }, 'IMMEDIATE card cancel failed');
    });
  } else if (cancelPolicy === 'AFTER_TTL') {
    if (cardTtlMinutes != null && cardTtlMinutes > 0) {
      await enqueueCancelCard(intentId, cardTtlMinutes * 60 * 1000);
    } else {
      // Invariant violation: AFTER_TTL requires a positive cardTtlMinutes.
      // Rather than silently leave the card active, fail loud and fall back
      // to IMMEDIATE cancellation so no card outlives checkout.
      log.error(
        { intentId, cancelPolicy, cardTtlMinutes },
        'AFTER_TTL policy with missing/invalid cardTtlMinutes — falling back to IMMEDIATE cancel',
      );
      await provider.cancelCard(intentId).catch((err) => {
        log.error({ intentId, err }, 'AFTER_TTL fallback IMMEDIATE cancel failed');
      });
    }
  } else if (cancelPolicy === 'MANUAL') {
    await provider.freezeCard(intentId).catch((err) => {
      log.error({ intentId, err }, 'MANUAL card freeze failed');
    });
    if (telegramChatId) {
      await sendManualCardPendingNotice(telegramChatId, intentId, intent.subject ?? intent.query);
    }
  }
}

export async function failCheckout(
  intentId: string,
  errorMessage: string,
  agentId?: string,
): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_FAILED, { errorMessage }, { agentId });
}

async function cleanupExpiredIntent(intentId: string): Promise<void> {
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (card) {
    await getProviderForIntent(intentId)
      .then((p) => p.cancelCard(intentId))
      .catch((err) => {
        log.error({ intentId, err }, 'Failed to cancel card during expiry cleanup');
      });
  }

  const pot = await prisma.pot.findFirst({ where: { intentId, status: 'ACTIVE' } });
  if (pot) {
    await returnIntent(intentId).catch((err) => {
      log.error({ intentId, err }, 'Failed to return funds during expiry cleanup');
    });
  }
}

export async function expireIntent(intentId: string): Promise<TransitionResult> {
  const result = await transitionIntent(intentId, IntentEvent.INTENT_EXPIRED);
  await cleanupExpiredIntent(intentId).catch((err) => {
    log.error({ intentId, err }, 'Failed to run expiry cleanup');
  });
  return result;
}
