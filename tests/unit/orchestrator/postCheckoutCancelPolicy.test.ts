jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: { findUnique: jest.fn() },
  },
}));

jest.mock('@/payments', () => ({
  getPaymentProvider: jest.fn(),
  getProviderForIntent: jest.fn(),
}));

jest.mock('@/queue/producers', () => ({
  enqueueCancelCard: jest.fn(),
}));

jest.mock('@/orchestrator/stateMachine', () => ({
  transitionIntent: jest.fn(),
}));

jest.mock('@/telegram/telegramClient', () => ({
  getTelegramBot: () => ({ api: { sendMessage: jest.fn() } }),
}));

import { completeCheckout } from '@/orchestrator/intentService';
import { prisma } from '@/db/client';
import { getPaymentProvider } from '@/payments';
import { enqueueCancelCard } from '@/queue/producers';
import { transitionIntent } from '@/orchestrator/stateMachine';
import { IntentStatus, PaymentProvider } from '@/contracts';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetPaymentProvider = getPaymentProvider as jest.Mock;
const mockEnqueueCancelCard = enqueueCancelCard as jest.Mock;
const mockTransitionIntent = transitionIntent as jest.Mock;

// Flush the fire-and-forget applyPostCheckoutCancelPolicy chain.
const flush = () => new Promise<void>((r) => setImmediate(r));

describe('completeCheckout — AFTER_TTL cancel policy', () => {
  let mockCancelCard: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelCard = jest.fn().mockResolvedValue(undefined);
    mockGetPaymentProvider.mockReturnValue({
      cancelCard: mockCancelCard,
      freezeCard: jest.fn(),
    });
    mockTransitionIntent.mockResolvedValue({
      previousStatus: IntentStatus.CHECKOUT_RUNNING,
      newStatus: IntentStatus.DONE,
      intent: { id: 'intent-1', status: IntentStatus.DONE },
    });
  });

  function intentWithUser(overrides: { cancelPolicy: string; cardTtlMinutes: number | null }) {
    return {
      id: 'intent-1',
      user: {
        cancelPolicy: overrides.cancelPolicy,
        cardTtlMinutes: overrides.cardTtlMinutes,
        telegramChatId: null,
        paymentProvider: PaymentProvider.STRIPE,
      },
      virtualCard: { id: 'card-1' },
    };
  }

  it('cancels immediately when cardTtlMinutes is 0 (does not enqueue a 0-delay job)', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue(
      intentWithUser({ cancelPolicy: 'AFTER_TTL', cardTtlMinutes: 0 }),
    );

    await completeCheckout('intent-1', 1000);
    await flush();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
  });

  it('cancels immediately when cardTtlMinutes is negative', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue(
      intentWithUser({ cancelPolicy: 'AFTER_TTL', cardTtlMinutes: -5 }),
    );

    await completeCheckout('intent-1', 1000);
    await flush();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
  });

  it('enqueues a delayed cancel when cardTtlMinutes is positive', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue(
      intentWithUser({ cancelPolicy: 'AFTER_TTL', cardTtlMinutes: 30 }),
    );

    await completeCheckout('intent-1', 1000);
    await flush();

    expect(mockEnqueueCancelCard).toHaveBeenCalledWith('intent-1', 30 * 60 * 1000);
    expect(mockCancelCard).not.toHaveBeenCalled();
  });

  it('falls back to immediate cancel when cardTtlMinutes is null under AFTER_TTL', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue(
      intentWithUser({ cancelPolicy: 'AFTER_TTL', cardTtlMinutes: null }),
    );

    await completeCheckout('intent-1', 1000);
    await flush();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
  });
});
