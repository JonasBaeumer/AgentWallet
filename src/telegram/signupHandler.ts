import type { Update } from 'grammy/types';
import { InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { getTelegramBot } from './telegramClient';
import { getSignupSession, setSignupSession, clearSignupSession, getPrefSession, clearPrefSession } from './sessionStore';
import { sendMainMenu } from './menuHandler';
import { CardCancelPolicy } from '@/contracts';

export async function handleTelegramMessage(update: Update): Promise<void> {
  const message = update.message;
  if (!message) return;

  const chatId = message.chat.id;
  const text = (message.text ?? '').trim();
  const bot = getTelegramBot();

  // Handle /menu command
  if (text === '/menu') {
    await sendMainMenu(chatId);
    return;
  }

  // Handle custom TTL input (set by menu_pref_ttl:custom)
  const prefSession = await getPrefSession(chatId);
  if (prefSession?.awaitingCustomTtl) {
    const minutes = parseInt(text, 10);
    if (isNaN(minutes) || minutes < 1 || minutes > 10080) {
      await bot.api.sendMessage(chatId, '⚠️ Please send a whole number of minutes between 1 and 10080, e.g. 90');
      return;
    }
    await clearPrefSession(chatId);
    await prisma.user.updateMany({
      where: { telegramChatId: String(chatId) },
      data: { cancelPolicy: CardCancelPolicy.AFTER_TTL, cardTtlMinutes: minutes },
    });
    await bot.api.sendMessage(chatId, `✅ Saved! Cancel policy: After TTL (${minutes} min)`);
    return;
  }

  // Handle /start <code> command
  if (text.startsWith('/start')) {
    const parts = text.split(/\s+/);
    const code = parts[1]?.toUpperCase();

    if (!code) {
      await bot.api.sendMessage(
        chatId,
        'Welcome! To sign up, ask your OpenClaw assistant for a pairing code, then send: /start <code>',
      );
      return;
    }

    const pairingCode = await prisma.pairingCode.findUnique({ where: { code } });

    if (!pairingCode) {
      await bot.api.sendMessage(chatId, '⚠️ Code not found. Please check the code and try again.');
      return;
    }

    if (pairingCode.expiresAt < new Date()) {
      await bot.api.sendMessage(
        chatId,
        '⚠️ This code has expired. Please ask your OpenClaw assistant for a new code.',
      );
      return;
    }

    if (pairingCode.claimedByUserId) {
      await bot.api.sendMessage(chatId, '⚠️ This code has already been used.');
      return;
    }

    await setSignupSession(chatId, {
      step: 'awaiting_confirmation',
      agentId: pairingCode.agentId,
      pairingCode: code,
    });

    const keyboard = new InlineKeyboard()
      .text('✅ Confirm', 'link_confirm:_')
      .text('❌ Cancel', 'link_cancel:_');

    await bot.api.sendMessage(
      chatId,
      `🤖 Agent <code>${pairingCode.agentId}</code> wants to link to your account.\n\nDo you want to proceed?`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );
    return;
  }

  // Handle free-text
  const session = await getSignupSession(chatId);
  if (!session) {
    await bot.api.sendMessage(chatId, 'Send /start <code> to begin signup.');
    return;
  }

  if (session.step === 'awaiting_confirmation') {
    await bot.api.sendMessage(chatId, 'Please use the buttons above to confirm or cancel the linking.');
    return;
  }

  // step === 'awaiting_email'
  const email = text.toLowerCase();

  if (!isValidEmail(email)) {
    await bot.api.sendMessage(chatId, "⚠️ That doesn't look like a valid email. Please try again.");
    return;
  }

  try {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = await bcrypt.hash(rawKey, 10);

    // Atomic: verify the code is still unclaimed, then create user + claim in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const freshCode = await tx.pairingCode.findUnique({ where: { code: session.pairingCode } });
      if (!freshCode || freshCode.claimedByUserId) {
        throw Object.assign(new Error('Code already claimed'), { name: 'PairingCodeAlreadyClaimedError' });
      }

      const user = await tx.user.create({
        data: {
          email,
          telegramChatId: chatId.toString(),
          agentId: session.agentId,
          mainBalance: 1_000_000, // 10 000 EUR in cents
          maxBudgetPerIntent: 50000,
          apiKeyHash,
          apiKeyPrefix: rawKey.slice(0, 16),
        },
      });

      await tx.pairingCode.update({
        where: { code: session.pairingCode },
        data: { claimedByUserId: user.id },
      });

      // Emit AGENT_LINKED audit event (not scoped to a specific intent)
      await tx.auditEvent.create({
        data: {
          intentId: null,
          actor: user.id,
          event: 'AGENT_LINKED',
          payload: { agentId: session.agentId, telegramChatId: chatId.toString() },
        },
      });

      return { user, rawKey };
    });

    await clearSignupSession(chatId);

    await bot.api.sendMessage(
      chatId,
      `Account created! Your OpenClaw agent (<code>${session.agentId}</code>) is now linked.\n\nYour API key (save it — it won't be shown again):\n\n${result.rawKey}\n\nYou'll receive payment approval requests here.`,
      { parse_mode: 'HTML' },
    );
  } catch (err: any) {
    if (err.name === 'PairingCodeAlreadyClaimedError') {
      await clearSignupSession(chatId);
      await bot.api.sendMessage(
        chatId,
        '⚠️ This pairing code was already claimed by another account. Please ask your OpenClaw assistant for a new code.',
      );
    } else if (err.code === 'P2002') {
      // Unique constraint — email already taken
      await bot.api.sendMessage(
        chatId,
        '⚠️ An account with that email already exists. Please use a different email.',
      );
    } else {
      throw err;
    }
  }
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}
