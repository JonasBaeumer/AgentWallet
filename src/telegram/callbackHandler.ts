import type { Update } from 'grammy/types';
import { prisma } from '@/db/client';
import { ApprovalDecisionType, IntentStatus, InsufficientIssuingBalanceError } from '@/contracts';
import { recordDecision } from '@/approval/approvalService';
import { reserveForIntent, returnIntent } from '@/ledger/potService';
import { getPaymentProvider } from '@/payments';
import { markCardIssued, startCheckout } from '@/orchestrator/intentService';
import { enqueueCheckout } from '@/queue/producers';
import { getTelegramBot } from './telegramClient';

export async function handleTelegramCallback(update: Update): Promise<void> {
  const cb = update.callback_query;
  if (!cb) return;

  const callbackQueryId = cb.id;
  const data = cb.data ?? '';
  const fromId = cb.from.id;
  const messageId = cb.message?.message_id;
  const chatId = cb.message?.chat?.id;

  const bot = getTelegramBot();

  // Answer immediately to clear the loading spinner — must happen within 30s
  await bot.api.answerCallbackQuery(callbackQueryId).catch(() => {});

  // Parse compact format: "approve:<intentId>" or "reject:<intentId>"
  const colonIdx = data.indexOf(':');
  if (colonIdx === -1) return;
  const action = data.slice(0, colonIdx);
  const intentId = data.slice(colonIdx + 1);

  if (action !== 'approve' && action !== 'reject') return;

  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { user: true },
  });

  if (!intent) {
    await editMessage(bot, chatId, messageId, '⚠️ Intent not found.');
    return;
  }

  // Guard: only process if still awaiting
  if (intent.status !== IntentStatus.AWAITING_APPROVAL) {
    await editMessage(bot, chatId, messageId, `Already processed: <code>${intent.status}</code>`);
    return;
  }

  // Idempotency: check if this callbackQueryId was already handled
  const idempotencyKey = `telegram_cb:${callbackQueryId}`;
  const existing = await prisma.idempotencyRecord.findUnique({ where: { key: idempotencyKey } });
  if (existing) {
    await editMessage(bot, chatId, messageId, `Already processed: <code>${intent.status}</code>`);
    return;
  }

  const actorId = `telegram:${fromId}`;
  let resultText: string;

  // Save idempotency record before doing any work so retries are blocked
  await prisma.idempotencyRecord.upsert({
    where: { key: idempotencyKey },
    create: { key: idempotencyKey, responseBody: { action, intentId } },
    update: {},
  });

  try {
    if (action === 'approve') {
      const metadata = intent.metadata as Record<string, unknown>;

      // Check Stripe Issuing balance BEFORE persisting the decision
      const issuingBalance = await getPaymentProvider().getIssuingBalance(intent.currency);
      if (issuingBalance.available < intent.maxBudget) {
        throw new InsufficientIssuingBalanceError(issuingBalance.available, intent.maxBudget, intent.currency);
      }

      await recordDecision(intentId, ApprovalDecisionType.APPROVED, actorId);
      await reserveForIntent(intent.userId, intentId, intent.maxBudget);

      let card;
      try {
        card = await getPaymentProvider().issueCard(intentId, intent.maxBudget, intent.currency, {
          mccAllowlist: intent.user.mccAllowlist,
        });
      } catch (cardErr) {
        await returnIntent(intentId).catch(() => {});
        throw cardErr;
      }

      await markCardIssued(intentId);
      await startCheckout(intentId);
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

      resultText = '✅ Approved. Checkout is running.';
    } else {
      await recordDecision(intentId, ApprovalDecisionType.DENIED, actorId, 'Rejected via Telegram');
      resultText = '❌ Rejected.';
    }
  } catch (err) {
    if (err instanceof InsufficientIssuingBalanceError) {
      await editMessage(bot, chatId, messageId,
        `⚠️ Insufficient Stripe Issuing balance (${err.currency}): available ${err.available}, required ${err.required}.`);
      return;
    }
    await editMessage(bot, chatId, messageId, '⚠️ Something went wrong processing your decision. Please try via the app.');
    throw err;
  }

  // Edit the original message, removing the inline keyboard
  await editMessage(bot, chatId, messageId, resultText);
}

async function editMessage(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string | undefined,
  messageId: number | undefined,
  text: string,
): Promise<void> {
  if (!chatId || !messageId) return;
  await bot.api
    .editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: undefined,
    })
    .catch(() => {});
}
