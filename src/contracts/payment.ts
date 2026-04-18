import { PaymentProvider } from '@prisma/client';

export { PaymentProvider };

/**
 * Describes a payment provider's defaults and capabilities. Callers consult
 * this instead of hardcoding provider-specific behavior (currency, auth model,
 * which operations are supported).
 */
export interface ProviderMetadata {
  id: PaymentProvider;
  displayName: string;
  currency: string;
  /**
   * Whether the provider fires a synchronous per-transaction authorization
   * hook (Stripe's `issuing_authorization.request`) or commits at card
   * creation time with no per-transaction approve/deny (Privacy.com).
   */
  authorizationModel: 'per_transaction' | 'fire_and_forget';
  /**
   * Whether the card auto-closes after its first transaction. True for
   * providers like Privacy.com that issue SINGLE_USE cards. When true,
   * callers skip explicit cancelCard calls after checkout.
   */
  autoCancelAfterUse: boolean;
  /**
   * Whether the provider supports freezing (PAUSED) a card. When false,
   * freezeCard throws UnsupportedProviderOperationError.
   */
  supportsFreeze: boolean;
}

export class UnsupportedProviderOperationError extends Error {
  public readonly provider: PaymentProvider;
  public readonly operation: string;

  constructor(provider: PaymentProvider, operation: string) {
    super(`Provider ${provider} does not support operation: ${operation}`);
    this.name = 'UnsupportedProviderOperationError';
    this.provider = provider;
    this.operation = operation;
  }
}
