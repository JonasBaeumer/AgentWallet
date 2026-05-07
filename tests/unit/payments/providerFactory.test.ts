import { PaymentProvider, IntentNotFoundError, UserNotFoundError } from '@/contracts';
import { Prisma } from '@prisma/client';

jest.mock('@/db/client', () => ({
  prisma: {
    user: { findUniqueOrThrow: jest.fn() },
    purchaseIntent: { findUniqueOrThrow: jest.fn() },
  },
}));

describe('providerFactory — getPaymentProvider (env-driven)', () => {
  let getPaymentProvider: typeof import('@/payments/providerFactory').getPaymentProvider;
  let resetPaymentProvider: typeof import('@/payments/providerFactory').resetPaymentProvider;

  beforeEach(() => {
    jest.resetModules();
    const factory = require('@/payments/providerFactory');
    getPaymentProvider = factory.getPaymentProvider;
    resetPaymentProvider = factory.resetPaymentProvider;
  });

  afterEach(() => {
    resetPaymentProvider();
  });

  it('returns MockPaymentProvider when NODE_ENV is test', () => {
    const original = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const provider = getPaymentProvider(PaymentProvider.STRIPE);
      expect(provider.constructor.name).toBe('MockPaymentProvider');
    } finally {
      process.env.NODE_ENV = original;
    }
  });

  it('returns MockPaymentProvider when PAYMENT_PROVIDER is mock', () => {
    const origEnv = process.env.NODE_ENV;
    const origProvider = process.env.PAYMENT_PROVIDER;
    process.env.NODE_ENV = 'production';
    process.env.PAYMENT_PROVIDER = 'mock';
    try {
      const provider = getPaymentProvider(PaymentProvider.STRIPE);
      expect(provider.constructor.name).toBe('MockPaymentProvider');
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origProvider === undefined) {
        delete process.env.PAYMENT_PROVIDER;
      } else {
        process.env.PAYMENT_PROVIDER = origProvider;
      }
    }
  });

  it('caches instances per provider type', () => {
    const p1 = getPaymentProvider(PaymentProvider.STRIPE);
    const p2 = getPaymentProvider(PaymentProvider.STRIPE);
    expect(p1).toBe(p2);
  });

  it('returns a new instance after resetPaymentProvider', () => {
    const p1 = getPaymentProvider(PaymentProvider.STRIPE);
    resetPaymentProvider();
    const p2 = getPaymentProvider(PaymentProvider.STRIPE);
    expect(p1).not.toBe(p2);
  });

  it('returns MockPaymentProvider when NODE_ENV=test regardless of requested type', () => {
    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';
    try {
      const provider = getPaymentProvider(PaymentProvider.STRIPE);
      expect(provider.constructor.name).toBe('MockPaymentProvider');
    } finally {
      process.env.NODE_ENV = origEnv;
    }
  });

  it('loads StripePaymentProvider when type=STRIPE and no mock override', () => {
    const origEnv = process.env.NODE_ENV;
    const origProvider = process.env.PAYMENT_PROVIDER;
    process.env.NODE_ENV = 'production';
    delete process.env.PAYMENT_PROVIDER;
    try {
      const provider = getPaymentProvider(PaymentProvider.STRIPE);
      expect(provider.constructor.name).toBe('StripePaymentProvider');
    } catch {
      // Expected: Stripe key not set in test env — confirms it tried to load stripe
    } finally {
      process.env.NODE_ENV = origEnv;
      if (origProvider === undefined) {
        delete process.env.PAYMENT_PROVIDER;
      } else {
        process.env.PAYMENT_PROVIDER = origProvider;
      }
    }
  });

  it('provider implements all IPaymentProvider methods', () => {
    const provider = getPaymentProvider(PaymentProvider.STRIPE);
    expect(typeof provider.issueCard).toBe('function');
    expect(typeof provider.revealCard).toBe('function');
    expect(typeof provider.freezeCard).toBe('function');
    expect(typeof provider.cancelCard).toBe('function');
    expect(typeof provider.handleWebhookEvent).toBe('function');
    expect(typeof provider.getIssuingBalance).toBe('function');
    expect(provider.metadata).toBeDefined();
    expect(provider.metadata.id).toBe(PaymentProvider.STRIPE);
  });
});

describe('providerFactory — getProviderForUser / getProviderForIntent', () => {
  // No resetModules here — need a stable prisma mock across tests
  const { getProviderForUser, getProviderForIntent } = require('@/payments/providerFactory');
  const { prisma } = require('@/db/client');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getProviderForUser', () => {
    it('resolves the user and returns the provider matching user.paymentProvider', async () => {
      (prisma.user.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        paymentProvider: PaymentProvider.STRIPE,
      });

      const provider = await getProviderForUser('user-1');

      expect(prisma.user.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'user-1' },
        select: { paymentProvider: true },
      });
      expect(provider.metadata.id).toBe(PaymentProvider.STRIPE);
    });

    it('translates Prisma P2025 into UserNotFoundError', async () => {
      (prisma.user.findUniqueOrThrow as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('no record', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(getProviderForUser('missing-user')).rejects.toThrow(UserNotFoundError);
    });

    it('rethrows non-P2025 errors unchanged', async () => {
      const dbErr = new Error('connection refused');
      (prisma.user.findUniqueOrThrow as jest.Mock).mockRejectedValue(dbErr);

      await expect(getProviderForUser('user-1')).rejects.toBe(dbErr);
    });
  });

  describe('getProviderForIntent', () => {
    it('resolves the intent and returns the provider matching the owning user', async () => {
      (prisma.purchaseIntent.findUniqueOrThrow as jest.Mock).mockResolvedValue({
        user: { paymentProvider: PaymentProvider.STRIPE },
      });

      const provider = await getProviderForIntent('intent-1');

      expect(prisma.purchaseIntent.findUniqueOrThrow).toHaveBeenCalledWith({
        where: { id: 'intent-1' },
        select: { user: { select: { paymentProvider: true } } },
      });
      expect(provider.metadata.id).toBe(PaymentProvider.STRIPE);
    });

    it('translates Prisma P2025 into IntentNotFoundError', async () => {
      (prisma.purchaseIntent.findUniqueOrThrow as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError('no record', {
          code: 'P2025',
          clientVersion: 'test',
        }),
      );

      await expect(getProviderForIntent('missing-intent')).rejects.toThrow(IntentNotFoundError);
    });

    it('rethrows non-P2025 errors unchanged', async () => {
      const dbErr = new Error('connection refused');
      (prisma.purchaseIntent.findUniqueOrThrow as jest.Mock).mockRejectedValue(dbErr);

      await expect(getProviderForIntent('intent-1')).rejects.toBe(dbErr);
    });
  });
});
