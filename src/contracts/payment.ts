import { PaymentProvider } from '@prisma/client';

export { PaymentProvider };

/**
 * Describes a payment provider's defaults. Additional fields
 * (displayName, authorizationModel, autoCancelAfterUse, supportsFreeze)
 * will be added alongside their first consumer in the Privacy.com PR (#106).
 */
export interface ProviderMetadata {
  id: PaymentProvider;
  currency: string;
}
