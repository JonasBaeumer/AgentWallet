import { env } from '@/config/env';
import { IPaymentProvider } from '@/contracts';

let _provider: IPaymentProvider | null = null;

export function getPaymentProvider(): IPaymentProvider {
  if (_provider) return _provider;

  const name = env.PAYMENT_PROVIDER;

  // NODE_ENV=test always uses mock regardless of PAYMENT_PROVIDER setting
  if (name === 'mock' || env.NODE_ENV === 'test') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { MockPaymentProvider } = require('./providers/mock/mockProvider');
    _provider = new MockPaymentProvider();
  } else if (name === 'stripe') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { StripePaymentProvider } = require('./providers/stripe');
    _provider = new StripePaymentProvider();
  } else {
    throw new Error(`Unknown payment provider: "${name}". Valid values: stripe, mock`);
  }

  return _provider!;
}

export function resetPaymentProvider(): void {
  _provider = null;
}
