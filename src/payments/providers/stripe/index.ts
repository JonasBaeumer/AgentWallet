import { IPaymentProvider, IssuingBalance, VirtualCardData, CardReveal } from '@/contracts';
import { issueVirtualCard, revealCard, freezeCard, cancelCard } from './cardService';
import { getIssuingBalance as fetchIssuingBalance } from './balanceService';
import { handleStripeEvent } from './webhookHandler';

export class StripePaymentProvider implements IPaymentProvider {
  async issueCard(
    intentId: string,
    amount: number,
    currency: string,
    options?: { mccAllowlist?: string[] },
  ): Promise<VirtualCardData> {
    return issueVirtualCard(intentId, amount, currency, options);
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

  async handleWebhookEvent(rawBody: Buffer | string, signature: string): Promise<void> {
    return handleStripeEvent(rawBody, signature);
  }

  async getIssuingBalance(currency: string): Promise<IssuingBalance> {
    return fetchIssuingBalance(currency);
  }
}
