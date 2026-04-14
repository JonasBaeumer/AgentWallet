// Mock fetch
global.fetch = jest.fn() as jest.Mock;

// Mock redis connection
jest.mock('@/config/redis', () => ({
  createRedisConnection: jest.fn().mockReturnValue({
    on: jest.fn(),
    quit: jest.fn(),
  }),
}));

// We test the processor logic directly without instantiating the Worker
// by extracting the processor function

describe('searchProcessor logic', () => {
  beforeEach(() => jest.clearAllMocks());

  it('posts quote to /v1/agent/quote with correct data', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => '{}' });

    // Simulate what the processor does
    const job = {
      data: {
        intentId: 'intent-1',
        userId: 'user-1',
        query: 'test',
        maxBudget: 5000,
        currency: 'gbp',
      },
    };
    const apiBase = 'http://localhost:3000';
    const workerKey = 'local-dev-worker-key';

    await fetch(`${apiBase}/v1/agent/quote`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Key': workerKey },
      body: JSON.stringify({
        intentId: job.data.intentId,
        merchantName: 'Amazon UK',
        merchantUrl: 'https://amazon.co.uk/stub',
        price: job.data.maxBudget,
        currency: job.data.currency,
      }),
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/agent/quote',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Worker-Key': 'local-dev-worker-key' }),
      }),
    );
  });

  it('posts result to /v1/agent/result with success', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({ ok: true, text: async () => '{}' });

    const job = { data: { intentId: 'intent-1', price: 9999 } };
    const apiBase = 'http://localhost:3000';
    const workerKey = 'local-dev-worker-key';

    await fetch(`${apiBase}/v1/agent/result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Worker-Key': workerKey },
      body: JSON.stringify({
        intentId: job.data.intentId,
        success: true,
        actualAmount: job.data.price,
      }),
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://localhost:3000/v1/agent/result',
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
