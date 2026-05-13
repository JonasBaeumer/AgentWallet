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
  },
}));

const mockAnswerCallbackQuery = jest.fn().mockResolvedValue(undefined);
const mockEditMessageText = jest.fn().mockResolvedValue(undefined);
const mockGetTelegramBot = jest.fn(() => ({
  api: {
    answerCallbackQuery: mockAnswerCallbackQuery,
    editMessageText: mockEditMessageText,
  },
}));

jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: mockGetTelegramBot,
}));

const mockRecordDecision = jest.fn().mockResolvedValue({});
jest.mock('@/approval/approvalService', () => ({
  recordDecision: mockRecordDecision,
}));

const mockReserveForIntent = jest.fn().mockResolvedValue({});
const mockReturnIntent = jest.fn().mockResolvedValue(undefined);
jest.mock('@/ledger/potService', () => ({
  reserveForIntent: mockReserveForIntent,
  returnIntent: mockReturnIntent,
}));

const mockIssueCard = jest.fn().mockResolvedValue({ providerCardId: 'ic_test', last4: '4242' });
const mockRevealCard = jest.fn().mockResolvedValue({
  number: '4242424242424242',
  cvc: '123',
  expMonth: 12,
  expYear: 2030,
  last4: '4242',
});
const mockFreezeCard = jest.fn().mockResolvedValue(undefined);
const mockCancelCard = jest.fn().mockResolvedValue(undefined);
const mockHandleWebhookEvent = jest.fn().mockResolvedValue(undefined);
const mockGetIssuingBalance = jest
  .fn()
  .mockResolvedValue({ available: 999_999_99, currency: 'eur' });
const mockProvider = {
  issueCard: mockIssueCard,
  revealCard: mockRevealCard,
  freezeCard: mockFreezeCard,
  cancelCard: mockCancelCard,
  handleWebhookEvent: mockHandleWebhookEvent,
  getIssuingBalance: mockGetIssuingBalance,
};
jest.mock('@/payments', () => ({
  getPaymentProvider: () => mockProvider,
  getProviderForIntent: () => Promise.resolve(mockProvider),
  getProviderForUser: () => Promise.resolve(mockProvider),
}));

const mockMarkCardIssued = jest.fn().mockResolvedValue({});
const mockStartCheckout = jest.fn().mockResolvedValue({});
jest.mock('@/orchestrator/intentService', () => ({
  markCardIssued: mockMarkCardIssued,
  startCheckout: mockStartCheckout,
}));

const mockEnqueueCheckout = jest.fn().mockResolvedValue(undefined);
jest.mock('@/queue/producers', () => ({
  enqueueCheckout: mockEnqueueCheckout,
}));

// Session store mock
const mockGetSession = jest.fn();
const mockSetSession = jest.fn();
const mockClearSession = jest.fn();
jest.mock('@/telegram/sessionStore', () => ({
  getSignupSession: (...args: any[]) => mockGetSession(...args),
  setSignupSession: (...args: any[]) => mockSetSession(...args),
  clearSignupSession: (...args: any[]) => mockClearSession(...args),
}));

const dbIntents: Record<string, any> = {};
const dbIdempotency: Record<string, any> = {};

jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbIntents[where.id] ?? null)),
    },
    idempotencyRecord: {
      findUnique: jest.fn(({ where }: any) => Promise.resolve(dbIdempotency[where.key] ?? null)),
      upsert: jest.fn(({ where, create }: any) => {
        if (!dbIdempotency[where.key]) dbIdempotency[where.key] = create;
        return Promise.resolve(dbIdempotency[where.key]);
      }),
    },
  },
}));

import { handleTelegramCallback } from '@/telegram/callbackHandler';
import { IntentStatus, ApprovalDecisionType } from '@/contracts';

