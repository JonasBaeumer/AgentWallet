import {
  IntentEvent,
  IntentStatus,
  LedgerEntryType,
  PotStatus,
  ApprovalDecisionType,
  CryptoNetwork,
  CryptoPaymentStatus,
  CryptoPermissionStatus,
  CryptoProtocol,
  CryptoTokenAmountSchema,
  CryptoWalletStatus,
  PaymentRail,
} from '@/contracts';
import { Prisma } from '@prisma/client';

describe('Shared contracts — enums', () => {
  it('IntentStatus has all expected values', () => {
    const expected = [
      'RECEIVED',
      'SEARCHING',
      'QUOTED',
      'AWAITING_APPROVAL',
      'APPROVED',
      'CARD_ISSUED',
      'CHECKOUT_RUNNING',
      'DONE',
      'FAILED',
      'DENIED',
      'EXPIRED',
    ];
    expected.forEach((v) => expect(Object.values(IntentStatus)).toContain(v));
  });

  it('IntentEvent has all expected values', () => {
    const expected = [
      'INTENT_CREATED',
      'QUOTE_RECEIVED',
      'APPROVAL_REQUESTED',
      'USER_APPROVED',
      'USER_DENIED',
      'CARD_ISSUED',
      'CHECKOUT_STARTED',
      'CHECKOUT_SUCCEEDED',
      'CHECKOUT_FAILED',
      'INTENT_EXPIRED',
    ];
    expected.forEach((v) => expect(Object.values(IntentEvent)).toContain(v));
  });

  it('LedgerEntryType has RESERVE, SETTLE, RETURN', () => {
    expect(Object.values(LedgerEntryType)).toContain('RESERVE');
    expect(Object.values(LedgerEntryType)).toContain('SETTLE');
    expect(Object.values(LedgerEntryType)).toContain('RETURN');
  });

  it('PotStatus has ACTIVE, SETTLED, RETURNED', () => {
    expect(Object.values(PotStatus)).toContain('ACTIVE');
    expect(Object.values(PotStatus)).toContain('SETTLED');
    expect(Object.values(PotStatus)).toContain('RETURNED');
  });

  it('ApprovalDecisionType has APPROVED, DENIED', () => {
    expect(Object.values(ApprovalDecisionType)).toContain('APPROVED');
    expect(Object.values(ApprovalDecisionType)).toContain('DENIED');
  });

  it('keeps payment rail, protocol, network, and execution status as separate enums', () => {
    expect(Object.values(PaymentRail)).toEqual(expect.arrayContaining(['CARD', 'CRYPTO']));
    expect(Object.values(CryptoProtocol)).toEqual(['X402']);
    expect(Object.values(CryptoNetwork)).toEqual(['BASE_SEPOLIA']);
    // Exact, not arrayContaining: the previous form silently tolerated a status
    // being added or removed, and both the trigger and the one-active-per-intent
    // index enumerate this set.
    expect(Object.values(CryptoPaymentStatus)).toEqual([
      'AWAITING_APPROVAL',
      'PREPARED',
      'EXECUTING',
      'SUBMITTED',
      'SUBMISSION_UNKNOWN',
      'CONFIRMING',
      'RECONCILING',
      'SUCCEEDED',
      'FAILED_PRE_SUBMISSION',
      'FAILED_ONCHAIN',
      'DENIED',
      'EXPIRED',
    ]);
    expect(Object.values(CryptoPermissionStatus)).toEqual([
      'PENDING',
      'ACTIVE',
      'REVOKED',
      'EXPIRED',
      'INVALID',
    ]);
    expect(Object.values(CryptoWalletStatus)).toEqual([
      'PROVISIONING',
      'ACTIVE',
      'SUSPENDED',
      'FAILED',
      'CLOSED',
    ]);
  });
});

describe('Custom error classes', () => {
  it('CardAlreadyRevealedError is named correctly', () => {
    const { CardAlreadyRevealedError } = require('@/contracts');
    const err = new CardAlreadyRevealedError('intent-123');
    expect(err.name).toBe('CardAlreadyRevealedError');
    expect(err.message).toContain('intent-123');
  });

  it('InsufficientFundsError includes amounts', () => {
    const { InsufficientFundsError } = require('@/contracts');
    const err = new InsufficientFundsError(100, 500);
    expect(err.name).toBe('InsufficientFundsError');
    expect(err.message).toContain('100');
    expect(err.message).toContain('500');
  });

  it('IllegalTransitionError includes status and event', () => {
    const { IllegalTransitionError } = require('@/contracts');
    const err = new IllegalTransitionError('DONE', 'USER_APPROVED');
    expect(err.name).toBe('IllegalTransitionError');
    expect(err.message).toContain('DONE');
    expect(err.message).toContain('USER_APPROVED');
  });
});

describe('CryptoTokenAmountSchema', () => {
  const valid = {
    displayCurrency: 'usd',
    displayAmount: new Prisma.Decimal('1.25'),
    assetSymbol: 'USDC',
    tokenAddress: `0x${'a'.repeat(40)}`,
    tokenDecimals: 6,
    amountAtomic: new Prisma.Decimal('1250000'),
  };

  it('accepts a well-formed amount', () => {
    expect(CryptoTokenAmountSchema.parse(valid)).toMatchObject({ assetSymbol: 'USDC' });
  });

  // Each of these is a CHECK constraint in the migration. Without the schema the
  // failure arrives at insert time as a raw constraint name, which no caller can
  // map back to a field.
  it.each([
    ['displayCurrency', { displayCurrency: 'USD' }],
    ['assetSymbol', { assetSymbol: 'usdc' }],
    ['tokenAddress casing', { tokenAddress: `0x${'A'.repeat(40)}` }],
    ['tokenAddress length', { tokenAddress: '0xabc' }],
    ['tokenDecimals range', { tokenDecimals: 256 }],
    ['amountAtomic sign', { amountAtomic: new Prisma.Decimal('0') }],
  ])('rejects an invalid %s', (_label, override) => {
    expect(() => CryptoTokenAmountSchema.parse({ ...valid, ...override })).toThrow();
  });

  it('allows a null display amount', () => {
    expect(
      CryptoTokenAmountSchema.parse({ ...valid, displayAmount: null }).displayAmount,
    ).toBeNull();
  });
});

describe('Prisma.Decimal precision for atomic amounts', () => {
  // decimal.js defaults to 20 significant digits; DECIMAL(78,0) holds up to 78,
  // so arithmetic would round silently without the configuration in
  // src/db/client.ts. Importing it is what applies that setting.
  it('adds beyond 20 significant digits without rounding', () => {
    require('@/db/client');
    const atomic = '123456789012345678901234567890123456789012345678901234567890';
    expect(new Prisma.Decimal(atomic).plus(1).toFixed(0)).toBe(
      '123456789012345678901234567890123456789012345678901234567891',
    );
  });
});
