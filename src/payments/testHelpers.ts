/**
 * Test-only helpers for the payments module.
 * Import these only in test files — never in production code.
 */
import { MockPaymentProvider } from './providers/mock/mockProvider';
import { StripePaymentProvider } from './providers/stripe';
import { getStripeClient } from './providers/stripe/stripeClient';
import { runSimulatedCheckout } from './providers/stripe/checkoutSimulator';
import { getPaymentProvider, resetPaymentProvider } from './providerFactory';

export { resetPaymentProvider };

export function createStripeProvider() {
  return {
    provider: new StripePaymentProvider(),
    get stripe() { return getStripeClient(); },
    runSimulatedCheckout,
  };
}

export function getMockProvider(): MockPaymentProvider {
  const provider = getPaymentProvider();
  if (!(provider instanceof MockPaymentProvider)) {
    throw new Error('getMockProvider() called but active provider is not MockPaymentProvider');
  }
  return provider;
}

export function getMockProviderCalls() {
  return getMockProvider().getCalls();
}

export function clearMockProviderCalls() {
  getMockProvider().clearCalls();
}
