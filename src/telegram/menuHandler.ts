import { InlineKeyboard } from 'grammy';
import { prisma } from '@/db/client';
import { getTelegramBot } from './telegramClient';
import { expireIntent } from '@/orchestrator/intentService';
import { getProviderForIntent } from '@/payments';
import { IntentStatus, CardCancelPolicy } from '@/contracts';
import { setPrefSession } from './sessionStore';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'telegram/menuHandler' });

// Mirrors the API-level Zod bounds for cardTtlMinutes (src/api/routes/users.ts).
// Telegram callback payloads can be forged, so the same range is enforced here
// before any DB write.
const TTL_MIN_MINUTES = 1;
const TTL_MAX_MINUTES = 10080;

const POLICY_LABELS: Record<CardCancelPolicy, string> = {
  [CardCancelPolicy.ON_TRANSACTION]: 'On Transaction',
  [CardCancelPolicy.IMMEDIATE]: 'Immediate',
  [CardCancelPolicy.AFTER_TTL]: 'After TTL',
  [CardCancelPolicy.MANUAL]: 'Manual',
};

function isMessageNotModifiedError(err: unknown): boolean {
  // grammy surfaces Telegram API errors with shape { error_code, description }.
  // The 400 "message is not modified" response fires whenever editMessageText is
  // called with text + markup identical to what is already shown — benign.
  if (typeof err !== 'object' || err === null) return false;
  const e = err as { error_code?: number; description?: unknown };
  return (
    e.error_code === 400 &&
    typeof e.description === 'string' &&
    e.description.includes('message is not modified')
  );
}

const ACTIVE_INTENT_STATUSES: IntentStatus[] = [
  IntentStatus.RECEIVED,
  IntentStatus.SEARCHING,
  IntentStatus.QUOTED,
  IntentStatus.AWAITING_APPROVAL,
  IntentStatus.APPROVED,
  IntentStatus.CARD_ISSUED,
  IntentStatus.CHECKOUT_RUNNING,
];

function formatAmount(amountInCents: number): string {
  return `£${(amountInCents / 100).toFixed(2)}`;
}

function buildMainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('💰 Balance', 'menu_balance:_')
    .text('📋 History', 'menu_history:_')
    .row()
    .text('🚫 Cancel Intent', 'menu_cancel_list:_')
    .text('🔗 Agent Status', 'menu_agent:_')
    .row()
    .text('⚙️ Preferences', 'menu_preferences:_');
}

async function getUserByChatId(chatId: number | string) {
  return prisma.user.findFirst({ where: { telegramChatId: String(chatId) } });
}

async function editMenu(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await bot.api.editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    });
  } catch (err) {
    if (isMessageNotModifiedError(err)) return;
    log.error({ chatId, messageId, err }, 'Failed to edit Telegram menu message');
    throw err;
  }
}

// Fire-and-forget variant: never throws. Use this when the calling code has
// already completed its irreversible work (e.g. cancel succeeded) and a
// failure to render the confirmation must NOT be surfaced as if the work
// itself had failed. `editMenu` already logs the underlying Telegram failure
// before throwing, so we just swallow it here.
async function tryEditMenu(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  try {
    await editMenu(bot, chatId, messageId, text, keyboard);
  } catch {
    // Already logged inside editMenu; intentional swallow.
  }
}

