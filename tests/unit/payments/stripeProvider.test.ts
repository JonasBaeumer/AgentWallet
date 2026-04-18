/**
 * Pins that StripePaymentProvider forwards metadata.currency (not a caller-supplied
 * currency) to the underlying cardService. Guards against the divergence bug where
 * the provider could silently issue cards in a currency that doesn't match the
 * ledger's intent.currency.
 */
const mockIssueVirtualCard = jest.fn();
const mockFetchIssuingBalance = jest.fn();
jest.mock('@/payments/providers/stripe/cardService', () => ({
  issueVirtualCard: mockIssueVirtualCard,
  revealCard: jest.fn(),
  freezeCard: jest.fn(),
  cancelCard: jest.fn(),
}));
jest.mock('@/payments/providers/stripe/balanceService', () => ({
  getIssuingBalance: mockFetchIssuingBalance,
}));
jest.mock('@/payments/providers/stripe/webhookHandler', () => ({
  handleStripeEvent: jest.fn(),
}));

import { StripePaymentProvider } from '@/payments/providers/stripe';
import { PaymentProvider } from '@/contracts';

describe('StripePaymentProvider', () => {
  let provider: StripePaymentProvider;

  beforeEach(() => {
    provider = new StripePaymentProvider();
    jest.clearAllMocks();
  });

  describe('metadata', () => {
    it('exposes Stripe provider metadata with EUR currency + per-transaction auth', () => {
      expect(provider.metadata).toMatchObject({
        id: PaymentProvider.STRIPE,
        currency: 'eur',
        authorizationModel: 'per_transaction',
        autoCancelAfterUse: false,
        supportsFreeze: true,
      });
    });
  });

  describe('issueCard', () => {
    it('forwards metadata.currency to cardService (not a caller-supplied value)', async () => {
      mockIssueVirtualCard.mockResolvedValue({
        id: 'vc-1',
        intentId: 'intent-1',
        providerCardId: 'ic_test',
        last4: '4242',
      });

      await provider.issueCard('intent-1', 5000, { mccAllowlist: ['5411'] });

      expect(mockIssueVirtualCard).toHaveBeenCalledWith('intent-1', 5000, 'eur', {
        mccAllowlist: ['5411'],
      });
    });
  });

  describe('getIssuingBalance', () => {
    it('forwards metadata.currency to balanceService', async () => {
      mockFetchIssuingBalance.mockResolvedValue({ available: 1000, currency: 'eur' });

      await provider.getIssuingBalance();

      expect(mockFetchIssuingBalance).toHaveBeenCalledWith('eur');
    });
  });
});
