import {
  IPaymentProvider,
  IssuingBalance,
  VirtualCardData,
  CardReveal,
  ProviderMetadata,
  PaymentProvider,
} from '@/contracts';

type CallRecord = { method: string; args: unknown[]; timestamp: number };

const METADATA: ProviderMetadata = {
  id: PaymentProvider.STRIPE,
  displayName: 'Mock (Stripe-compatible)',
  currency: 'eur',
  authorizationModel: 'per_transaction',
  autoCancelAfterUse: false,
  supportsFreeze: true,
};

export class MockPaymentProvider implements IPaymentProvider {
  readonly metadata = METADATA;
  private calls: CallRecord[] = [];
  private issuingBalance = 999_999_99;

  getCalls(): CallRecord[] {
    return [...this.calls];
  }

  clearCalls(): void {
    this.calls.length = 0;
  }

  async issueCard(
    intentId: string,
    amount: number,
    options?: { mccAllowlist?: string[] },
  ): Promise<VirtualCardData> {
    this.calls.push({
      method: 'issueCard',
      args: [intentId, amount, options],
      timestamp: Date.now(),
    });
    return {
      id: `mock-card-${intentId}`,
      intentId,
      providerCardId: `mock_provider_${intentId}`,
      last4: '4242',
      revealedAt: null,
      frozenAt: null,
      cancelledAt: null,
      createdAt: new Date(),
    };
  }

  async revealCard(intentId: string): Promise<CardReveal> {
    this.calls.push({ method: 'revealCard', args: [intentId], timestamp: Date.now() });
    return { number: '4242424242424242', cvc: '123', expMonth: 12, expYear: 2030, last4: '4242' };
  }

  async freezeCard(intentId: string): Promise<void> {
    this.calls.push({ method: 'freezeCard', args: [intentId], timestamp: Date.now() });
  }

  async cancelCard(intentId: string): Promise<void> {
    this.calls.push({ method: 'cancelCard', args: [intentId], timestamp: Date.now() });
  }

  async handleWebhookEvent(
    rawBody: Buffer | string,
    signature: string,
  ): Promise<Record<string, unknown>> {
    this.calls.push({
      method: 'handleWebhookEvent',
      args: [rawBody, signature],
      timestamp: Date.now(),
    });
    return { received: true };
  }

  async getIssuingBalance(): Promise<IssuingBalance> {
    this.calls.push({ method: 'getIssuingBalance', args: [], timestamp: Date.now() });
    return { available: this.issuingBalance, currency: this.metadata.currency };
  }

  setIssuingBalance(amount: number): void {
    this.issuingBalance = amount;
  }
}
