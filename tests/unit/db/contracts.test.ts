import {
  IntentEvent,
  IntentStatus,
  LedgerEntryType,
  PotStatus,
  ApprovalDecisionType,
} from '@/contracts';

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
