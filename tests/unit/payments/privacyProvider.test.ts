// Mock the Privacy HTTP client + DB before importing the provider.
const mockCreateCard = jest.fn();
const mockUpdateCard = jest.fn();
jest.mock('@/payments/providers/privacy/privacyClient', () => {
  const actual = jest.requireActual('@/payments/providers/privacy/privacyClient');
  return {
    ...actual,
    createCard: mockCreateCard,
    updateCard: mockUpdateCard,
  };
});

jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: { findUnique: jest.fn() },
    virtualCard: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  },
}));

import { PrivacyComPaymentProvider } from '@/payments/providers/privacy';
import { clearAll as clearRevealCache } from '@/payments/providers/privacy/revealCache';
import { PrivacyApiError } from '@/payments/providers/privacy/privacyClient';
import { prisma } from '@/db/client';
import {
  CardAlreadyRevealedError,
  IntentNotFoundError,
  PaymentProvider,
  UnsupportedProviderOperationError,
} from '@/contracts';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe('PrivacyComPaymentProvider', () => {
  let provider: PrivacyComPaymentProvider;

  beforeEach(() => {
    provider = new PrivacyComPaymentProvider();
    jest.clearAllMocks();
    clearRevealCache();
  });

  describe('metadata', () => {
    it('declares fire-and-forget model, auto-close, no freeze, USD', () => {
      expect(provider.metadata).toEqual({
        id: PaymentProvider.PRIVACY_COM,
        displayName: 'Privacy.com',
        currency: 'usd',
        authorizationModel: 'fire_and_forget',
        autoCancelAfterUse: true,
        supportsFreeze: false,
      });
    });
  });

  describe('issueCard', () => {
    it('creates a SINGLE_USE card with spend_limit_duration TRANSACTION', async () => {
      (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
        id: 'intent-1',
        query: 'headphones',
        subject: null,
      });
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);
      mockCreateCard.mockResolvedValue({
        token: 'priv_card_abc',
        last_four: '1234',
        pan: '4111111111111234',
        cvv: '999',
        exp_month: '12',
        exp_year: '2030',
        type: 'SINGLE_USE',
        spend_limit: 10000,
        spend_limit_duration: 'TRANSACTION',
        state: 'OPEN',
        created: '2026-04-18T00:00:00Z',
      });
      (mockPrisma.virtualCard.create as jest.Mock).mockResolvedValue({
        id: 'vc-1',
        intentId: 'intent-1',
        providerCardId: 'priv_card_abc',
        last4: '1234',
      });

      const result = await provider.issueCard('intent-1', 10000);

      expect(mockCreateCard).toHaveBeenCalledWith({
        type: 'SINGLE_USE',
        memo: 'headphones',
        spend_limit: 10000,
        spend_limit_duration: 'TRANSACTION',
        state: 'OPEN',
      });
      expect(result.providerCardId).toBe('priv_card_abc');
      expect(result.last4).toBe('1234');
    });

    it('never stores PAN or CVV in the DB', async () => {
      (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
        id: 'intent-1',
        query: 'x',
        subject: null,
      });
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);
      mockCreateCard.mockResolvedValue({
        token: 't',
        last_four: '5678',
        pan: '4111111111115678',
        cvv: '123',
        exp_month: '06',
        exp_year: '2031',
        type: 'SINGLE_USE',
        spend_limit: 5000,
        spend_limit_duration: 'TRANSACTION',
        state: 'OPEN',
        created: '',
      });
      (mockPrisma.virtualCard.create as jest.Mock).mockResolvedValue({});

      await provider.issueCard('intent-1', 5000);

      const createArgs = (mockPrisma.virtualCard.create as jest.Mock).mock.calls[0][0];
      expect(createArgs.data).not.toHaveProperty('pan');
      expect(createArgs.data).not.toHaveProperty('cvv');
      expect(createArgs.data).not.toHaveProperty('number');
      expect(createArgs.data).not.toHaveProperty('cvc');
    });

    it('dedupes: returns the existing VirtualCard instead of re-issuing', async () => {
      const existing = {
        id: 'vc-existing',
        intentId: 'intent-1',
        providerCardId: 'priv_existing',
        last4: '0000',
      };
      (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({ id: 'intent-1' });
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(existing);

      const result = await provider.issueCard('intent-1', 5000);

      expect(mockCreateCard).not.toHaveBeenCalled();
      expect(result).toBe(existing);
    });

    it('throws IntentNotFoundError for missing intent', async () => {
      (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(provider.issueCard('missing', 5000)).rejects.toThrow(IntentNotFoundError);
    });
  });

  describe('revealCard', () => {
    it('returns PAN/CVV cached at issuance and purges the entry', async () => {
      // First, issue to populate the cache
      (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
        id: 'intent-r',
        query: 'x',
        subject: null,
      });
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValueOnce(null);
      mockCreateCard.mockResolvedValue({
        token: 'tok',
        last_four: '9999',
        pan: '4111111111119999',
        cvv: '321',
        exp_month: '01',
        exp_year: '2029',
        type: 'SINGLE_USE',
        spend_limit: 1000,
        spend_limit_duration: 'TRANSACTION',
        state: 'OPEN',
        created: '',
      });
      (mockPrisma.virtualCard.create as jest.Mock).mockResolvedValue({});
      await provider.issueCard('intent-r', 1000);

      // Now reveal
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValueOnce({
        intentId: 'intent-r',
        providerCardId: 'tok',
        revealedAt: null,
      });
      (mockPrisma.virtualCard.update as jest.Mock).mockResolvedValue({});

      const reveal = await provider.revealCard('intent-r');

      expect(reveal).toEqual({
        number: '4111111111119999',
        cvc: '321',
        expMonth: 1,
        expYear: 2029,
        last4: '9999',
      });

      // Second reveal should miss the cache and throw
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValueOnce({
        intentId: 'intent-r',
        providerCardId: 'tok',
        revealedAt: null, // pretend DB hasn't recorded revealedAt yet to isolate cache behavior
      });
      await expect(provider.revealCard('intent-r')).rejects.toThrow(/cache miss/);
    });

    it('throws CardAlreadyRevealedError when the DB row has revealedAt set', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({
        intentId: 'i',
        providerCardId: 't',
        revealedAt: new Date(),
      });

      await expect(provider.revealCard('i')).rejects.toThrow(CardAlreadyRevealedError);
    });

    it('throws IntentNotFoundError when the card is missing', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(provider.revealCard('missing')).rejects.toThrow(IntentNotFoundError);
    });
  });

  describe('freezeCard', () => {
    it('throws UnsupportedProviderOperationError', async () => {
      await expect(provider.freezeCard('intent-1')).rejects.toThrow(
        UnsupportedProviderOperationError,
      );
    });
  });

  describe('cancelCard', () => {
    it('PATCHes the card to CLOSED and records cancelledAt', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({
        intentId: 'intent-c',
        providerCardId: 'tok',
        cancelledAt: null,
      });
      mockUpdateCard.mockResolvedValue({ token: 'tok', state: 'CLOSED' });
      (mockPrisma.virtualCard.update as jest.Mock).mockResolvedValue({});

      await provider.cancelCard('intent-c');

      expect(mockUpdateCard).toHaveBeenCalledWith('tok', { state: 'CLOSED' });
      expect(mockPrisma.virtualCard.update).toHaveBeenCalledWith({
        where: { intentId: 'intent-c' },
        data: expect.objectContaining({ cancelledAt: expect.any(Date) }),
      });
    });

    it('swallows PrivacyApiError (already closed) but still records cancelledAt', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({
        intentId: 'intent-c',
        providerCardId: 'tok',
        cancelledAt: null,
      });
      mockUpdateCard.mockRejectedValue(new PrivacyApiError(400, 'already closed'));
      (mockPrisma.virtualCard.update as jest.Mock).mockResolvedValue({});

      await expect(provider.cancelCard('intent-c')).resolves.toBeUndefined();
      expect(mockPrisma.virtualCard.update).toHaveBeenCalled();
    });

    it('returns early when already cancelled in our DB', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({
        intentId: 'intent-c',
        providerCardId: 'tok',
        cancelledAt: new Date(),
      });

      await provider.cancelCard('intent-c');

      expect(mockUpdateCard).not.toHaveBeenCalled();
    });

    it('rethrows non-PrivacyApiError failures', async () => {
      (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({
        intentId: 'intent-c',
        providerCardId: 'tok',
        cancelledAt: null,
      });
      const boom = new Error('network blown');
      mockUpdateCard.mockRejectedValue(boom);

      await expect(provider.cancelCard('intent-c')).rejects.toBe(boom);
    });
  });

  describe('getIssuingBalance', () => {
    it('returns a sentinel high balance in USD (no issuing-balance concept)', async () => {
      const balance = await provider.getIssuingBalance();
      expect(balance.currency).toBe('usd');
      expect(balance.available).toBe(Number.MAX_SAFE_INTEGER);
    });
  });
});
