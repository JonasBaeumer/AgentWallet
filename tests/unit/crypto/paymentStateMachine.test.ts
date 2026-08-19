jest.mock('@/db/client', () => ({ prisma: { $transaction: jest.fn() } }));

import { CryptoPaymentStatus } from '@prisma/client';
import {
  CryptoPaymentEvent,
  CryptoPaymentTransitionConflictError,
  IllegalCryptoPaymentTransitionError,
} from '@/contracts';
import { getNextCryptoPaymentStatus, transitionCryptoPayment } from '@/crypto/paymentStateMachine';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function transition(status: CryptoPaymentStatus, event: CryptoPaymentEvent) {
  return getNextCryptoPaymentStatus(status, event);
}

describe('crypto payment state machine', () => {
  beforeEach(() => jest.clearAllMocks());

  it('covers approval through final confirmation', () => {
    let status = transition(
      CryptoPaymentStatus.AWAITING_APPROVAL,
      CryptoPaymentEvent.USER_APPROVED,
    );
    expect(status).toBe(CryptoPaymentStatus.PREPARED);
    status = transition(status, CryptoPaymentEvent.EXECUTION_STARTED);
    expect(status).toBe(CryptoPaymentStatus.EXECUTING);
    status = transition(status, CryptoPaymentEvent.TRANSACTION_SUBMITTED);
    expect(status).toBe(CryptoPaymentStatus.SUBMITTED);
    status = transition(status, CryptoPaymentEvent.CONFIRMATION_STARTED);
    expect(status).toBe(CryptoPaymentStatus.CONFIRMING);
    status = transition(status, CryptoPaymentEvent.PAYMENT_CONFIRMED);
    expect(status).toBe(CryptoPaymentStatus.SUCCEEDED);
  });

  it.each([
    [CryptoPaymentEvent.USER_DENIED, CryptoPaymentStatus.DENIED],
    [CryptoPaymentEvent.REQUEST_EXPIRED, CryptoPaymentStatus.EXPIRED],
  ])('covers an approval-stage %s terminal outcome', (event, expected) => {
    expect(transition(CryptoPaymentStatus.AWAITING_APPROVAL, event)).toBe(expected);
  });

  it('distinguishes a pre-submission failure from an onchain failure', () => {
    expect(transition(CryptoPaymentStatus.PREPARED, CryptoPaymentEvent.PRE_SUBMISSION_FAILED)).toBe(
      CryptoPaymentStatus.FAILED_PRE_SUBMISSION,
    );
    expect(transition(CryptoPaymentStatus.CONFIRMING, CryptoPaymentEvent.PAYMENT_REVERTED)).toBe(
      CryptoPaymentStatus.FAILED_ONCHAIN,
    );
  });

  it('keeps ambiguous submissions out of the retryable pre-submission state', () => {
    expect(transition(CryptoPaymentStatus.EXECUTING, CryptoPaymentEvent.SUBMISSION_AMBIGUOUS)).toBe(
      CryptoPaymentStatus.SUBMISSION_UNKNOWN,
    );
    expect(
      transition(CryptoPaymentStatus.SUBMISSION_UNKNOWN, CryptoPaymentEvent.RECONCILIATION_STARTED),
    ).toBe(CryptoPaymentStatus.RECONCILING);
  });

  it.each([
    [CryptoPaymentEvent.RECONCILIATION_FOUND, CryptoPaymentStatus.CONFIRMING],
    [CryptoPaymentEvent.PAYMENT_CONFIRMED, CryptoPaymentStatus.SUCCEEDED],
    [CryptoPaymentEvent.PAYMENT_REVERTED, CryptoPaymentStatus.FAILED_ONCHAIN],
    [CryptoPaymentEvent.SUBMISSION_AMBIGUOUS, CryptoPaymentStatus.SUBMISSION_UNKNOWN],
  ])('allows reconciliation outcome %s', (event, expected) => {
    expect(transition(CryptoPaymentStatus.RECONCILING, event)).toBe(expected);
  });

  it.each([
    CryptoPaymentStatus.SUCCEEDED,
    CryptoPaymentStatus.FAILED_PRE_SUBMISSION,
    CryptoPaymentStatus.FAILED_ONCHAIN,
    CryptoPaymentStatus.DENIED,
    CryptoPaymentStatus.EXPIRED,
  ])('rejects transitions out of terminal state %s', (status) => {
    expect(() => transition(status, CryptoPaymentEvent.EXECUTION_STARTED)).toThrow(
      IllegalCryptoPaymentTransitionError,
    );
  });

  it('rejects skipping submission and confirmation', () => {
    expect(() =>
      transition(CryptoPaymentStatus.PREPARED, CryptoPaymentEvent.PAYMENT_CONFIRMED),
    ).toThrow(IllegalCryptoPaymentTransitionError);
  });
});

