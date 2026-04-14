// Mock Stripe client
const mockAuthCreate = jest.fn();
const mockAuthCapture = jest.fn();
const mockStripe = {
  testHelpers: {
    issuing: {
      authorizations: {
        create: mockAuthCreate,
        capture: mockAuthCapture,
      },
    },
  },
};
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => mockStripe,
}));

// Mock Prisma
const mockFindUniqueCard = jest.fn();
jest.mock('@/db/client', () => ({
  prisma: {
    virtualCard: {
      findUnique: mockFindUniqueCard,
    },
  },
}));

import { runSimulatedCheckout } from '@/payments/providers/stripe/checkoutSimulator';
import { IntentNotFoundError } from '@/contracts';

const CARD_ID = 'ic_test123';
const validParams = {
  intentId: 'intent-abc',
  amount: 5000,
  currency: 'eur',
  merchantName: 'Amazon DE',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockFindUniqueCard.mockResolvedValue({
    intentId: validParams.intentId,
    stripeCardId: CARD_ID,
    last4: '4242',
  });
});

describe('runSimulatedCheckout — success path', () => {
  it('returns success=true with chargeId, amount, currency', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_test456', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_test456', status: 'closed' });

    const result = await runSimulatedCheckout(validParams);

    expect(result.success).toBe(true);
    expect(result.chargeId).toBe('iauth_test456');
    expect(result.amount).toBe(5000);
    expect(result.currency).toBe('eur');
  });

  it('looks up stripeCardId from DB and passes it to the authorization', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_lookup', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_lookup', status: 'closed' });

    await runSimulatedCheckout(validParams);

    expect(mockFindUniqueCard).toHaveBeenCalledWith({ where: { intentId: validParams.intentId } });
    expect(mockAuthCreate).toHaveBeenCalledWith(expect.objectContaining({ card: CARD_ID }));
  });

  it('creates authorization with the provided amount and currency', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_amt', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_amt', status: 'closed' });

    await runSimulatedCheckout({ ...validParams, amount: 99999 });

    expect(mockAuthCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 99999, currency: 'eur' }),
    );
  });

  it('captures the authorization after it is approved', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_cap', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_cap', status: 'closed' });

    await runSimulatedCheckout(validParams);

    expect(mockAuthCapture).toHaveBeenCalledWith('iauth_cap');
  });

  it('passes merchantName to authorization merchant_data', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_merchant', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_merchant', status: 'closed' });

    await runSimulatedCheckout({ ...validParams, merchantName: 'Test Merchant' });

    expect(mockAuthCreate).toHaveBeenCalledWith(
      expect.objectContaining({ merchant_data: { name: 'Test Merchant' } }),
    );
  });

  it('defaults currency to eur (schema default applied upstream)', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_eur', approved: true, request_history: [] });
    mockAuthCapture.mockResolvedValue({ id: 'iauth_eur', status: 'closed' });

    const result = await runSimulatedCheckout({ ...validParams, currency: 'eur' });

    expect(mockAuthCreate).toHaveBeenCalledWith(expect.objectContaining({ currency: 'eur' }));
    expect(result.currency).toBe('eur');
  });
});

describe('runSimulatedCheckout — card declined', () => {
  it('returns success=false when authorization is not approved', async () => {
    mockAuthCreate.mockResolvedValue({
      id: 'iauth_declined',
      approved: false,
      request_history: [{ reason: 'spending_controls' }],
    });

    const result = await runSimulatedCheckout(validParams);

    expect(result.success).toBe(false);
    expect(result.declineCode).toBe('spending_controls');
    expect(result.message).toBe('Card declined');
    expect(mockAuthCapture).not.toHaveBeenCalled();
  });

  it('uses card_declined as fallback when request_history is empty', async () => {
    mockAuthCreate.mockResolvedValue({
      id: 'iauth_fallback',
      approved: false,
      request_history: [],
    });

    const result = await runSimulatedCheckout(validParams);

    expect(result.success).toBe(false);
    expect(result.declineCode).toBe('card_declined');
  });

  it('does not call capture when authorization is declined', async () => {
    mockAuthCreate.mockResolvedValue({ id: 'iauth_no_cap', approved: false, request_history: [] });

    await runSimulatedCheckout(validParams);

    expect(mockAuthCapture).not.toHaveBeenCalled();
  });
});

describe('runSimulatedCheckout — error cases', () => {
  it('throws IntentNotFoundError when virtualCard is not found', async () => {
    mockFindUniqueCard.mockResolvedValue(null);

    await expect(runSimulatedCheckout(validParams)).rejects.toThrow(IntentNotFoundError);
  });

  it('rethrows Stripe errors from authorization create', async () => {
    mockAuthCreate.mockRejectedValue(new Error('Stripe connection error'));

    await expect(runSimulatedCheckout(validParams)).rejects.toThrow('Stripe connection error');
  });

  it('rethrows Stripe errors from authorization capture', async () => {
    mockAuthCreate.mockResolvedValue({
      id: 'iauth_capture_err',
      approved: true,
      request_history: [],
    });
    mockAuthCapture.mockRejectedValue(new Error('Capture failed'));

    await expect(runSimulatedCheckout(validParams)).rejects.toThrow('Capture failed');
  });
});
