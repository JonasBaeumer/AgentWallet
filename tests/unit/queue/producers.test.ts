// Mock BullMQ Queue
const mockSearchQueueAdd = jest.fn().mockResolvedValue({ id: 'job-1' });
const mockCheckoutQueueAdd = jest.fn().mockResolvedValue({ id: 'job-2' });

jest.mock('@/queue/queues', () => ({
  searchQueue: { add: mockSearchQueueAdd },
  checkoutQueue: { add: mockCheckoutQueueAdd },
}));

import { enqueueSearch, enqueueCheckout } from '@/queue/producers';
import { SearchIntentJob, CheckoutIntentJob } from '@/contracts';

beforeEach(() => jest.clearAllMocks());

describe('enqueueSearch', () => {
  it('calls searchQueue.add with intentId as jobId', async () => {
    const payload: SearchIntentJob = {
      intentId: 'intent-1',
      userId: 'user-1',
      query: 'buy headphones',
      maxBudget: 10000,
      currency: 'gbp',
    };

    await enqueueSearch('intent-1', payload);

    expect(mockSearchQueueAdd).toHaveBeenCalledWith(
      'SEARCH_INTENT',
      payload,
      expect.objectContaining({ jobId: 'intent-1' }),
    );
  });
});

describe('enqueueCheckout', () => {
  it('calls checkoutQueue.add with intentId as jobId', async () => {
    const payload: CheckoutIntentJob = {
      intentId: 'intent-1',
      userId: 'user-1',
      merchantName: 'Amazon UK',
      merchantUrl: 'https://amazon.co.uk',
      price: 9999,
      currency: 'gbp',
      providerCardId: 'ic_123',
      last4: '4242',
    };

    await enqueueCheckout('intent-1', payload);

    expect(mockCheckoutQueueAdd).toHaveBeenCalledWith(
      'CHECKOUT_INTENT',
      payload,
      expect.objectContaining({ jobId: 'intent-1' }),
    );
  });
});
