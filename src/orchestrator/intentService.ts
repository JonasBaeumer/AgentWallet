import { prisma } from '@/db/client';
import { IntentEvent, PurchaseIntentData, AuditEventData, IntentNotFoundError } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'orchestrator/intentService' });
import { transitionIntent, TransitionResult } from './stateMachine';
import { getPaymentProvider, getProviderForIntent } from '@/payments';
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

export async function receiveQuote(
  intentId: string,
  quotePayload: Record<string, unknown>,
): Promise<TransitionResult> {
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

export async function denyIntent(
  intentId: string,
  actorId: string,
  reason?: string,
): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.USER_DENIED, { reason }, actorId);
}

export async function markCardIssued(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CARD_ISSUED);
}

export async function startCheckout(intentId: string): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_STARTED, {}, 'worker');
}

export async function completeCheckout(
  intentId: string,
  actualAmount: number,
): Promise<TransitionResult> {
  const result = await transitionIntent(intentId, IntentEvent.CHECKOUT_SUCCEEDED, { actualAmount });

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

  // Providers that auto-close their cards after first use (e.g. Privacy.com
  // SINGLE_USE) make cancelCard redundant. Explicit cancel/freeze calls still
  // succeed but are no-ops at the provider level — skip them to avoid log noise.
  if (provider.metadata.autoCancelAfterUse) {
    log.info(
      { intentId, provider: paymentProvider },
      'Skipping post-checkout cancel — provider auto-closes cards after use',
    );
    return;
  }

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
  } else if (cancelPolicy === 'AFTER_TTL' && cardTtlMinutes) {
    await enqueueCancelCard(intentId, cardTtlMinutes * 60 * 1000);
  } else if (cancelPolicy === 'MANUAL') {
    // MANUAL needs freezeCard — skip for providers that don't support it.
    if (!provider.metadata.supportsFreeze) {
      log.warn(
        { intentId, provider: paymentProvider },
        'MANUAL cancel policy selected but provider does not support freeze — leaving card as-is',
      );
      return;
    }
    await provider.freezeCard(intentId).catch((err) => {
      log.error({ intentId, err }, 'MANUAL card freeze failed');
    });
    if (telegramChatId) {
      await notifyManualCardPending(telegramChatId, intentId, intent.subject ?? intent.query);
    }
  }
}

async function notifyManualCardPending(
  telegramChatId: string,
  intentId: string,
  label: string,
): Promise<void> {
  try {
    const bot = getTelegramBot();
    const keyboard = new InlineKeyboard().text('Cancel Card Now', `menu_card_cancel:${intentId}`);
    await bot.api.sendMessage(
      Number(telegramChatId),
      `Checkout complete for "${label}".\n\nYour virtual card is frozen. Tap below when you no longer need it.`,
      { reply_markup: keyboard },
    );
  } catch (err) {
    log.error({ intentId, err }, 'Failed to send MANUAL card notification');
  }
}

export async function failCheckout(
  intentId: string,
  errorMessage: string,
): Promise<TransitionResult> {
  return transitionIntent(intentId, IntentEvent.CHECKOUT_FAILED, { errorMessage });
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
