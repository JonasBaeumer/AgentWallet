import type { Update } from 'grammy/types';
import { InlineKeyboard } from 'grammy';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';
import { logger } from '@/config/logger';
import { getTelegramBot } from './telegramClient';
import {
  getSignupSession,
  setSignupSession,
  clearSignupSession,
  getPrefSession,
  clearPrefSession,
  type SignupSession,
} from './sessionStore';
import { sendMainMenu } from './menuHandler';
import { CardCancelPolicy } from '@/contracts';

const log = logger.child({ module: 'telegram/signupHandler' });

type SendMessageOpts = Parameters<ReturnType<typeof getTelegramBot>['api']['sendMessage']>[2];

/**
 * Sends a message and records its message_id in the active signup session
 * so it can be deleted on completion. If no session exists, falls back to a
 * plain sendMessage (the message simply won't be tracked for cleanup).
 */
async function sendEphemeral(
  chatId: number,
  text: string,
  opts?: SendMessageOpts,
): Promise<number> {
  const bot = getTelegramBot();
  const msg =
    opts === undefined
      ? await bot.api.sendMessage(chatId, text)
      : await bot.api.sendMessage(chatId, text, opts);
  await appendSignupMessageId(chatId, msg.message_id);
  return msg.message_id;
}

async function appendSignupMessageId(chatId: number, messageId: number): Promise<void> {
  const session = await getSignupSession(chatId);
  if (!session) return;
  await setSignupSession(chatId, {
    ...session,
    messageIds: [...(session.messageIds ?? []), messageId],
  });
}

/**
 * Best-effort bulk delete of all setup messages tracked on a session.
 * Per-id failures are swallowed so a single error doesn't abort the rest.
 * Telegram only allows bots to delete messages within the last 48h; the 10-min
 * session TTL keeps us well inside that window.
 */
async function cleanupSignupMessages(
  chatId: number,
  session: Pick<SignupSession, 'messageIds'> | null,
): Promise<number> {
  const bot = getTelegramBot();
  const ids = session?.messageIds ?? [];
  let deleted = 0;
  for (const id of ids) {
    try {
      await bot.api.deleteMessage(chatId, id);
      deleted++;
    } catch {
      // ignored — already deleted, expired, or older than 48h
    }
  }
  return deleted;
}

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
      await bot.api.sendMessage(
        chatId,
        '⚠️ Please send a whole number of minutes between 1 and 10080, e.g. 90',
      );
      return;
    }
    await clearPrefSession(chatId);
    await prisma.user.updateMany({
      where: { telegramChatId: String(chatId) },
      data: { cancelPolicy: CardCancelPolicy.AFTER_TTL, cardTtlMinutes: minutes },
    });
    // Delete the ForceReply prompt and the user's reply to keep the chat clean
    if (prefSession.promptMessageId) {
      await bot.api.deleteMessage(chatId, prefSession.promptMessageId).catch(() => {});
    }
    await bot.api.deleteMessage(chatId, message.message_id).catch(() => {});
    await bot.api.sendMessage(chatId, `✅ Saved! Cancel policy: After TTL (${minutes} min)`);
    return;
  }

  // Handle /start <code> command
  if (text.startsWith('/start')) {
    // If a stale signup session exists from a previous abandoned attempt,
    // clean up its tracked messages before starting fresh.
    const stale = await getSignupSession(chatId);
    if (stale && (stale.messageIds?.length ?? 0) > 0) {
      await cleanupSignupMessages(chatId, stale);
      await clearSignupSession(chatId);
    }

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

    // Initialize session with the user's /start message id already tracked,
    // so the chat is fully cleaned up at the end.
    await setSignupSession(chatId, {
      step: 'awaiting_confirmation',
      agentId: pairingCode.agentId,
      pairingCode: code,
      messageIds: [message.message_id],
    });

    const keyboard = new InlineKeyboard()
      .text('✅ Confirm', 'link_confirm:_')
      .text('❌ Cancel', 'link_cancel:_');

    await sendEphemeral(
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

  // Track the user's incoming message for later cleanup, regardless of branch.
  await appendSignupMessageId(chatId, message.message_id);

  if (session.step === 'awaiting_confirmation') {
    await sendEphemeral(chatId, 'Please use the buttons above to confirm or cancel the linking.');
    return;
  }

  // step === 'awaiting_email'
  const email = text.toLowerCase();

  if (!isValidEmail(email)) {
    await sendEphemeral(chatId, "⚠️ That doesn't look like a valid email. Please try again.");
    return;
  }

  try {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const apiKeyHash = await bcrypt.hash(rawKey, 10);

    // Atomic: verify the code is still unclaimed, then create user + claim in one transaction
    const result = await prisma.$transaction(async (tx) => {
      const freshCode = await tx.pairingCode.findUnique({ where: { code: session.pairingCode } });
      if (!freshCode || freshCode.claimedByUserId) {
        throw Object.assign(new Error('Code already claimed'), {
          name: 'PairingCodeAlreadyClaimedError',
        });
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
          agentId: session.agentId,
          event: 'AGENT_LINKED',
          payload: { agentId: session.agentId, telegramChatId: chatId.toString() },
        },
      });

      return { user, rawKey };
    });

    // Send the success/API-key message as ephemeral so its id is tracked,
    // then bulk-delete every signup message and land the user on the main menu.
    await sendEphemeral(
      chatId,
      `Account created! Your OpenClaw agent (<code>${session.agentId}</code>) is now linked.\n\nYour API key (save it — it won't be shown again):\n\n${result.rawKey}\n\nYou'll receive payment approval requests here.`,
      { parse_mode: 'HTML' },
    );

    // Re-read the session so cleanup includes the success message id we just appended.
    const finalSession = await getSignupSession(chatId);
    await clearSignupSession(chatId);
    const deleted = await cleanupSignupMessages(chatId, finalSession);

    await prisma.auditEvent
      .create({
        data: {
          intentId: null,
          actor: result.user.id,
          agentId: session.agentId,
          event: 'TELEGRAM_SETUP_CLEANED',
          payload: { messageCount: deleted },
        },
      })
      .catch((err) => log.error({ err }, 'Failed to record TELEGRAM_SETUP_CLEANED audit event'));

    await sendMainMenu(chatId);
  } catch (err: any) {
    if (err.name === 'PairingCodeAlreadyClaimedError') {
      await clearSignupSession(chatId);
      await bot.api.sendMessage(
        chatId,
        '⚠️ This pairing code was already claimed by another account. Please ask your OpenClaw assistant for a new code.',
      );
    } else if (err.code === 'P2002') {
      // Unique constraint — email already taken
      await sendEphemeral(
        chatId,
        '⚠️ An account with that email already exists. Please use a different email.',
      );
    } else {
      throw err;
    }
  }
}

function isValidEmail(email: string): boolean {
  if (email.length > 254) return false;
  return /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email);
}
