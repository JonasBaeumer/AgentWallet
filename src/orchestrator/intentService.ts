import { prisma } from '@/db/client';
import { IntentEvent, PurchaseIntentData, AuditEventData, IntentNotFoundError } from '@/contracts';
import { transitionIntent, TransitionResult } from './stateMachine';
import { getPaymentProvider } from '@/payments';
import { returnIntent } from '@/ledger/potService';

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

export async function receiveQuote(intentId: string, quotePayload: Record<string, unknown>): Promise<TransitionResult> {
  // Persist quote data in metadata so the approval route can read merchant/price info
  await prisma.purchaseIntent.update({
    where: { id: intentId },
    data: { metadata: quotePayload as any },
  });
  return transitionIntent(intentId, IntentEvent.QUOTE_RECEIVED, quotePayload);
}

export async function requestApproval(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.APPROVAL_REQUESTED);
}

export async function approveIntent(intentId: string, actorId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.USER_APPROVED, {}, actorId);
}

export async function denyIntent(intentId: string, actorId: string, reason?: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.USER_DENIED, { reason }, actorId);
}

export async function markCardIssued(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CARD_ISSUED);
}

export async function startCheckout(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_STARTED, {}, 'worker');
}

export async function completeCheckout(intentId: string, actualAmount: number): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_SUCCEEDED, { actualAmount });
}

export async function failCheckout(intentId: string, errorMessage: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_FAILED, { errorMessage });
}

async function cleanupExpiredIntent(intentId: string): Promise<void> {
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (card) {
    await getPaymentProvider().cancelCard(intentId).catch((err) => {
      console.error({ intentId, err }, 'Failed to cancel card during expiry cleanup');
    });
  }

  const pot = await prisma.pot.findFirst({ where: { intentId, status: 'ACTIVE' } });
  if (pot) {
    await returnIntent(intentId).catch((err) => {
      console.error({ intentId, err }, 'Failed to return funds during expiry cleanup');
    });
  }
}

export async function expireIntent(intentId: string): Promise<TransitionResult> {
  const result = await transitionIntent(intentId, IntentEvent.INTENT_EXPIRED);
  await cleanupExpiredIntent(intentId).catch((err) => {
    console.error({ intentId, err }, 'Failed to run expiry cleanup');
  });
  return result;
}
