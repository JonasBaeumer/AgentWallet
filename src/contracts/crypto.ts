import {
  CryptoNetwork as PrismaCryptoNetwork,
  CryptoPaymentStatus as PrismaCryptoPaymentStatus,
  CryptoPermissionStatus as PrismaCryptoPermissionStatus,
  CryptoProtocol as PrismaCryptoProtocol,
  CryptoWalletStatus as PrismaCryptoWalletStatus,
  PaymentRail as PrismaPaymentRail,
  Prisma,
} from '@prisma/client';

export {
  PrismaCryptoNetwork as CryptoNetwork,
  PrismaCryptoPaymentStatus as CryptoPaymentStatus,
  PrismaCryptoPermissionStatus as CryptoPermissionStatus,
  PrismaCryptoProtocol as CryptoProtocol,
  PrismaCryptoWalletStatus as CryptoWalletStatus,
  PrismaPaymentRail as PaymentRail,
};

export enum CryptoPaymentEvent {
  USER_APPROVED = 'USER_APPROVED',
  USER_DENIED = 'USER_DENIED',
  REQUEST_EXPIRED = 'REQUEST_EXPIRED',
  EXECUTION_STARTED = 'EXECUTION_STARTED',
  PRE_SUBMISSION_FAILED = 'PRE_SUBMISSION_FAILED',
  TRANSACTION_SUBMITTED = 'TRANSACTION_SUBMITTED',
  SUBMISSION_AMBIGUOUS = 'SUBMISSION_AMBIGUOUS',
  CONFIRMATION_STARTED = 'CONFIRMATION_STARTED',
  PAYMENT_CONFIRMED = 'PAYMENT_CONFIRMED',
  PAYMENT_REVERTED = 'PAYMENT_REVERTED',
  RECONCILIATION_STARTED = 'RECONCILIATION_STARTED',
  RECONCILIATION_FOUND = 'RECONCILIATION_FOUND',
}

export interface CryptoTokenAmount {
  readonly displayCurrency: string;
  readonly displayAmount: Prisma.Decimal | null;
  readonly assetSymbol: string;
  readonly tokenAddress: string;
  readonly tokenDecimals: number;
  readonly amountAtomic: Prisma.Decimal;
}

export class IllegalCryptoPaymentTransitionError extends Error {
  constructor(currentStatus: PrismaCryptoPaymentStatus, event: CryptoPaymentEvent) {
    super(`Illegal crypto payment transition from ${currentStatus} via ${event}`);
    this.name = 'IllegalCryptoPaymentTransitionError';
  }
}

export class CryptoPaymentTransitionConflictError extends Error {
  constructor(paymentId: string) {
    super(`Crypto payment changed during transition: ${paymentId}`);
    this.name = 'CryptoPaymentTransitionConflictError';
  }
}
