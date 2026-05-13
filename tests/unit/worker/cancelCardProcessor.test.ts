/**
 * Unit tests for the AFTER_TTL cancel card job handler.
 *
 * Regression tests for issue #89 bug 3: the processor previously had no
 * try/catch, no logging, and no mechanism to stop retrying unrecoverable
 * errors. A Stripe or DB failure would bubble silently while a
 * dead-intent error would exhaust all retries.
 */

const mockCancelCard = jest.fn();
jest.mock('@/payments', () => ({
  getProviderForIntent: jest.fn().mockResolvedValue({ cancelCard: mockCancelCard }),
}));

// handleCancelCardJob imports IntentNotFoundError from @/contracts; no mock
// needed — we use the real class.
import { UnrecoverableError } from 'bullmq';
import type { Job } from 'bullmq';
import { IntentNotFoundError } from '@/contracts';
import { handleCancelCardJob } from '@/worker/processors/cancelCardProcessor';

function fakeJob(intentId: string, attemptsMade = 0): Job<{ intentId: string }> {
  return { data: { intentId }, attemptsMade } as unknown as Job<{ intentId: string }>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('handleCancelCardJob', () => {
  it('calls payment provider cancelCard on happy path', async () => {
    mockCancelCard.mockResolvedValue(undefined);

    await expect(handleCancelCardJob(fakeJob('intent-1'))).resolves.toBeUndefined();

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
  });

  it('rethrows transient errors so BullMQ retries them', async () => {
    const stripeError = new Error('Stripe 503 service unavailable');
    mockCancelCard.mockRejectedValue(stripeError);

    await expect(handleCancelCardJob(fakeJob('intent-1', 0))).rejects.toThrow(stripeError);
  });

  it('wraps IntentNotFoundError in UnrecoverableError to stop retries', async () => {
    mockCancelCard.mockRejectedValue(new IntentNotFoundError('intent-42'));

    await expect(handleCancelCardJob(fakeJob('intent-42'))).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
  });
});
