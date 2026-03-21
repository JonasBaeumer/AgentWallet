import {
  getTelegramMockCalls,
  clearTelegramMockCalls,
  getMockBot,
} from '@/telegram/mockBot';

beforeEach(() => {
  clearTelegramMockCalls();
});

describe('mockBot — call recording', () => {
  it('getTelegramMockCalls() returns empty array initially', () => {
    const calls = getTelegramMockCalls();
    expect(calls).toEqual([]);
  });

  it('clearTelegramMockCalls() resets the call log', async () => {
    const bot = getMockBot();
    await bot.api.sendMessage('123', 'hello');
    expect(getTelegramMockCalls()).toHaveLength(1);

    clearTelegramMockCalls();
    expect(getTelegramMockCalls()).toEqual([]);
  });

  it('api.sendMessage() records the call with correct chatId and text', async () => {
    const bot = getMockBot();
    await bot.api.sendMessage('42', 'Buy milk');

    const calls = getTelegramMockCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('sendMessage');
    expect(calls[0].args[0]).toBe('42');
    expect(calls[0].args[1]).toBe('Buy milk');
    expect(typeof calls[0].timestamp).toBe('number');
  });

  it('api.sendMessage() returns an object with message_id', async () => {
    const bot = getMockBot();
    const result = await bot.api.sendMessage('99', 'test');

    expect(result).toHaveProperty('message_id');
    expect(typeof result.message_id).toBe('number');
    expect(result.text).toBe('test');
    expect(result.chat.id).toBe(99);
  });

  it('api.answerCallbackQuery() records the call and returns true', async () => {
    const bot = getMockBot();
    const result = await bot.api.answerCallbackQuery('cb-123', { text: 'Done' });

    expect(result).toBe(true);
    const calls = getTelegramMockCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('answerCallbackQuery');
    expect(calls[0].args[0]).toBe('cb-123');
    expect(calls[0].args[1]).toEqual({ text: 'Done' });
  });

  it('api.editMessageText() records the call', async () => {
    const bot = getMockBot();
    await bot.api.editMessageText('42', 7, 'Updated text');

    const calls = getTelegramMockCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('editMessageText');
    expect(calls[0].args).toEqual(['42', 7, 'Updated text', undefined]);
  });

  it('multiple calls accumulate in order', async () => {
    const bot = getMockBot();
    await bot.api.sendMessage('1', 'first');
    await bot.api.answerCallbackQuery('cb-1');
    await bot.api.sendMessage('2', 'second');
    await bot.api.editMessageText('2', 5, 'edited');

    const calls = getTelegramMockCalls();
    expect(calls).toHaveLength(4);
    expect(calls.map((c) => c.method)).toEqual([
      'sendMessage',
      'answerCallbackQuery',
      'sendMessage',
      'editMessageText',
    ]);
    // timestamps should be monotonically non-decreasing
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i].timestamp).toBeGreaterThanOrEqual(calls[i - 1].timestamp);
    }
  });

  it('clearTelegramMockCalls() between tests does not bleed state', () => {
    // This test relies on beforeEach having cleared calls.
    // If state bled from the previous test, there would be leftover calls.
    expect(getTelegramMockCalls()).toEqual([]);
  });

  it('getTelegramMockCalls() returns a copy, not the internal array', async () => {
    const bot = getMockBot();
    await bot.api.sendMessage('1', 'a');
    const snapshot = getTelegramMockCalls();
    await bot.api.sendMessage('2', 'b');
    // snapshot should still have 1, not 2
    expect(snapshot).toHaveLength(1);
    expect(getTelegramMockCalls()).toHaveLength(2);
  });
});

describe('telegramClient — TELEGRAM_MOCK routing', () => {
  afterEach(() => {
    jest.resetModules();
    jest.restoreAllMocks();
  });

  it('returns mock bot when TELEGRAM_MOCK=true', () => {
    jest.doMock('@/config/env', () => ({
      env: {
        TELEGRAM_MOCK: true,
        TELEGRAM_BOT_TOKEN: '',
      },
    }));

    const { getTelegramBot } = require('@/telegram/telegramClient');
    const bot = getTelegramBot();
    expect(bot).toBeDefined();
    expect(bot.api).toBeDefined();
    expect(typeof bot.api.sendMessage).toBe('function');

    // Confirm it is the mock by verifying calls are recorded
    clearTelegramMockCalls();
    bot.api.sendMessage('1', 'test');
    expect(getTelegramMockCalls()).toHaveLength(1);
  });

  it('returns real bot when TELEGRAM_MOCK=false and a token is provided', () => {
    jest.doMock('@/config/env', () => ({
      env: {
        TELEGRAM_MOCK: false,
        TELEGRAM_BOT_TOKEN: 'fake-token-for-test',
      },
    }));

    const { getTelegramBot } = require('@/telegram/telegramClient');
    const bot = getTelegramBot();
    expect(bot).toBeDefined();
    // Real grammy Bot instances have a .token property — mock does not
    expect(bot.token).toBe('fake-token-for-test');
  });

  it('throws when TELEGRAM_MOCK=false and no token is configured', () => {
    jest.doMock('@/config/env', () => ({
      env: {
        TELEGRAM_MOCK: false,
        TELEGRAM_BOT_TOKEN: '',
      },
    }));

    const { getTelegramBot } = require('@/telegram/telegramClient');
    expect(() => getTelegramBot()).toThrow('TELEGRAM_BOT_TOKEN is not configured');
  });
});
