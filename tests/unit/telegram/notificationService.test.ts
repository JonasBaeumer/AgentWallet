jest.mock('@/config/env', () => ({
  env: {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
    WORKER_API_KEY: 'test-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    TELEGRAM_TEST_CHAT_ID: '',
  },
}));

const mockSendMessage = jest.fn();
const mockGetTelegramBot = jest.fn(() => ({
  api: { sendMessage: mockSendMessage },
}));

jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: mockGetTelegramBot,
}));

const mockPrismaIntentFindUnique = jest.fn();
const mockPrismaIntentUpdate = jest.fn();

jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: {
      findUnique: mockPrismaIntentFindUnique,
      update: mockPrismaIntentUpdate,
    },
  },
}));

import { sendApprovalRequest } from '@/telegram/notificationService';

beforeEach(() => {
  jest.clearAllMocks();
  mockSendMessage.mockResolvedValue({ message_id: 42 });
  mockPrismaIntentUpdate.mockResolvedValue({});
});

describe('sendApprovalRequest', () => {
  function makeIntent(overrides: Partial<any> = {}) {
    return {
      id: 'intent-1',
      query: 'Sony headphones',
      subject: 'Buy Sony WH-1000XM5',
      maxBudget: 30000,
      currency: 'gbp',
      metadata: { merchantName: 'Amazon UK', price: 27999, currency: 'gbp' },
      user: { telegramChatId: '123456789' },
      ...overrides,
    };
  }

  it('sends message with correct chatId and inline keyboard when user has telegramChatId', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent());

    await sendApprovalRequest('intent-1');

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [chatId, , options] = mockSendMessage.mock.calls[0];
    expect(chatId).toBe('123456789');
    expect(options.parse_mode).toBe('HTML');
    expect(options.reply_markup).toBeDefined();
  });

  it('message text contains subject when present', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent());

    await sendApprovalRequest('intent-1');

    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Buy Sony WH-1000XM5');
  });

  it('falls back to query when subject is null', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent({ subject: null }));

    await sendApprovalRequest('intent-1');

    const text = mockSendMessage.mock.calls[0][1] as string;
    expect(text).toContain('Sony headphones');
    expect(text).not.toContain('Buy Sony WH-1000XM5');
  });

  it('does NOT send message when user has no telegramChatId', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent({ user: { telegramChatId: null } }));

    await sendApprovalRequest('intent-1');

    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('does not throw when sendMessage fails', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent());
    mockSendMessage.mockRejectedValue(new Error('Telegram API down'));

    await expect(sendApprovalRequest('intent-1')).resolves.toBeUndefined();
  });

  it('persists telegramMessageId into intent metadata after send', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(makeIntent());
    mockSendMessage.mockResolvedValue({ message_id: 99 });

    await sendApprovalRequest('intent-1');

    expect(mockPrismaIntentUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'intent-1' },
        data: expect.objectContaining({
          metadata: expect.objectContaining({ telegramMessageId: 99 }),
        }),
      }),
    );
  });

  it('returns early without throwing when intent is not found', async () => {
    mockPrismaIntentFindUnique.mockResolvedValue(null);

    await expect(sendApprovalRequest('intent-missing')).resolves.toBeUndefined();
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});
