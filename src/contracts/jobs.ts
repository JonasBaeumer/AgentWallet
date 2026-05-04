export interface SearchIntentJob {
  intentId: string;
  userId: string;
  query: string;
  maxBudget: number;
  currency: string;
  subject?: string;
}

export interface CheckoutIntentJob {
  intentId: string;
  userId: string;
  merchantName: string;
  merchantUrl: string;
  price: number;
  currency: string;
  providerCardId: string;
  last4: string;
}