describe('crypto payment transition transaction', () => {
  beforeEach(() => jest.clearAllMocks());

  function arrangeTransaction(status: CryptoPaymentStatus, updateCount = 1) {
    const payment = { id: 'payment-1', intentId: 'intent-1', status };
    const updateMany = jest.fn().mockResolvedValue({ count: updateCount });
    const auditCreate = jest.fn().mockResolvedValue({});
    const findUniqueOrThrow = jest.fn().mockResolvedValue(payment);
    const transactionClient = {
      cryptoPayment: {
        findUnique: jest.fn().mockResolvedValue(payment),
        updateMany,
        findUniqueOrThrow,
      },
      auditEvent: { create: auditCreate },
    };

    (mockPrisma.$transaction as jest.Mock).mockImplementation(
      async (callback: (tx: typeof transactionClient) => Promise<unknown>) =>
        callback(transactionClient),
    );

    return { updateMany, auditCreate };
  }

  it('compare-and-sets state and audits reconciliation start atomically', async () => {
    const { updateMany, auditCreate } = arrangeTransaction(CryptoPaymentStatus.SUBMISSION_UNKNOWN);

    await transitionCryptoPayment(
      'payment-1',
      CryptoPaymentEvent.RECONCILIATION_STARTED,
      'crypto-worker',
      { attempt: 2 },
    );

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'payment-1', status: CryptoPaymentStatus.SUBMISSION_UNKNOWN },
      data: {
        status: CryptoPaymentStatus.RECONCILING,
        reconciliationStartedAt: expect.any(Date),
      },
    });
    expect(auditCreate).toHaveBeenCalledWith({
      data: {
        intentId: 'intent-1',
        actor: 'crypto-worker',
        event: 'CRYPTO_RECONCILIATION_STARTED',
        payload: {
          paymentId: 'payment-1',
          previousStatus: CryptoPaymentStatus.SUBMISSION_UNKNOWN,
          newStatus: CryptoPaymentStatus.RECONCILING,
          attempt: 2,
        },
      },
    });
  });

  it('records both reconciliation completion and final confirmation', async () => {
    const { updateMany } = arrangeTransaction(CryptoPaymentStatus.RECONCILING);

    await transitionCryptoPayment('payment-1', CryptoPaymentEvent.PAYMENT_CONFIRMED, 'reconciler');

    expect(updateMany).toHaveBeenCalledWith({
      where: { id: 'payment-1', status: CryptoPaymentStatus.RECONCILING },
      data: {
        status: CryptoPaymentStatus.SUCCEEDED,
        reconciledAt: expect.any(Date),
        confirmedAt: expect.any(Date),
      },
    });
  });

  it('rejects a concurrent state change before writing an audit event', async () => {
    const { auditCreate } = arrangeTransaction(CryptoPaymentStatus.PREPARED, 0);

    await expect(
      transitionCryptoPayment('payment-1', CryptoPaymentEvent.EXECUTION_STARTED, 'crypto-worker'),
    ).rejects.toThrow(CryptoPaymentTransitionConflictError);
    expect(auditCreate).not.toHaveBeenCalled();
  });
});
