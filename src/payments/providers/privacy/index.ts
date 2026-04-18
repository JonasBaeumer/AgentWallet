import {
  IPaymentProvider,
  IssuingBalance,
  VirtualCardData,
  CardReveal,
  ProviderMetadata,
  PaymentProvider,
} from '@/contracts';
import { issueVirtualCard, revealCard, freezeCard, cancelCard } from './cardService';
import { handlePrivacyEvent } from './webhookHandler';

const METADATA: ProviderMetadata = {
  id: PaymentProvider.PRIVACY_COM,
  displayName: 'Privacy.com',
  currency: 'usd',
  authorizationModel: 'fire_and_forget',
  autoCancelAfterUse: true,
  supportsFreeze: false,
};

export class PrivacyComPaymentProvider implements IPaymentProvider {
  readonly metadata = METADATA;

  async issueCard(intentId: string, amount: number): Promise<VirtualCardData> {
    return issueVirtualCard(intentId, amount);
  }

  async revealCard(intentId: string): Promise<CardReveal> {
    return revealCard(intentId);
  }

  async freezeCard(intentId: string): Promise<void> {
    return freezeCard(intentId);
  }

  async cancelCard(intentId: string): Promise<void> {
    return cancelCard(intentId);
  }

  async handleWebhookEvent(
    rawBody: Buffer | string,
    signature: string,
  ): Promise<Record<string, unknown>> {
    return handlePrivacyEvent(rawBody, signature);
  }

  async getIssuingBalance(): Promise<IssuingBalance> {
    // Privacy.com doesn't expose an issuing-balance concept — funding is
    // attached to cards at creation time and pulled from the linked bank
    // account on authorization. Return a sentinel high balance so the
    // approval flow's balance guard always passes for Privacy users.
    return { available: Number.MAX_SAFE_INTEGER, currency: this.metadata.currency };
  }
}
