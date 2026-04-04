import { InlineKeyboard } from 'grammy';
import { prisma } from '@/db/client';
import { getTelegramBot } from './telegramClient';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'telegram/notificationService' });

export async function sendApprovalRequest(intentId: string): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({
    where: { id: intentId },
    include: { user: true },
  });

  if (!intent) return;
  if (!intent.user.telegramChatId) {
    log.info({ intentId }, 'No telegramChatId for user, skipping notification');
    return;
  }

  const metadata = intent.metadata as Record<string, unknown>;
  const merchantName = (metadata.merchantName as string) ?? 'Unknown merchant';
  const price = (metadata.price as number) ?? intent.maxBudget;
  const currency = ((metadata.currency as string) ?? intent.currency).toUpperCase();
  const taskTitle = intent.subject ?? intent.query;

  const text =
    `🛒 <b>Purchase Approval Request</b>\n\n` +
    `<b>Task:</b> ${escapeHtml(taskTitle)}\n` +
    `<b>Merchant:</b> ${escapeHtml(merchantName)}\n` +
    `<b>Price:</b> ${(price / 100).toFixed(2)} ${currency}\n` +
    `<b>Budget:</b> ${(intent.maxBudget / 100).toFixed(2)} ${currency}\n\n` +
    `Tap below to decide:`;

  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `approve:${intentId}`)
    .text('❌ Reject', `reject:${intentId}`);

  try {
    const bot = getTelegramBot();
    const msg = await bot.api.sendMessage(intent.user.telegramChatId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });

    const updatedMetadata = { ...metadata, telegramMessageId: msg.message_id };
    await prisma.purchaseIntent.update({
      where: { id: intentId },
      data: { metadata: updatedMetadata as any },
    });
  } catch (err) {
    log.error({ intentId, err }, 'Failed to send Telegram notification');
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
