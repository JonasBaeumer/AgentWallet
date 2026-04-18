import Stripe from 'stripe';

const mockCardsList = jest.fn();
const mockBalanceRetrieve = jest.fn();

jest.mock('stripe', () => {
  const actual = jest.requireActual('stripe');
  const MockStripe = jest.fn().mockImplementation(() => ({
    issuing: { cards: { list: mockCardsList } },
    balance: { retrieve: mockBalanceRetrieve },
  }));
  MockStripe.errors = actual.default?.errors ?? actual.errors;
  return { __esModule: true, default: MockStripe, ...MockStripe };
});

const mockWarn = jest.fn();
const mockInfo = jest.fn();

jest.mock('@/config/logger', () => ({
  logger: {
    child: jest.fn().mockReturnValue({
      warn: mockWarn,
      info: mockInfo,
      error: jest.fn(),
    }),
  },
}));

import { validateStripeSetup } from '@/payments/providers/stripe/validateStripe';

beforeEach(() => {
  jest.clearAllMocks();
});

// ─── Missing / placeholder key ──────────────────────────────────────────────

describe('missing or placeholder key', () => {
  it('warns and returns when STRIPE_SECRET_KEY is not set', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    await validateStripeSetup();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('not configured');
    expect(mockCardsList).not.toHaveBeenCalled();
    process.env.STRIPE_SECRET_KEY = saved;
  });

  it('warns and returns when key is the placeholder', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
    await validateStripeSetup();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('not configured');
    expect(mockCardsList).not.toHaveBeenCalled();
    process.env.STRIPE_SECRET_KEY = saved;
  });

  it('does not throw', async () => {
    const saved = process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_SECRET_KEY;
    await expect(validateStripeSetup()).resolves.toBeUndefined();
    process.env.STRIPE_SECRET_KEY = saved;
  });
});

// ─── Valid key, Issuing enabled ─────────────────────────────────────────────

describe('valid key with Issuing enabled', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_real_key';
    mockCardsList.mockResolvedValue({ data: [] });
    mockBalanceRetrieve.mockResolvedValue({
      issuing: { available: [{ amount: 50000, currency: 'eur' }] },
    });
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  });

  it('logs success with test mode', async () => {
    await validateStripeSetup();
    expect(mockInfo).toHaveBeenCalledWith(
      expect.stringContaining('Stripe Issuing is enabled (mode: test)'),
    );
  });

  it('logs the Issuing balance', async () => {
    await validateStripeSetup();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('50000 eur'));
  });

  it('logs live mode for live keys', async () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_real_key';
    await validateStripeSetup();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('mode: live'));
  });

  it('does not warn', async () => {
    await validateStripeSetup();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('handles balance retrieval failure gracefully', async () => {
    mockBalanceRetrieve.mockRejectedValue(new Error('network'));
    await expect(validateStripeSetup()).resolves.toBeUndefined();
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('Stripe Issuing is enabled'));
  });
});

// ─── Invalid key (auth error) ───────────────────────────────────────────────

describe('invalid key', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_bad_key';
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  });

  it('warns about invalid key on StripeAuthenticationError', async () => {
    const err = new Stripe.errors.StripeAuthenticationError({
      message: 'Invalid API Key',
      type: 'invalid_request_error',
    });
    mockCardsList.mockRejectedValue(err);
    await validateStripeSetup();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('invalid');
  });

  it('does not throw', async () => {
    const err = new Stripe.errors.StripeAuthenticationError({
      message: 'Invalid API Key',
      type: 'invalid_request_error',
    });
    mockCardsList.mockRejectedValue(err);
    await expect(validateStripeSetup()).resolves.toBeUndefined();
  });
});

// ─── Issuing not enabled (permission error) ─────────────────────────────────

describe('Issuing not enabled', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_no_issuing';
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  });

  it('warns about Issuing not enabled on StripePermissionError', async () => {
    const err = new Stripe.errors.StripePermissionError({
      message: 'Not permitted',
      type: 'invalid_request_error',
    });
    mockCardsList.mockRejectedValue(err);
    await validateStripeSetup();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('not enabled');
    expect(mockWarn.mock.calls[0][0]).toContain('stripe.com/issuing');
  });

  it('does not throw', async () => {
    const err = new Stripe.errors.StripePermissionError({
      message: 'Not permitted',
      type: 'invalid_request_error',
    });
    mockCardsList.mockRejectedValue(err);
    await expect(validateStripeSetup()).resolves.toBeUndefined();
  });
});

// ─── Unexpected errors ──────────────────────────────────────────────────────

describe('unexpected errors', () => {
  beforeEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_other';
  });

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_placeholder';
  });

  it('warns with the error message for non-Stripe errors', async () => {
    mockCardsList.mockRejectedValue(new Error('network timeout'));
    await validateStripeSetup();
    expect(mockWarn).toHaveBeenCalledTimes(1);
    expect(mockWarn.mock.calls[0][0]).toContain('network timeout');
  });

  it('never throws regardless of error type', async () => {
    mockCardsList.mockRejectedValue(new Error('anything'));
    await expect(validateStripeSetup()).resolves.toBeUndefined();
  });
});
