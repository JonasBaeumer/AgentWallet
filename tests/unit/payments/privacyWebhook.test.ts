import crypto from 'crypto';

jest.mock('@/config/env', () => ({
  env: {
    PRIVACY_WEBHOOK_SECRET: 'test_secret',
    PRIVACY_WEBHOOK_SIGNATURE_HEADER: 'x-privacy-signature',
  },
}));

jest.mock('@/db/client', () => ({
  prisma: {
    virtualCard: { findUnique: jest.fn() },
    auditEvent: { create: jest.fn() },
  },
}));

import { handlePrivacyEvent } from '@/payments/providers/privacy/webhookHandler';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function sign(body: string, secret = 'test_secret'): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

describe('handlePrivacyEvent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('rejects invalid signature', async () => {
    const body = JSON.stringify({ card_token: 'tok', amount: 100 });

    await expect(handlePrivacyEvent(body, 'not-the-right-sig')).rejects.toThrow(
      /signature verification failed/,
    );
  });

  it('accepts a valid HMAC-SHA256 signature and logs an audit event', async () => {
    const body = JSON.stringify({ card_token: 'tok-1', amount: 500, result: 'APPROVED' });
    const sig = sign(body);
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({ intentId: 'intent-1' });
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

    const res = await handlePrivacyEvent(body, sig);

    expect(res).toEqual({ received: true });
    expect(mockPrisma.virtualCard.findUnique).toHaveBeenCalledWith({
      where: { providerCardId: 'tok-1' },
      select: { intentId: true },
    });
    expect(mockPrisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          intentId: 'intent-1',
          actor: 'privacy_com',
          event: 'PRIVACY_TRANSACTION',
        }),
      }),
    );
  });

  it('returns {received: true} but skips correlation when card_token is missing', async () => {
    const body = JSON.stringify({ amount: 500 });
    const sig = sign(body);

    const res = await handlePrivacyEvent(body, sig);

    expect(res).toEqual({ received: true });
    expect(mockPrisma.virtualCard.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.auditEvent.create).not.toHaveBeenCalled();
  });

  it('returns {received: true} when the card_token has no matching VirtualCard', async () => {
    const body = JSON.stringify({ card_token: 'unknown', amount: 500 });
    const sig = sign(body);
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);

    const res = await handlePrivacyEvent(body, sig);

    expect(res).toEqual({ received: true });
    expect(mockPrisma.auditEvent.create).not.toHaveBeenCalled();
  });
});
