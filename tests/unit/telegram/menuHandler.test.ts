// Mock prisma before imports
jest.mock('@/db/client', () => ({
  prisma: {
    user: { findFirst: jest.fn(), update: jest.fn() },
    pot: { findMany: jest.fn() },
    purchaseIntent: { findMany: jest.fn(), findUnique: jest.fn() },
  },
}));

// Mock Telegram bot
const mockSendMessage = jest.fn().mockResolvedValue({ message_id: 99 });
const mockEditMessageText = jest.fn().mockResolvedValue({});
jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: () => ({
    api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText },
  }),
}));

// Mock expireIntent
const mockExpireIntent = jest.fn();
jest.mock('@/orchestrator/intentService', () => ({
  expireIntent: (...args: any[]) => mockExpireIntent(...args),
}));

// Mock payment provider
const mockCancelCard = jest.fn();
const mockFreezeCard = jest.fn();
const mockProvider = { cancelCard: mockCancelCard, freezeCard: mockFreezeCard };
jest.mock('@/payments', () => ({
  getPaymentProvider: () => mockProvider,
  getProviderForIntent: () => Promise.resolve(mockProvider),
  getProviderForUser: () => Promise.resolve(mockProvider),
}));

// Mock sessionStore
const mockSetPrefSession = jest.fn();
jest.mock('@/telegram/sessionStore', () => ({
  setPrefSession: (...args: any[]) => mockSetPrefSession(...args),
  getPrefSession: jest.fn(),
  clearPrefSession: jest.fn(),
  getSignupSession: jest.fn(),
  setSignupSession: jest.fn(),
  clearSignupSession: jest.fn(),
}));

import { sendMainMenu, handleMenuCallback } from '@/telegram/menuHandler';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const chatId = 111222;
const messageId = 99;
const fromId = 111222;

const baseUser = {
  id: 'user-1',
  telegramChatId: String(chatId),
  email: 'alice@example.com',
  agentId: 'agent-xyz123',
  mainBalance: 12500, // £125.00
  cancelPolicy: 'ON_TRANSACTION' as const,
  cardTtlMinutes: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockEditMessageText.mockResolvedValue({});
  mockSendMessage.mockResolvedValue({ message_id: 99 });
  mockCancelCard.mockResolvedValue(undefined);
  mockFreezeCard.mockResolvedValue(undefined);
  mockSetPrefSession.mockResolvedValue(undefined);
  (mockPrisma.user.update as jest.Mock).mockResolvedValue({});
});

// ── sendMainMenu ──────────────────────────────────────────────────────────────

describe('sendMainMenu', () => {
  it('sends main menu keyboard to chat', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await sendMainMenu(chatId);

    expect(mockSendMessage).toHaveBeenCalledWith(
      chatId,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    const call = mockSendMessage.mock.calls[0];
    const keyboard = call[2].reply_markup;
    const allButtons = keyboard.inline_keyboard.flat();
    // Expect at least 5 buttons
    expect(allButtons.length).toBeGreaterThanOrEqual(5);
  });

  it('prompts signup when user not found', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(null);

    await sendMainMenu(chatId);

    expect(mockSendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining('sign up'),
      expect.anything(),
    );
  });
});

// ── menu_balance ──────────────────────────────────────────────────────────────

describe('menu_balance', () => {
  it('shows main balance and reserved amount', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.pot.findMany as jest.Mock).mockResolvedValue([{ reservedAmount: 2500 }]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_balance',
      '_',
      fromId,
    );

    expect(mockEditMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      expect.stringContaining('£125.00'),
      expect.anything(),
    );
    expect(mockEditMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      expect.stringContaining('£25.00'),
      expect.anything(),
    );
  });

  it('shows £0.00 reserved when no active pots', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.pot.findMany as jest.Mock).mockResolvedValue([]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_balance',
      '_',
      fromId,
    );

    expect(mockEditMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      expect.stringContaining('Reserved:     £0.00'),
      expect.anything(),
    );
  });
});

// ── menu_history ──────────────────────────────────────────────────────────────

