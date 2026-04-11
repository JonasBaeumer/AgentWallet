import { getStripeMode } from '@/payments/providers/stripe/stripeClient';

describe('getStripeMode', () => {
  const saved = process.env.STRIPE_SECRET_KEY;

  afterEach(() => {
    process.env.STRIPE_SECRET_KEY = saved;
  });

  it('returns "live" for sk_live_ prefixed keys', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_live_abc123';
    expect(getStripeMode()).toBe('live');
  });

  it('returns "test" for sk_test_ prefixed keys', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_abc123';
    expect(getStripeMode()).toBe('test');
  });

  it('returns "test" when key is not set', () => {
    delete process.env.STRIPE_SECRET_KEY;
    expect(getStripeMode()).toBe('test');
  });

  it('returns "test" for unrecognised key prefixes', () => {
    process.env.STRIPE_SECRET_KEY = 'rk_live_abc123';
    expect(getStripeMode()).toBe('test');
  });
});
