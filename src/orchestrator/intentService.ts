import { prisma } from '@/db/client';
import { IntentEvent, PurchaseIntentData, AuditEventData, IntentNotFoundError, CardCancelPolicy } from '@/contracts';
import { transitionIntent, TransitionResult } from './stateMachine';
import { getPaymentProvider } from '@/payments';
import { returnIntent } from '@/ledger/potService';
import { enqueueCancelCard } from '@/queue/producers';
import { getTelegramBot } from '@/telegram/telegramClient';
import { InlineKeyboard } from 'grammy';

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
  const result = await transitionIntent(intentId, IntentEvent.CHECKOUT_SUCCEEDED, { actualAmount });

  // Apply cancel policy — fire-and-forget so policy errors never block the checkout response
  applyPostCheckoutCancelPolicy(intentId).catch((err) => {
    console.error(JSON.stringify({ level: 'error', message: 'Post-checkout cancel policy failed', intentId, error: String(err) }));
  });

  return result;
}

async function applyPostCheckoutCancelPolicy(intentId: string): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { user: { select: { cancelPolicy: true, cardTtlMinutes: true, telegramChatId: true } }, virtualCard: true },
  });
  if (!intent?.user) return;

  const { cancelPolicy, cardTtlMinutes, telegramChatId } = intent.user;

  if (cancelPolicy === CardCancelPolicy.ON_TRANSACTION) {
    // Cancellation is handled by the issuing_transaction.created Stripe webhook.
    // Fallback for stub/test flows where no real Stripe transaction fires:
    if (!intent.virtualCard) {
      await getPaymentProvider().cancelCard(intentId).catch((err) => {
        console.error(JSON.stringify({ level: 'error', message: 'ON_TRANSACTION stub fallback cancel failed', intentId, error: String(err) }));
      });
    }
  } else if (cancelPolicy === CardCancelPolicy.IMMEDIATE) {
    await getPaymentProvider().cancelCard(intentId).catch((err) => {
      console.error(JSON.stringify({ level: 'error', message: 'IMMEDIATE card cancel failed', intentId, error: String(err) }));
    });
  } else if (cancelPolicy === CardCancelPolicy.AFTER_TTL && cardTtlMinutes) {
    await enqueueCancelCard(intentId, cardTtlMinutes * 60 * 1000);
  } else if (cancelPolicy === CardCancelPolicy.MANUAL) {
    await getPaymentProvider().freezeCard(intentId).catch((err) => {
      console.error(JSON.stringify({ level: 'error', message: 'MANUAL card freeze failed', intentId, error: String(err) }));
    });
    if (telegramChatId) {
      await notifyManualCardPending(telegramChatId, intentId, intent.subject ?? intent.query);
    }
  }
}

async function notifyManualCardPending(telegramChatId: string, intentId: string, label: string): Promise<void> {
  try {
    const bot = getTelegramBot();
    const keyboard = new InlineKeyboard().text('Cancel Card Now', `menu_card_cancel:${intentId}`);
    await bot.api.sendMessage(
      Number(telegramChatId),
      `Checkout complete for "${label}".\n\nYour virtual card is frozen. Tap below when you no longer need it.`,
      { reply_markup: keyboard },
    );
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Failed to send MANUAL card notification', intentId, error: String(err) }));
  }
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
