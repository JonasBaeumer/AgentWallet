import type { Update } from 'grammy/types';
import { prisma } from '@/db/client';
import { ApprovalDecisionType, IntentStatus } from '@/contracts';
import { recordDecision } from '@/approval/approvalService';
import { reserveForIntent, returnIntent } from '@/ledger/potService';
import { getPaymentProvider } from '@/payments';
import { markCardIssued, startCheckout } from '@/orchestrator/intentService';
import { enqueueCheckout } from '@/queue/producers';
import { getTelegramBot } from './telegramClient';
import { getSignupSession, setSignupSession, clearSignupSession } from './sessionStore';

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

  // Parse compact format: "<action>:<payload>"
  const colonIdx = data.indexOf(':');
  if (colonIdx === -1) return;
  const action = data.slice(0, colonIdx);
  const payload = data.slice(colonIdx + 1);

  // ── Agent linking confirmation callbacks ─────────────────────────────────────
  if (action === 'link_confirm' || action === 'link_cancel') {
    // payload is the chatId of the user who initiated /start
    const signingChatId = Number(payload);
    const session = await getSignupSession(signingChatId);

    if (!session || session.step !== 'awaiting_confirmation') {
      await editMessage(bot, chatId, messageId, '⚠️ Session expired or not found. Please start again with /start <code>.');
      return;
    }

    if (action === 'link_cancel') {
      await clearSignupSession(signingChatId);
      await editMessage(bot, chatId, messageId, '❌ Linking cancelled. You can start again with /start <code>.');
      return;
    }

    // link_confirm: advance session to awaiting_email
    await setSignupSession(signingChatId, { ...session, step: 'awaiting_email' });
    await editMessage(bot, chatId, messageId, `✅ Confirmed! What email address should we use for your account?`);
    return;
  }

  // ── Purchase approval callbacks ───────────────────────────────────────────────
  const intentId = payload;

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
