import { PaymentProvider } from '@prisma/client';

export { PaymentProvider };

/**
 * Describes a payment provider's capabilities and defaults. Callers use this
 * instead of hardcoding provider assumptions (e.g. currency, auth model).
 */
export interface ProviderMetadata {
  id: PaymentProvider;
  displayName: string;
  currency: string;
  authorizationModel: 'per_transaction' | 'fire_and_forget';
  autoCancelAfterUse: boolean;
  supportsFreeze: boolean;
}

export class UnsupportedProviderOperationError extends Error {
  constructor(provider: PaymentProvider, operation: string) {
    super(`Provider ${provider} does not support operation: ${operation}`);
    this.name = 'UnsupportedProviderOperationError';
  }
}
