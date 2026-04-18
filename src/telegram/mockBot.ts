/**
 * Mock Telegram bot that records every API call without making real HTTP requests.
 * Activated when TELEGRAM_MOCK=true.
 *
 * Implements the same bot.api.* surface used across the telegram module:
 *   - sendMessage
 *   - answerCallbackQuery
 *   - editMessageText
 */

export interface MockCall {
  method: string;
  args: unknown[];
  timestamp: number;
}

const calls: MockCall[] = [];

function record(method: string, args: unknown[]): void {
  calls.push({ method, args, timestamp: Date.now() });
}

export function getTelegramMockCalls(): MockCall[] {
  return [...calls];
}

export function clearTelegramMockCalls(): void {
  calls.length = 0;
}

let _messageIdCounter = 1;

const mockApi = {
  sendMessage(chatId: string | number, text: string, opts?: unknown) {
    record('sendMessage', [chatId, text, opts]);
    const messageId = _messageIdCounter++;
    return Promise.resolve({
      message_id: messageId,
      chat: {
        id: typeof chatId === 'string' ? parseInt(chatId, 10) || 0 : chatId,
        type: 'private' as const,
      },
      text,
      date: Math.floor(Date.now() / 1000),
    });
  },

  answerCallbackQuery(callbackQueryId: string, opts?: unknown) {
    record('answerCallbackQuery', [callbackQueryId, opts]);
    return Promise.resolve(true);
  },

  editMessageText(chatId: string | number, messageId: number, text: string, opts?: unknown) {
    record('editMessageText', [chatId, messageId, text, opts]);
    return Promise.resolve({
      message_id: messageId,
      chat: {
        id: typeof chatId === 'string' ? parseInt(chatId, 10) || 0 : chatId,
        type: 'private' as const,
      },
      text,
      date: Math.floor(Date.now() / 1000),
    });
  },
};

const mockBot = { api: mockApi } as any;

export function getMockBot(): typeof mockBot {
  return mockBot;
}
