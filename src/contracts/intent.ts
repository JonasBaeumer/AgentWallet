import { IntentStatus as PrismaIntentStatus, CardCancelPolicy as PrismaCardCancelPolicy } from '@prisma/client';

export { PrismaIntentStatus as IntentStatus };
export { PrismaCardCancelPolicy as CardCancelPolicy };

export enum IntentEvent {
  INTENT_CREATED = 'INTENT_CREATED',
  QUOTE_RECEIVED = 'QUOTE_RECEIVED',
  APPROVAL_REQUESTED = 'APPROVAL_REQUESTED',
  USER_APPROVED = 'USER_APPROVED',
  USER_DENIED = 'USER_DENIED',
  CARD_ISSUED = 'CARD_ISSUED',
  CHECKOUT_STARTED = 'CHECKOUT_STARTED',
  CHECKOUT_SUCCEEDED = 'CHECKOUT_SUCCEEDED',
  CHECKOUT_FAILED = 'CHECKOUT_FAILED',
  INTENT_EXPIRED = 'INTENT_EXPIRED',
}

export interface PurchaseIntentData {
  id: string;
  userId: string;
  query: string;
  subject: string | null;
  maxBudget: number;
  currency: string;
  status: PrismaIntentStatus;
  metadata: Record<string, unknown>;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date | null;
}
