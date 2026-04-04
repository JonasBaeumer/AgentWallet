// Mock prisma
jest.mock('@/db/client', () => ({
  prisma: {
    idempotencyRecord: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  },
}));

import { idempotencyMiddleware } from '@/api/middleware/idempotency';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe('idempotencyMiddleware', () => {
  const mockReply = { status: jest.fn().mockReturnThis(), send: jest.fn().mockReturnThis() };

  beforeEach(() => jest.clearAllMocks());

  it('replays stored response when key exists', async () => {
    const storedResponse = { intentId: 'i-1', status: 'RECEIVED' };
    (mockPrisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce({
      key: 'key-1',
      responseBody: storedResponse,
    });

    const mockRequest = { headers: { 'x-idempotency-key': 'key-1' } } as any;
    await idempotencyMiddleware(mockRequest, mockReply as any);

    expect(mockReply.status).toHaveBeenCalledWith(200);
    expect(mockReply.send).toHaveBeenCalledWith(storedResponse);
  });

  it('passes through when key is new', async () => {
    (mockPrisma.idempotencyRecord.findUnique as jest.Mock).mockResolvedValueOnce(null);

    const mockRequest = { headers: { 'x-idempotency-key': 'new-key' } } as any;
    await idempotencyMiddleware(mockRequest, mockReply as any);

    expect(mockReply.status).not.toHaveBeenCalled();
    expect((mockRequest as any).idempotencyKey).toBe('new-key');
  });

  it('skips when no idempotency key header', async () => {
    const mockRequest = { headers: {} } as any;
    await idempotencyMiddleware(mockRequest, mockReply as any);

    expect(mockPrisma.idempotencyRecord.findUnique).not.toHaveBeenCalled();
  });
});
