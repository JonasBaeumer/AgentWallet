import { InlineKeyboard } from 'grammy';
import { prisma } from '@/db/client';
import { getTelegramBot } from './telegramClient';
import { expireIntent } from '@/orchestrator/intentService';
import { getProviderForIntent } from '@/payments';
import { IntentStatus, CardCancelPolicy } from '@/contracts';
import { setPrefSession } from './sessionStore';

const POLICY_LABELS: Record<CardCancelPolicy, string> = {
  [CardCancelPolicy.ON_TRANSACTION]: 'On Transaction',
  [CardCancelPolicy.IMMEDIATE]: 'Immediate',
  [CardCancelPolicy.AFTER_TTL]: 'After TTL',
  [CardCancelPolicy.MANUAL]: 'Manual',
};

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
  await bot.api
    .editMessageText(chatId, messageId, text, {
      parse_mode: 'HTML',
      reply_markup: keyboard,
    })
    .catch(() => {});
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
  try {
    await expireIntent(intentId);
    const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');
    await editMenu(
      bot,
      chatId,
      messageId,
      '✅ Intent cancelled. Your budget has been returned.',
      keyboard,
    );
  } catch {
    const keyboard = new InlineKeyboard().text('⬅️ Back', 'menu_main:_');
    await editMenu(bot, chatId, messageId, '⚠️ Something went wrong. Please try again.', keyboard);
  }
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
  // Switching away from AFTER_TTL must clear any stale TTL so checkout cannot
  // later silently skip cancellation due to a leftover cardTtlMinutes value.
  // Mirror the invariant enforced by the API-level Zod schema.
  await prisma.user.update({
    where: { id: userId },
    data: {
      cancelPolicy: policy,
      cardTtlMinutes: policy === CardCancelPolicy.AFTER_TTL ? undefined : null,
    },
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
  try {
    const provider = await getProviderForIntent(intentId);
    await provider.cancelCard(intentId);
    const keyboard = new InlineKeyboard().text('⬅️ Back to Menu', 'menu_main:_');
    await editMenu(bot, chatId, messageId, '✅ Card cancelled successfully.', keyboard);
  } catch {
    const keyboard = new InlineKeyboard().text('⬅️ Back to Menu', 'menu_main:_');
    await editMenu(
      bot,
      chatId,
      messageId,
      '⚠️ Something went wrong cancelling the card. Please try again.',
      keyboard,
    );
  }
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

  try {
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
      const policy = payload as CardCancelPolicy;
      if (policy === CardCancelPolicy.AFTER_TTL) {
        await showTtlPicker(bot, chatId, messageId);
      } else {
        await savePrefPolicy(bot, chatId, messageId, user.id, policy);
      }
    } else if (action === 'menu_pref_ttl') {
      const minutes = parseInt(payload, 10);
      await savePrefTtl(bot, chatId, messageId, user.id, minutes);
    }
    // Unknown menu_* actions: silently ignore (no crash)
  } catch {
    await editMenu(bot, chatId, messageId, '⚠️ Something went wrong. Please try again.');
  }
}