async function showBalance(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  user: { id: string; mainBalance: number },
): Promise<void> {
  const activePots = await prisma.pot.findMany({
    where: { userId: user.id, status: 'ACTIVE' },
    select: { reservedAmount: true },
  });

  const reserved = activePots.reduce((sum, p) => sum + p.reservedAmount, 0);
  const available = user.mainBalance - reserved;

  const text =
    `💰 <b>Your Balance</b>\n\n` +
    `Main balance: ${formatAmount(user.mainBalance)}\n` +
    `Reserved:     ${formatAmount(reserved)}\n` +
    `Available:    ${formatAmount(available)}`;

  const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');
  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function showHistory(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  user: { id: string },
): Promise<void> {
  const intents = await prisma.purchaseIntent.findMany({
    where: { userId: user.id, status: IntentStatus.DONE },
    orderBy: { createdAt: 'desc' },
    take: 5,
    include: { pot: true },
  });

  let text = '📋 <b>Recent Purchases</b>\n\n';
  if (intents.length === 0) {
    text += 'No purchases yet.';
  } else {
    text += intents
      .map((i) => {
        const amount = i.pot ? formatAmount(i.pot.settledAmount) : formatAmount(i.maxBudget);
        return `• ${i.subject ?? i.query} — ${amount}`;
      })
      .join('\n');
  }

  const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');
  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function showCancelList(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  user: { id: string },
): Promise<void> {
  const intents = await prisma.purchaseIntent.findMany({
    where: { userId: user.id, status: { in: ACTIVE_INTENT_STATUSES } },
    orderBy: { createdAt: 'desc' },
  });

  const keyboard = new InlineKeyboard();
  let text: string;

  if (intents.length === 0) {
    text = '🚫 <b>Cancel Intent</b>\n\nNo active intents.';
  } else {
    text = '🚫 <b>Cancel Intent</b>\n\nSelect an intent to cancel:';
    for (const intent of intents) {
      const label = `${intent.status}: ${intent.subject ?? intent.query}  ${formatAmount(intent.maxBudget)}`;
      keyboard.row().text(label, `menu_cancel_confirm:${intent.id}`);
    }
  }

  keyboard.row().text('⬅️ Back', 'menu_main:_');
  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function showCancelConfirm(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  intentId: string,
): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });

  if (!intent) {
    const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_cancel_list:_');
    await editMenu(bot, chatId, messageId, '⚠️ Intent not found.', keyboard);
    return;
  }

  const label = intent.subject ?? intent.query;
  const text =
    `🚫 Cancel "<b>${label}</b>" (${intent.status})?\n\n` +
    `Budget: ${formatAmount(intent.maxBudget)} will be returned to your balance.`;

  const keyboard = new InlineKeyboard()
    .text('✅ Yes, cancel', `menu_cancel_do:${intentId}`)
    .text('⬅️ Back to list', 'menu_cancel_list:_');

  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function doCancelIntent(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  intentId: string,
): Promise<void> {
  const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');

  // The mutation and the confirmation edit are deliberately handled in
  // separate try/catch blocks. If the cancel succeeds but Telegram fails to
  // render the confirmation, we must NOT show "Something went wrong" — the
  // user would be tempted to retry an already-cancelled intent.
  try {
    await expireIntent(intentId);
  } catch (err) {
    log.error({ chatId, intentId, err }, 'doCancelIntent: expireIntent failed');
    await tryEditMenu(
      bot,
      chatId,
      messageId,
      '⚠️ Something went wrong. Please try again.',
      keyboard,
    );
    return;
  }

  await tryEditMenu(
    bot,
    chatId,
    messageId,
    '✅ Intent cancelled. Your budget has been returned.',
    keyboard,
  );
}

async function showAgentStatus(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  user: { agentId: string | null },
): Promise<void> {
  let text: string;
  if (user.agentId) {
    text = `🔗 <b>Agent Status</b>\n\nLinked: <code>${user.agentId}</code>`;
  } else {
    text = '🔗 <b>Agent Status</b>\n\nNo agent linked. Use /start &lt;code&gt; to link.';
  }

  const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');
  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function showPreferences(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  user: { cancelPolicy: CardCancelPolicy; cardTtlMinutes: number | null },
): Promise<void> {
  const currentLabel = POLICY_LABELS[user.cancelPolicy];
  const ttlSuffix =
    user.cancelPolicy === CardCancelPolicy.AFTER_TTL && user.cardTtlMinutes
      ? ` (${user.cardTtlMinutes} min)`
      : '';

  const text =
    `⚙️ <b>Preferences</b>\n\nCancel policy: <b>${currentLabel}${ttlSuffix}</b>\n\n` +
    `Choose when the virtual card is cancelled after a successful checkout:`;

  const keyboard = new InlineKeyboard()
    .text('On Transaction', 'menu_pref_policy:ON_TRANSACTION')
    .text('Immediate', 'menu_pref_policy:IMMEDIATE')
    .row()
    .text('After TTL', 'menu_pref_policy:AFTER_TTL')
    .text('Manual', 'menu_pref_policy:MANUAL')
    .row()
    .text('⬅️ Back', 'menu_main:_');

  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function showTtlPicker(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  const text = '⏱ <b>Card TTL</b> — how long to keep the card open after checkout?';
  const keyboard = new InlineKeyboard()
    .text('30 min', 'menu_pref_ttl:30')
    .text('1 hr', 'menu_pref_ttl:60')
    .row()
    .text('4 hrs', 'menu_pref_ttl:240')
    .text('24 hrs', 'menu_pref_ttl:1440')
    .row()
    .text('Custom', 'menu_pref_ttl:custom')
    .row()
    .text('⬅️ Back', 'menu_preferences:_');

  await editMenu(bot, chatId, messageId, text, keyboard);
}

async function savePrefPolicy(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  userId: string,
  policy: CardCancelPolicy,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { cancelPolicy: policy, cardTtlMinutes: null },
  });
  const keyboard = new InlineKeyboard().text('⬅️ Back to Menu', 'menu_main:_');
  await editMenu(
    bot,
    chatId,
    messageId,
    `✅ Saved! Cancel policy: <b>${POLICY_LABELS[policy]}</b>`,
    keyboard,
  );
}

async function savePrefTtl(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  userId: string,
  minutes: number,
): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: { cancelPolicy: CardCancelPolicy.AFTER_TTL, cardTtlMinutes: minutes },
  });
  const keyboard = new InlineKeyboard().text('⬅️ Back to Menu', 'menu_main:_');
  await editMenu(
    bot,
    chatId,
    messageId,
    `✅ Saved! Cancel policy: <b>After TTL (${minutes} min)</b>`,
    keyboard,
  );
}

