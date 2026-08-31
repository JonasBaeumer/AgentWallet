import {
  CryptoNetwork as PrismaCryptoNetwork,
  CryptoPaymentStatus as PrismaCryptoPaymentStatus,
  CryptoPermissionStatus as PrismaCryptoPermissionStatus,
  CryptoProtocol as PrismaCryptoProtocol,
  CryptoWalletStatus as PrismaCryptoWalletStatus,
  Prisma,
} from '@prisma/client';
import { z } from 'zod';

export {
  PrismaCryptoNetwork as CryptoNetwork,
  PrismaCryptoPaymentStatus as CryptoPaymentStatus,
  PrismaCryptoPermissionStatus as CryptoPermissionStatus,
  PrismaCryptoProtocol as CryptoProtocol,
  PrismaCryptoWalletStatus as CryptoWalletStatus,
};

// PaymentRail is re-exported by ./intent, which owns the intent-facing contract.
// Both star-export from the same @prisma/client binding, so duplicating it here
// compiles but gives the two modules room to diverge later.

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

const decimal = z.instanceof(Prisma.Decimal);

/**
 * Mirrors the CHECK constraints the migration puts on these columns. Without it
 * a bad value first fails at insert, as a raw constraint name such as
 * `crypto_payment_symbols`, which no caller can map back to a field.
 *
 * Addresses are lowercase because the database normalizes them on write; the
 * uniqueness indexes are plain TEXT indexes and would otherwise admit the same
 * address twice in different cases.
 */
export const CryptoTokenAmountSchema = z.object({
  displayCurrency: z
    .string()
    .regex(/^[a-z]{3}$/, 'displayCurrency must be a 3-letter lowercase code'),
  displayAmount: decimal.nullable(),
  assetSymbol: z
    .string()
    .regex(/^[A-Z0-9]{2,16}$/, 'assetSymbol must be 2-16 uppercase alphanumerics'),
  tokenAddress: z
    .string()
    .regex(/^0x[0-9a-f]{40}$/, 'tokenAddress must be a lowercase 0x EVM address'),
  tokenDecimals: z.number().int().min(0).max(255),
  amountAtomic: decimal.refine((value) => value.greaterThan(0), 'amountAtomic must be positive'),
});

export type CryptoTokenAmount = Readonly<z.infer<typeof CryptoTokenAmountSchema>>;

export class IllegalCryptoPaymentTransitionError extends Error {
  constructor(currentStatus: PrismaCryptoPaymentStatus, event: CryptoPaymentEvent) {
    super(`Illegal crypto payment transition from ${currentStatus} via ${event}`);
    this.name = 'IllegalCryptoPaymentTransitionError';
  }
}

export class CryptoPaymentNotFoundError extends Error {
  constructor(paymentId: string) {
    super(`Crypto payment not found: ${paymentId}`);
    this.name = 'CryptoPaymentNotFoundError';
  }
}

export class CryptoPaymentTransitionConflictError extends Error {
  constructor(paymentId: string) {
    super(`Crypto payment changed during transition: ${paymentId}`);
    this.name = 'CryptoPaymentTransitionConflictError';
  }
}

export class CryptoFeatureDisabledError extends Error {
  constructor() {
    super('Crypto wallet onboarding is disabled');
    this.name = 'CryptoFeatureDisabledError';
  }
}

export class CdpSessionValidationError extends Error {
  constructor(public readonly reason: 'invalid_session' | 'provider_unavailable') {
    super(
      reason === 'invalid_session'
        ? 'The Coinbase wallet session is invalid or expired'
        : 'Coinbase wallet verification is temporarily unavailable',
    );
    this.name = 'CdpSessionValidationError';
  }
}

export class CryptoWalletAlreadyBoundError extends Error {
  constructor() {
    super('This Coinbase wallet is already bound to another AgentWallet customer');
    this.name = 'CryptoWalletAlreadyBoundError';
  }
}

export class CryptoWalletIdentityMismatchError extends Error {
  constructor() {
    super('The authenticated customer is already bound to a different Coinbase wallet');
    this.name = 'CryptoWalletIdentityMismatchError';
  }
}

export class CryptoWalletDisconnectBlockedError extends Error {
  constructor() {
    super('Revoke active permissions and finish pending crypto payments before disconnecting');
    this.name = 'CryptoWalletDisconnectBlockedError';
  }
}

export class CryptoWalletNotFoundError extends Error {
  constructor() {
    super('No Coinbase wallet is bound to this customer');
    this.name = 'CryptoWalletNotFoundError';
  }
}
