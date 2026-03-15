jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: jest.fn(),
}));

import { getStripeClient } from '@/payments/providers/stripe/stripeClient';
import { getIssuingBalance } from '@/payments/providers/stripe/balanceService';

const mockStripe = {
  balance: { retrieve: jest.fn() },
};
(getStripeClient as jest.Mock).mockReturnValue(mockStripe);

beforeEach(() => jest.clearAllMocks());

describe('getIssuingBalance', () => {
  it('returns the matching currency balance', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({
      issuing: { available: [{ amount: 50000, currency: 'gbp' }] },
    });

    const result = await getIssuingBalance('gbp');

    expect(result).toEqual({ available: 50000, currency: 'gbp' });
  });

  it('normalises currency to lowercase', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({
      issuing: { available: [{ amount: 12000, currency: 'eur' }] },
    });

    const result = await getIssuingBalance('EUR');

    expect(result).toEqual({ available: 12000, currency: 'eur' });
  });

  it('returns available: 0 when currency is not present', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({
      issuing: { available: [{ amount: 50000, currency: 'gbp' }] },
    });

    const result = await getIssuingBalance('usd');

    expect(result).toEqual({ available: 0, currency: 'usd' });
  });

  it('returns available: 0 when issuing.available is empty', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({
      issuing: { available: [] },
    });

    const result = await getIssuingBalance('gbp');

    expect(result).toEqual({ available: 0, currency: 'gbp' });
  });

  it('returns available: 0 when issuing is undefined', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({});

    const result = await getIssuingBalance('gbp');

    expect(result).toEqual({ available: 0, currency: 'gbp' });
  });

  it('selects the correct entry from multiple currencies', async () => {
    mockStripe.balance.retrieve.mockResolvedValue({
      issuing: {
        available: [
          { amount: 10000, currency: 'usd' },
          { amount: 75000, currency: 'gbp' },
          { amount: 30000, currency: 'eur' },
        ],
      },
    });

    const result = await getIssuingBalance('gbp');

    expect(result).toEqual({ available: 75000, currency: 'gbp' });
  });

  it('propagates Stripe API errors', async () => {
    mockStripe.balance.retrieve.mockRejectedValue(new Error('Stripe down'));

    await expect(getIssuingBalance('gbp')).rejects.toThrow('Stripe down');
  });
});