beforeEach(() => {
  jest.clearAllMocks();
  Object.keys(dbIntents).forEach((k) => delete dbIntents[k]);
  Object.keys(dbIdempotency).forEach((k) => delete dbIdempotency[k]);

  mockAnswerCallbackQuery.mockResolvedValue(undefined);
  mockEditMessageText.mockResolvedValue(undefined);
  mockIssueCard.mockResolvedValue({ providerCardId: 'ic_test', last4: '4242' });
  mockGetSession.mockResolvedValue(null);
  mockSetSession.mockResolvedValue(undefined);
  mockClearSession.mockResolvedValue(undefined);
});

function makeUpdate(action: string, payload: string, cbId = 'cb-1', fromId = 111): any {
  return {
    callback_query: {
      id: cbId,
      data: `${action}:${payload}`,
      from: { id: fromId },
      message: { message_id: 10, chat: { id: 999 } },
    },
  };
}

function seedAwaitingIntent(id: string) {
  dbIntents[id] = {
    id,
    userId: 'user-1',
    status: IntentStatus.AWAITING_APPROVAL,
    maxBudget: 10000,
    currency: 'eur',
    metadata: { merchantName: 'Amazon UK', merchantUrl: 'https://amazon.co.uk', price: 9999 },
    user: { id: 'user-1', mccAllowlist: [], paymentProvider: 'STRIPE' },
  };
}

// ─── link_confirm / link_cancel callbacks ──────────────────────────────────────

describe('handleTelegramCallback — link_confirm', () => {
  it('advances session to awaiting_email and edits message on confirm', async () => {
    const session = {
      step: 'awaiting_confirmation' as const,
      agentId: 'ag_test',
      pairingCode: 'ABCD1234',
    };
    mockGetSession.mockResolvedValue(session);

    await handleTelegramCallback(makeUpdate('link_confirm', '_', 'cb-lc1', 12345678));

    expect(mockSetSession).toHaveBeenCalledWith(
      12345678,
      expect.objectContaining({
        step: 'awaiting_email',
        agentId: 'ag_test',
        pairingCode: 'ABCD1234',
      }),
    );
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('email'),
      expect.any(Object),
    );
  });

  it('shows error message when session is missing or expired on confirm', async () => {
    mockGetSession.mockResolvedValue(null);

    await handleTelegramCallback(makeUpdate('link_confirm', '_', 'cb-lc2', 12345678));

    expect(mockSetSession).not.toHaveBeenCalled();
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('Session expired'),
      expect.any(Object),
    );
  });

  it('does not touch purchase approval flow on link_confirm', async () => {
    const session = {
      step: 'awaiting_confirmation' as const,
      agentId: 'ag_test',
      pairingCode: 'ABCD1234',
    };
    mockGetSession.mockResolvedValue(session);

    await handleTelegramCallback(makeUpdate('link_confirm', '_', 'cb-lc3', 12345678));

    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockIssueCard).not.toHaveBeenCalled();
  });
});

describe('handleTelegramCallback — link_cancel', () => {
  it('clears session and edits message on cancel', async () => {
    const session = {
      step: 'awaiting_confirmation' as const,
      agentId: 'ag_test',
      pairingCode: 'ABCD1234',
    };
    mockGetSession.mockResolvedValue(session);

    await handleTelegramCallback(makeUpdate('link_cancel', '_', 'cb-lcancel1', 12345678));

    expect(mockClearSession).toHaveBeenCalledWith(12345678);
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('cancelled'),
      expect.any(Object),
    );
  });

  it('shows error message when session is missing on cancel', async () => {
    mockGetSession.mockResolvedValue(null);

    await handleTelegramCallback(makeUpdate('link_cancel', '_', 'cb-lcancel2', 12345678));

    expect(mockClearSession).not.toHaveBeenCalled();
    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('Session expired'),
      expect.any(Object),
    );
  });
});

// ─── Core approve/reject behaviour ────────────────────────────────────────────

