/**
 * Unit tests for the post-checkout cancel policy branch in
 * `src/orchestrator/intentService.ts`.
 *
 * These cover regressions from issue #89:
 *   - AFTER_TTL with a valid cardTtlMinutes enqueues a delayed cancel job
 *   - AFTER_TTL with null/0/negative cardTtlMinutes must NOT silently no-op;
 *     it must fall back to IMMEDIATE cancellation and log an error so the
 *     card never remains live after checkout
 *   - IMMEDIATE cancels synchronously
 *   - MANUAL freezes and notifies via the telegram module (no direct UI
 *     imports in orchestrator)
 */

jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: { findUnique: jest.fn(), update: jest.fn() },
    auditEvent: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}));

const mockCancelCard = jest.fn();
const mockFreezeCard = jest.fn();
jest.mock('@/payments', () => ({
  getPaymentProvider: jest.fn(() => ({ cancelCard: mockCancelCard, freezeCard: mockFreezeCard })),
}));

const mockEnqueueCancelCard = jest.fn();
jest.mock('@/queue/producers', () => ({
  enqueueCancelCard: (...args: unknown[]) => mockEnqueueCancelCard(...args),
  enqueueSearch: jest.fn(),
  enqueueCheckout: jest.fn(),
}));

const mockSendManualCardPendingNotice = jest.fn();
jest.mock('@/telegram/notificationService', () => ({
  sendManualCardPendingNotice: (...args: unknown[]) => mockSendManualCardPendingNotice(...args),
  sendApprovalRequest: jest.fn(),
}));

// Silence state-machine transitionIntent — we only care about the
// fire-and-forget cancel policy side effect invoked by completeCheckout.
jest.mock('@/orchestrator/stateMachine', () => ({
  transitionIntent: jest.fn().mockResolvedValue({
    previousStatus: 'CHECKOUT_RUNNING',
    newStatus: 'DONE',
    intent: {},
  }),
}));

import { completeCheckout } from '@/orchestrator/intentService';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function mockIntent(
  cancelPolicy: string,
  cardTtlMinutes: number | null,
  overrides: {
    telegramChatId?: string | null;
    hasVirtualCard?: boolean;
    subject?: string | null;
  } = {},
) {
  const telegramChatId =
    'telegramChatId' in overrides ? (overrides.telegramChatId ?? null) : '1234';
  (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
    id: 'intent-1',
    subject: overrides.subject ?? 'headphones',
    query: 'headphones',
    user: {
      cancelPolicy,
      cardTtlMinutes,
      telegramChatId,
      paymentProvider: 'STRIPE',
    },
    virtualCard: overrides.hasVirtualCard === false ? null : { id: 'vc-1' },
  });
}

// completeCheckout triggers applyPostCheckoutCancelPolicy via a fire-and-forget
// .catch chain — yield to the next event-loop turn so pending awaits settle.
async function flushAsync() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  jest.clearAllMocks();
  mockCancelCard.mockResolvedValue(undefined);
  mockFreezeCard.mockResolvedValue(undefined);
  mockEnqueueCancelCard.mockResolvedValue(undefined);
  mockSendManualCardPendingNotice.mockResolvedValue(undefined);
});

afterAll(() => {
  errorSpy.mockRestore();
});

describe('applyPostCheckoutCancelPolicy via completeCheckout', () => {
  it('AFTER_TTL with a positive cardTtlMinutes enqueues a delayed cancel job', async () => {
    mockIntent('AFTER_TTL', 60);
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockEnqueueCancelCard).toHaveBeenCalledWith('intent-1', 60 * 60 * 1000);
    expect(mockCancelCard).not.toHaveBeenCalled();
  });

  it.each([
    ['null', null],
    ['zero', 0],
    ['negative', -5],
  ])(
    'AFTER_TTL with %s cardTtlMinutes falls back to IMMEDIATE cancel (no silent no-op)',
    async (_label, ttl) => {
      mockIntent('AFTER_TTL', ttl);
      await completeCheckout('intent-1', 5000);
      await flushAsync();

      // Regression (issue #89, bug 2): the cancel job must not be skipped.
      expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
      expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    },
  );

  it('IMMEDIATE policy cancels card synchronously', async () => {
    mockIntent('IMMEDIATE', null);
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
  });

  it('MANUAL policy freezes card and notifies via telegram module (no UI in orchestrator)', async () => {
    mockIntent('MANUAL', null, { telegramChatId: '98765', subject: 'coffee' });
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockFreezeCard).toHaveBeenCalledWith('intent-1');
    // Regression (issue #89, bug 4): orchestrator must delegate the user
    // notification to the telegram module rather than import grammy directly.
    expect(mockSendManualCardPendingNotice).toHaveBeenCalledWith('98765', 'intent-1', 'coffee');
  });

  it('MANUAL policy without telegramChatId still freezes the card', async () => {
    mockIntent('MANUAL', null, { telegramChatId: null });
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockFreezeCard).toHaveBeenCalledWith('intent-1');
    expect(mockSendManualCardPendingNotice).not.toHaveBeenCalled();
  });

  it('ON_TRANSACTION policy with an existing virtual card defers to Stripe webhook', async () => {
    mockIntent('ON_TRANSACTION', null, { hasVirtualCard: true });
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockCancelCard).not.toHaveBeenCalled();
    expect(mockEnqueueCancelCard).not.toHaveBeenCalled();
  });

  it('ON_TRANSACTION policy without a virtual card cancels as stub fallback', async () => {
    mockIntent('ON_TRANSACTION', null, { hasVirtualCard: false });
    await completeCheckout('intent-1', 5000);
    await flushAsync();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
  });
});