describe('menu_history', () => {
  it('shows last 5 DONE intents', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.purchaseIntent.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'i1',
        subject: 'headphones',
        query: 'headphones',
        maxBudget: 4500,
        pot: { settledAmount: 4500 },
      },
      {
        id: 'i2',
        subject: 'coffee maker',
        query: 'coffee',
        maxBudget: 8900,
        pot: { settledAmount: 8900 },
      },
    ]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_history',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text).toContain('headphones');
    expect(text).toContain('£45.00');
  });

  it('shows empty state when no history', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.purchaseIntent.findMany as jest.Mock).mockResolvedValue([]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_history',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('no purchases');
  });
});

// ── menu_cancel_list ──────────────────────────────────────────────────────────

describe('menu_cancel_list', () => {
  it('renders one button per active intent', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.purchaseIntent.findMany as jest.Mock).mockResolvedValue([
      {
        id: 'i1',
        subject: 'headphones',
        query: 'headphones',
        maxBudget: 5000,
        status: 'SEARCHING',
      },
      {
        id: 'i2',
        subject: 'coffee',
        query: 'coffee',
        maxBudget: 8900,
        status: 'AWAITING_APPROVAL',
      },
    ]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_cancel_list',
      '_',
      fromId,
    );

    const keyboard = mockEditMessageText.mock.calls[0][3].reply_markup;
    const buttons = keyboard.inline_keyboard.flat();
    const cancelButtons = buttons.filter((b: any) =>
      b.callback_data?.startsWith('menu_cancel_confirm:'),
    );
    expect(cancelButtons).toHaveLength(2);
  });

  it('shows empty state when no active intents', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);
    (mockPrisma.purchaseIntent.findMany as jest.Mock).mockResolvedValue([]);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_cancel_list',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('no active intents');
  });
});

// ── menu_cancel_confirm ───────────────────────────────────────────────────────

describe('menu_cancel_confirm', () => {
  it('shows intent details with confirm and back buttons', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
      id: 'i1',
      subject: 'headphones',
      query: 'headphones',
      maxBudget: 5000,
      status: 'SEARCHING',
    });

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_cancel_confirm',
      'i1',
      fromId,
    );

    const keyboard = mockEditMessageText.mock.calls[0][3].reply_markup;
    const buttons = keyboard.inline_keyboard.flat();
    const confirmBtn = buttons.find((b: any) => b.callback_data?.startsWith('menu_cancel_do:'));
    const backBtn = buttons.find((b: any) => b.callback_data === 'menu_cancel_list:_');
    expect(confirmBtn).toBeDefined();
    expect(backBtn).toBeDefined();
  });
});

// ── menu_cancel_do ────────────────────────────────────────────────────────────

describe('menu_cancel_do', () => {
  it('calls expireIntent with the intentId', async () => {
    mockExpireIntent.mockResolvedValue({ status: 'EXPIRED' });

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_cancel_do',
      'intent-abc',
      fromId,
    );

    expect(mockExpireIntent).toHaveBeenCalledWith('intent-abc');
  });

  it('edits message with confirmation on success', async () => {
    mockExpireIntent.mockResolvedValue({ status: 'EXPIRED' });

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_cancel_do',
      'intent-abc',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('cancelled');
  });

  it('shows error and does not rethrow when expireIntent throws', async () => {
    mockExpireIntent.mockRejectedValue(new Error('fail'));

    await expect(
      handleMenuCallback(
        { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
        chatId,
        messageId,
        'menu_cancel_do',
        'intent-abc',
        fromId,
      ),
    ).resolves.toBeUndefined();

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('went wrong');
  });
});

// ── menu_agent ────────────────────────────────────────────────────────────────

describe('menu_agent', () => {
  it('shows agentId when agent is linked', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_agent',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text).toContain('agent-xyz123');
  });

  it('prompts to link when no agent', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue({ ...baseUser, agentId: null });

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_agent',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text).toContain('/start');
  });
});

// ── menu_preferences ─────────────────────────────────────────────────────────