describe('handleTelegramCallback — approve path', () => {
  it('calls answerCallbackQuery first (before any service work)', async () => {
    seedAwaitingIntent('intent-cb1');
    const callOrder: string[] = [];
    mockAnswerCallbackQuery.mockImplementation(() => {
      callOrder.push('answer');
      return Promise.resolve();
    });
    mockGetIssuingBalance.mockImplementation(() => {
      callOrder.push('balance');
      return Promise.resolve({ available: 999_999_99, currency: 'eur' });
    });
    mockRecordDecision.mockImplementation(() => {
      callOrder.push('record');
      return Promise.resolve({});
    });

    await handleTelegramCallback(makeUpdate('approve', 'intent-cb1', 'cb-cb1'));

    expect(callOrder[0]).toBe('answer');
    expect(callOrder[1]).toBe('balance');
    expect(callOrder[2]).toBe('record');
  });

  it('calls all 7 service functions in correct order (balance before recordDecision)', async () => {
    seedAwaitingIntent('intent-cb2');
    const order: string[] = [];
    mockGetIssuingBalance.mockImplementation(() => {
      order.push('getIssuingBalance');
      return Promise.resolve({ available: 999_999_99, currency: 'eur' });
    });
    mockRecordDecision.mockImplementation(() => {
      order.push('recordDecision');
      return Promise.resolve({});
    });
    mockReserveForIntent.mockImplementation(() => {
      order.push('reserveForIntent');
      return Promise.resolve({});
    });
    mockIssueCard.mockImplementation(() => {
      order.push('issueCard');
      return Promise.resolve({ providerCardId: 'ic_t', last4: '4242' });
    });
    mockMarkCardIssued.mockImplementation(() => {
      order.push('markCardIssued');
      return Promise.resolve({});
    });
    mockStartCheckout.mockImplementation(() => {
      order.push('startCheckout');
      return Promise.resolve({});
    });
    mockEnqueueCheckout.mockImplementation(() => {
      order.push('enqueueCheckout');
      return Promise.resolve();
    });

    await handleTelegramCallback(makeUpdate('approve', 'intent-cb2', 'cb-cb2'));

    expect(order).toEqual([
      'getIssuingBalance',
      'recordDecision',
      'reserveForIntent',
      'issueCard',
      'markCardIssued',
      'startCheckout',
      'enqueueCheckout',
    ]);
  });

  it('edits message to success text after approve', async () => {
    seedAwaitingIntent('intent-cb3');

    await handleTelegramCallback(makeUpdate('approve', 'intent-cb3', 'cb-cb3'));

    expect(mockEditMessageText).toHaveBeenCalledWith(
      999,
      10,
      '✅ Approved. Checkout is running.',
      expect.any(Object),
    );
  });
});

describe('handleTelegramCallback — reject path', () => {
  it('only calls recordDecision(DENIED); no reserve/card/checkout', async () => {
    seedAwaitingIntent('intent-rej1');

    await handleTelegramCallback(makeUpdate('reject', 'intent-rej1', 'cb-rej1'));

    expect(mockRecordDecision).toHaveBeenCalledWith(
      'intent-rej1',
      ApprovalDecisionType.DENIED,
      expect.any(String),
      'Rejected via Telegram',
    );
    expect(mockReserveForIntent).not.toHaveBeenCalled();
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockEnqueueCheckout).not.toHaveBeenCalled();
  });

  it('edits message to rejected text', async () => {
    seedAwaitingIntent('intent-rej2');

    await handleTelegramCallback(makeUpdate('reject', 'intent-rej2', 'cb-rej2'));

    expect(mockEditMessageText).toHaveBeenCalledWith(999, 10, '❌ Rejected.', expect.any(Object));
  });
});

describe('handleTelegramCallback — guard: not AWAITING_APPROVAL', () => {
  it('does not call any service function when status is not AWAITING_APPROVAL', async () => {
    dbIntents['intent-done'] = {
      ...dbIntents['intent-done'],
      id: 'intent-done',
      status: IntentStatus.DONE,
      userId: 'u',
      metadata: {},
      user: {},
    };

    await handleTelegramCallback(makeUpdate('approve', 'intent-done', 'cb-done'));

    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockReserveForIntent).not.toHaveBeenCalled();
  });

  it('edits message with current status when already processed', async () => {
    dbIntents['intent-alr'] = {
      id: 'intent-alr',
      status: IntentStatus.CHECKOUT_RUNNING,
      userId: 'u',
      metadata: {},
      user: {},
    };

    await handleTelegramCallback(makeUpdate('approve', 'intent-alr', 'cb-alr'));

    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('CHECKOUT_RUNNING'),
      expect.any(Object),
    );
  });
});

