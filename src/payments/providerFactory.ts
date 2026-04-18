import { env } from '@/config/env';
import { IPaymentProvider, PaymentProvider } from '@/contracts';

const MOCK_KEY = '__mock__';
const instances = new Map<string, IPaymentProvider>();

function useMockProvider(): boolean {
  return env.NODE_ENV === 'test' || env.PAYMENT_PROVIDER === 'mock';
}

export function getPaymentProvider(providerType: PaymentProvider): IPaymentProvider {
  const cacheKey = useMockProvider() ? MOCK_KEY : providerType;
  const cached = instances.get(cacheKey);
  if (cached) return cached;

  let instance: IPaymentProvider;
  if (useMockProvider()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MockPaymentProvider } = require('./providers/mock/mockProvider');
    instance = new MockPaymentProvider();
  } else {
    switch (providerType) {
      case PaymentProvider.STRIPE: {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { StripePaymentProvider } = require('./providers/stripe');
        instance = new StripePaymentProvider();
        break;
      }
      default:
        throw new Error(`Unsupported payment provider: ${providerType}`);
    }
  }

  instances.set(cacheKey, instance);
  return instance;
}

export function resetPaymentProvider(): void {
  instances.clear();
}

/** Look up the user's paymentProvider and return its provider instance. */
export async function getProviderForUser(userId: string): Promise<IPaymentProvider> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('@/db/client');
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { paymentProvider: true },
  });
  return getPaymentProvider(user.paymentProvider);
}

/** Look up the intent's user and return its provider instance. */
export async function getProviderForIntent(intentId: string): Promise<IPaymentProvider> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { prisma } = require('@/db/client');
  const intent = await prisma.purchaseIntent.findUniqueOrThrow({
    where: { id: intentId },
    select: { user: { select: { paymentProvider: true } } },
  });
  return getPaymentProvider(intent.user.paymentProvider);
}