describe('menu_preferences', () => {
  it('shows current policy and policy picker buttons', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_preferences',
      '_',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('cancel policy');

    const opts = mockEditMessageText.mock.calls[0][3];
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const actions = buttons.map((b: any) => b.callback_data);
    expect(actions).toContain('menu_pref_policy:ON_TRANSACTION');
    expect(actions).toContain('menu_pref_policy:AFTER_TTL');
  });
});

// ── menu_pref_policy ─────────────────────────────────────────────────────────

describe('menu_pref_policy', () => {
  it('saves IMMEDIATE policy and shows confirmation', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_pref_policy',
      'IMMEDIATE',
      fromId,
    );

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { cancelPolicy: 'IMMEDIATE' },
      }),
    );
    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('saved');
  });

  it('shows TTL picker when AFTER_TTL is selected', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_pref_policy',
      'AFTER_TTL',
      fromId,
    );

    const opts = mockEditMessageText.mock.calls[0][3];
    const buttons = opts.reply_markup.inline_keyboard.flat();
    const actions = buttons.map((b: any) => b.callback_data);
    expect(actions).toContain('menu_pref_ttl:30');
    expect(actions).toContain('menu_pref_ttl:custom');
  });
});

// ── menu_pref_ttl ─────────────────────────────────────────────────────────────

describe('menu_pref_ttl', () => {
  it('saves AFTER_TTL policy with preset minutes and confirms', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_pref_ttl',
      '60',
      fromId,
    );

    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { cancelPolicy: 'AFTER_TTL', cardTtlMinutes: 60 },
      }),
    );
    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text).toContain('60 min');
  });

  it('sets Redis session, clears keyboard, and sends ForceReply prompt when custom is selected', async () => {
    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_pref_ttl',
      'custom',
      fromId,
    );

    expect(mockSetPrefSession).toHaveBeenCalledWith(chatId, {
      awaitingCustomTtl: true,
      promptMessageId: expect.any(Number),
    });
    // Original keyboard message is edited to remove buttons
    expect(mockEditMessageText).toHaveBeenCalled();
    // A new ForceReply message is sent
    expect(mockSendMessage).toHaveBeenCalledWith(
      chatId,
      expect.stringContaining('minutes'),
      expect.objectContaining({ reply_markup: expect.objectContaining({ force_reply: true }) }),
    );
  });
});

// ── menu_card_cancel ──────────────────────────────────────────────────────────

describe('menu_card_cancel', () => {
  it('calls cancelCard and confirms', async () => {
    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_card_cancel',
      'intent-abc',
      fromId,
    );

    expect(mockCancelCard).toHaveBeenCalledWith('intent-abc');
    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('cancelled');
  });

  it('shows error message when cancelCard throws', async () => {
    mockCancelCard.mockRejectedValue(new Error('Stripe error'));

    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_card_cancel',
      'intent-abc',
      fromId,
    );

    const text = mockEditMessageText.mock.calls[0][2] as string;
    expect(text.toLowerCase()).toContain('went wrong');
  });
});

// ── menu_main ─────────────────────────────────────────────────────────────────

describe('menu_main', () => {
  it('edits message back to main menu with keyboard', async () => {
    await handleMenuCallback(
      { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
      chatId,
      messageId,
      'menu_main',
      '_',
      fromId,
    );

    expect(mockEditMessageText).toHaveBeenCalledWith(
      chatId,
      messageId,
      expect.any(String),
      expect.objectContaining({ reply_markup: expect.anything() }),
    );

    const keyboard = mockEditMessageText.mock.calls[0][3].reply_markup;
    const allButtons = keyboard.inline_keyboard.flat();
    expect(allButtons.length).toBeGreaterThanOrEqual(5);
  });
});

// ── unknown action ────────────────────────────────────────────────────────────

describe('unknown menu_ action', () => {
  it('resolves without throwing', async () => {
    (mockPrisma.user.findFirst as jest.Mock).mockResolvedValue(baseUser);

    await expect(
      handleMenuCallback(
        { api: { sendMessage: mockSendMessage, editMessageText: mockEditMessageText } } as any,
        chatId,
        messageId,
        'menu_unknown_action',
        '_',
        fromId,
      ),
    ).resolves.toBeUndefined();
  });
});