async function startCustomTtlInput(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
): Promise<void> {
  // Remove the keyboard from the TTL picker message so it's not left hanging
  await editMenu(
    bot,
    chatId,
    messageId,
    '⏱ <b>Custom TTL</b>\n\nType the number of minutes below:',
  );
  // Send a ForceReply message — Telegram pops up the reply bar anchored to this message
  const prompt = await bot.api.sendMessage(
    chatId,
    'How many minutes should the card stay open after checkout? (e.g. 90)',
    {
      reply_markup: { force_reply: true, input_field_placeholder: 'e.g. 90' },
    },
  );
  // Store both flags in session so signupHandler can delete the prompt after the user replies
  await setPrefSession(chatId, { awaitingCustomTtl: true, promptMessageId: prompt.message_id });
}

async function doCancelCard(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  intentId: string,
): Promise<void> {
  const keyboard = new InlineKeyboard().text('⬅️ Back to Menu', 'menu_main:_');

  // Same split as doCancelIntent: a Telegram failure after the card is
  // already cancelled must not be surfaced as "Something went wrong" — the
  // user would retry a no-op cancel against an already-cancelled card.
  try {
    const provider = await getProviderForIntent(intentId);
    await provider.cancelCard(intentId);
  } catch (err) {
    log.error({ chatId, intentId, err }, 'doCancelCard: cancelCard failed');
    await tryEditMenu(
      bot,
      chatId,
      messageId,
      '⚠️ Something went wrong cancelling the card. Please try again.',
      keyboard,
    );
    return;
  }

  await tryEditMenu(bot, chatId, messageId, '✅ Card cancelled successfully.', keyboard);
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function sendMainMenu(chatId: number | string): Promise<void> {
  const bot = getTelegramBot();
  const user = await getUserByChatId(chatId);

  if (!user) {
    await bot.api.sendMessage(
      chatId,
      '⚠️ You need to sign up first. Send /start &lt;code&gt; to get started.',
      { parse_mode: 'HTML' },
    );
    return;
  }

  const keyboard = buildMainMenuKeyboard();
  await bot.api.sendMessage(chatId, '📱 <b>Main Menu</b>', {
    parse_mode: 'HTML',
    reply_markup: keyboard,
  });
}

export async function handleMenuCallback(
  bot: ReturnType<typeof getTelegramBot>,
  chatId: number | string,
  messageId: number,
  action: string,
  payload: string,
  _fromTelegramId: number,
): Promise<void> {
  // The whole dispatch — including the user lookup — runs inside one recovery
  // boundary so a DB failure on getUserByChatId is caught here too, not left
  // to bubble up to the Telegram middleware with no user-facing feedback.
  try {
    // Actions that don't need a user record
    if (action === 'menu_main') {
      const keyboard = buildMainMenuKeyboard();
      await editMenu(bot, chatId, messageId, '📱 <b>Main Menu</b>', keyboard);
      return;
    }

    if (action === 'menu_cancel_confirm') {
      await showCancelConfirm(bot, chatId, messageId, payload);
      return;
    }

    if (action === 'menu_cancel_do') {
      await doCancelIntent(bot, chatId, messageId, payload);
      return;
    }

    if (action === 'menu_card_cancel') {
      await doCancelCard(bot, chatId, messageId, payload);
      return;
    }

    if (action === 'menu_pref_ttl' && payload === 'custom') {
      await startCustomTtlInput(bot, chatId, messageId);
      return;
    }

    // All remaining actions need a user record
    const user = await getUserByChatId(chatId);

    if (!user) {
      await editMenu(
        bot,
        chatId,
        messageId,
        '⚠️ You need to sign up first. Send /start &lt;code&gt; to get started.',
      );
      return;
    }

    if (action === 'menu_balance') {
      await showBalance(bot, chatId, messageId, user);
    } else if (action === 'menu_history') {
      await showHistory(bot, chatId, messageId, user);
    } else if (action === 'menu_cancel_list') {
      await showCancelList(bot, chatId, messageId, user);
    } else if (action === 'menu_agent') {
      await showAgentStatus(bot, chatId, messageId, user);
    } else if (action === 'menu_preferences') {
      await showPreferences(bot, chatId, messageId, user);
    } else if (action === 'menu_pref_policy') {
      // Callback payloads can be forged — validate against the enum before use.
      const allowedPolicies = Object.values(CardCancelPolicy) as string[];
      if (!allowedPolicies.includes(payload)) {
        log.warn(
          { chatId, action, payload },
          'Rejected unknown cancel policy from Telegram callback',
        );
        await editMenu(bot, chatId, messageId, '⚠️ Invalid cancel policy.');
        return;
      }
      const policy = payload as CardCancelPolicy;
      if (policy === CardCancelPolicy.AFTER_TTL) {
        await showTtlPicker(bot, chatId, messageId);
      } else {
        await savePrefPolicy(bot, chatId, messageId, user.id, policy);
      }
    } else if (action === 'menu_pref_ttl') {
      // Mirror the API-level Zod validation so a forged callback (e.g.
      // `menu_pref_ttl:-1`, `menu_pref_ttl:99999`, or `menu_pref_ttl:12.5`)
      // cannot bypass the bounds by going through the Telegram path. We
      // require the payload to be an integer string so e.g. "12.5" is not
      // silently truncated to 12 by parseInt.
      const minutes = /^[1-9]\d*$/.test(payload) ? Number.parseInt(payload, 10) : NaN;
      if (!Number.isInteger(minutes) || minutes < TTL_MIN_MINUTES || minutes > TTL_MAX_MINUTES) {
        log.warn(
          { chatId, action, payload, parsed: minutes },
          'Rejected out-of-range TTL value from Telegram callback',
        );
        await editMenu(
          bot,
          chatId,
          messageId,
          `⚠️ Invalid TTL. Must be between ${TTL_MIN_MINUTES} and ${TTL_MAX_MINUTES} minutes.`,
        );
        return;
      }
      await savePrefTtl(bot, chatId, messageId, user.id, minutes);
    } else {
      // Unknown menu_* actions: log so we notice if the UI ships a button the
      // backend doesn't handle, but don't crash.
      log.warn({ chatId, action, payload }, 'Unknown menu_* callback action');
    }
  } catch (err) {
    log.error({ chatId, messageId, action, payload, err }, 'menu callback handler failed');
    await tryEditMenu(bot, chatId, messageId, '⚠️ Something went wrong. Please try again.');
  }
}
