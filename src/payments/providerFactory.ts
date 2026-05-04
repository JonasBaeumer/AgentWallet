import { Prisma } from '@prisma/client';
import { env } from '@/config/env';
import { prisma } from '@/db/client';
import {
  IPaymentProvider,
  IntentNotFoundError,
  PaymentProvider,
  UserNotFoundError,
} from '@/contracts';

const MOCK_PREFIX = '__mock__:';
const instances = new Map<string, IPaymentProvider>();

function useMockProvider(): boolean {
  return env.NODE_ENV === 'test' || env.PAYMENT_PROVIDER === 'mock';
}

export function getPaymentProvider(providerType: PaymentProvider): IPaymentProvider {
  // Mock instances are cached per-providerType so callers branching on
  // provider.metadata see the id they asked for, not whichever provider
  // happened to be requested first.
  const cacheKey = useMockProvider() ? `${MOCK_PREFIX}${providerType}` : providerType;
  const cached = instances.get(cacheKey);
  if (cached) return cached;

  let instance: IPaymentProvider;
  if (useMockProvider()) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MockPaymentProvider } = require('./providers/mock/mockProvider');
    instance = new MockPaymentProvider(providerType);
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

function isMissingRecord(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025';
}

/** Look up the user's paymentProvider and return its provider instance. */
export async function getProviderForUser(userId: string): Promise<IPaymentProvider> {
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { paymentProvider: true },
    });
    return getPaymentProvider(user.paymentProvider);
  } catch (err) {
    if (isMissingRecord(err)) throw new UserNotFoundError(userId);
    throw err;
  }
}

/** Look up the intent's user and return its provider instance. */
export async function getProviderForIntent(intentId: string): Promise<IPaymentProvider> {
  try {
    const intent = await prisma.purchaseIntent.findUniqueOrThrow({
      where: { id: intentId },
      select: { user: { select: { paymentProvider: true } } },
    });
    return getPaymentProvider(intent.user.paymentProvider);
  } catch (err) {
    if (isMissingRecord(err)) throw new IntentNotFoundError(intentId);
    throw err;
  }
}
