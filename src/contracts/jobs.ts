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
  stripeCardId: string;
  last4: string;
}

export interface CancelCardJob {
  intentId: string;
}

export const QUEUE_NAMES = {
  SEARCH: 'search-queue',
  CHECKOUT: 'checkout-queue',
  CANCEL_CARD: 'cancel-card-queue',
} as const;