describe('handleTelegramCallback — idempotency guard', () => {
  it('does not reprocess if callbackQueryId already handled', async () => {
    seedAwaitingIntent('intent-idem');
    dbIdempotency['telegram_cb:cb-idem'] = { action: 'approve', intentId: 'intent-idem' };

    await handleTelegramCallback(makeUpdate('approve', 'intent-idem', 'cb-idem'));

    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});

describe('handleTelegramCallback — insufficient Issuing balance', () => {
  it('does not record decision, reserve, or issue card when Issuing balance is insufficient', async () => {
    seedAwaitingIntent('intent-bal1');
    mockGetIssuingBalance.mockResolvedValueOnce({ available: 500, currency: 'eur' });

    await handleTelegramCallback(makeUpdate('approve', 'intent-bal1', 'cb-bal1'));

    expect(mockRecordDecision).not.toHaveBeenCalled();
    expect(mockReserveForIntent).not.toHaveBeenCalled();
    expect(mockIssueCard).not.toHaveBeenCalled();
    expect(mockEnqueueCheckout).not.toHaveBeenCalled();
  });

  it('edits message with balance error when insufficient', async () => {
    seedAwaitingIntent('intent-bal2');
    mockGetIssuingBalance.mockResolvedValueOnce({ available: 500, currency: 'eur' });

    await handleTelegramCallback(makeUpdate('approve', 'intent-bal2', 'cb-bal2'));

    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('Insufficient Stripe Issuing balance'),
      expect.any(Object),
    );
  });

  it('does not re-throw — handles gracefully', async () => {
    seedAwaitingIntent('intent-bal3');
    mockGetIssuingBalance.mockResolvedValueOnce({ available: 0, currency: 'eur' });

    await expect(
      handleTelegramCallback(makeUpdate('approve', 'intent-bal3', 'cb-bal3')),
    ).resolves.toBeUndefined();
  });
});

describe('handleTelegramCallback — issueVirtualCard failure compensation', () => {
  it('calls returnIntent when issueVirtualCard throws', async () => {
    seedAwaitingIntent('intent-fail');
    mockIssueCard.mockRejectedValueOnce(new Error('Stripe down'));

    await expect(
      handleTelegramCallback(makeUpdate('approve', 'intent-fail', 'cb-fail')),
    ).rejects.toThrow('Stripe down');

    expect(mockReturnIntent).toHaveBeenCalledWith('intent-fail');
  });

  it('edits message with error text when issueVirtualCard throws', async () => {
    seedAwaitingIntent('intent-fail2');
    mockIssueCard.mockRejectedValueOnce(new Error('Stripe down'));

    await expect(
      handleTelegramCallback(makeUpdate('approve', 'intent-fail2', 'cb-fail2')),
    ).rejects.toThrow();

    expect(mockEditMessageText).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringContaining('⚠️'),
      expect.any(Object),
    );
  });

  it('saves idempotency record before processing so retries are blocked', async () => {
    seedAwaitingIntent('intent-idem2');
    mockIssueCard.mockRejectedValueOnce(new Error('Stripe down'));

    await expect(
      handleTelegramCallback(makeUpdate('approve', 'intent-idem2', 'cb-idem2')),
    ).rejects.toThrow();

    // Re-run with same callbackQueryId — idempotency guard should block it
    mockIssueCard.mockResolvedValue({ providerCardId: 'ic_t', last4: '4242' });
    jest.clearAllMocks();
    // Restore the idempotency entry (upsert mock already saved it via the real dbIdempotency object)
    await handleTelegramCallback(makeUpdate('approve', 'intent-idem2', 'cb-idem2'));
    expect(mockRecordDecision).not.toHaveBeenCalled();
  });
});
