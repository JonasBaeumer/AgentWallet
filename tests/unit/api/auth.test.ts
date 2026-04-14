import { workerAuthMiddleware } from '@/api/middleware/auth';

// Mock env
jest.mock('@/config/env', () => ({ env: { WORKER_API_KEY: 'test-worker-key' } }));

describe('workerAuthMiddleware', () => {
  const mockReply = {
    status: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
  };

  beforeEach(() => jest.clearAllMocks());

  it('passes when X-Worker-Key matches', async () => {
    const mockRequest = { headers: { 'x-worker-key': 'test-worker-key' } } as any;
    await workerAuthMiddleware(mockRequest, mockReply as any);
    expect(mockReply.status).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Worker-Key is missing', async () => {
    const mockRequest = { headers: {} } as any;
    await workerAuthMiddleware(mockRequest, mockReply as any);
    expect(mockReply.status).toHaveBeenCalledWith(401);
    expect(mockReply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Unauthorized') }),
    );
  });

  it('returns 401 when X-Worker-Key is wrong', async () => {
    const mockRequest = { headers: { 'x-worker-key': 'wrong-key' } } as any;
    await workerAuthMiddleware(mockRequest, mockReply as any);
    expect(mockReply.status).toHaveBeenCalledWith(401);
  });
});
