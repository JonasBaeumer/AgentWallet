/**
 * Unit tests for the userAuth middleware.
 *
 * Uses real bcrypt hashing (not mocked) so we validate the actual compare logic.
 * Only prisma is mocked.
 */

const mockFindUnique = jest.fn();
jest.mock('@/db/client', () => ({
  prisma: {
    user: { findUnique: mockFindUnique },
  },
}));

import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { userAuthMiddleware } from '@/api/middleware/userAuth';

// Helpers to build Fastify-like request/reply doubles
function makeRequest(headers: Record<string, string | undefined> = {}): any {
  return { headers };
}

function makeReply(): any {
  const reply: any = {};
  reply.status = jest.fn().mockReturnValue(reply);
  reply.header = jest.fn().mockReturnValue(reply);
  reply.send = jest.fn().mockReturnValue(reply);
  return reply;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('userAuthMiddleware', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const request = makeRequest({});
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="agentpay"');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Unauthorized') }),
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('returns 401 when header is present but not "Bearer <key>" format', async () => {
    const request = makeRequest({ authorization: 'Basic abc123' });
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="agentpay"');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('Unauthorized') }),
    );
    expect(mockFindUnique).not.toHaveBeenCalled();
  });

  it('returns 401 when no user found for the key prefix', async () => {
    mockFindUnique.mockResolvedValue(null);

    const request = makeRequest({ authorization: 'Bearer some-key-that-is-long-enough' });
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="agentpay"');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('invalid API key') }),
    );
  });

  it('returns 401 when prefix matches but bcrypt.compare fails (wrong key)', async () => {
    const correctKey = 'correct-key-that-is-long-enough-for-prefix';
    const hash = bcrypt.hashSync(correctKey, 10);
    const wrongKey = correctKey.slice(0, 16) + 'different-suffix';
    mockFindUnique.mockResolvedValue({
      id: 'user-1',
      email: 'a@b.com',
      apiKeyHash: hash,
      apiKeyPrefix: correctKey.slice(0, 16),
    });

    const request = makeRequest({ authorization: `Bearer ${wrongKey}` });
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    expect(reply.status).toHaveBeenCalledWith(401);
    expect(reply.header).toHaveBeenCalledWith('WWW-Authenticate', 'Bearer realm="agentpay"');
    expect(reply.send).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining('invalid API key') }),
    );
  });

  it('attaches user to request when valid key is provided', async () => {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const hash = bcrypt.hashSync(rawKey, 10);
    const user = {
      id: 'user-42',
      email: 'alice@agentpay.dev',
      apiKeyHash: hash,
      apiKeyPrefix: rawKey.slice(0, 16),
    };
    mockFindUnique.mockResolvedValue(user);

    const request = makeRequest({ authorization: `Bearer ${rawKey}` });
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    // Should NOT have sent a 401
    expect(reply.status).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();

    // Should have attached the user
    expect(request.user).toEqual(user);
  });

  it('looks up user by apiKeyPrefix via findUnique', async () => {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const hash = bcrypt.hashSync(rawKey, 10);
    const user = {
      id: 'user-1',
      email: 'a@b.com',
      apiKeyHash: hash,
      apiKeyPrefix: rawKey.slice(0, 16),
    };
    mockFindUnique.mockResolvedValue(user);

    const request = makeRequest({ authorization: `Bearer ${rawKey}` });
    const reply = makeReply();

    await userAuthMiddleware(request, reply);

    expect(mockFindUnique).toHaveBeenCalledWith({ where: { apiKeyPrefix: rawKey.slice(0, 16) } });
    expect(request.user).toEqual(user);
  });
});

describe('API key generation contract', () => {
  it('crypto.randomBytes(32).toString("hex") produces a 64-char hex string', () => {
    const rawKey = crypto.randomBytes(32).toString('hex');
    expect(rawKey).toHaveLength(64);
    expect(rawKey).toMatch(/^[0-9a-f]{64}$/);
  });

  it('bcrypt hash of generated key verifies correctly with bcrypt.compare', async () => {
    const rawKey = crypto.randomBytes(32).toString('hex');
    const hash = await bcrypt.hash(rawKey, 10);

    expect(typeof hash).toBe('string');
    expect(hash).not.toBe(rawKey);
    expect(await bcrypt.compare(rawKey, hash)).toBe(true);
    expect(await bcrypt.compare('wrong-key', hash)).toBe(false);
  });
});
