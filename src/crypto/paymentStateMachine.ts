import { CryptoPayment, CryptoPaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '@/db/client';
import {
  CryptoPaymentEvent,
  CryptoPaymentTransitionConflictError,
  IllegalCryptoPaymentTransitionError,
} from '@/contracts/crypto';

const TRANSITIONS = new Map<string, CryptoPaymentStatus>([
  [
    `${CryptoPaymentStatus.AWAITING_APPROVAL}:${CryptoPaymentEvent.USER_APPROVED}`,
    CryptoPaymentStatus.PREPARED,
  ],
  [
    `${CryptoPaymentStatus.AWAITING_APPROVAL}:${CryptoPaymentEvent.USER_DENIED}`,
    CryptoPaymentStatus.DENIED,
  ],
  [
    `${CryptoPaymentStatus.AWAITING_APPROVAL}:${CryptoPaymentEvent.REQUEST_EXPIRED}`,
    CryptoPaymentStatus.EXPIRED,
  ],
  [
    `${CryptoPaymentStatus.PREPARED}:${CryptoPaymentEvent.EXECUTION_STARTED}`,
    CryptoPaymentStatus.EXECUTING,
  ],
  [
    `${CryptoPaymentStatus.PREPARED}:${CryptoPaymentEvent.PRE_SUBMISSION_FAILED}`,
    CryptoPaymentStatus.FAILED_PRE_SUBMISSION,
  ],
  [
    `${CryptoPaymentStatus.PREPARED}:${CryptoPaymentEvent.REQUEST_EXPIRED}`,
    CryptoPaymentStatus.EXPIRED,
  ],
  [
    `${CryptoPaymentStatus.EXECUTING}:${CryptoPaymentEvent.TRANSACTION_SUBMITTED}`,
    CryptoPaymentStatus.SUBMITTED,
  ],
  [
    `${CryptoPaymentStatus.EXECUTING}:${CryptoPaymentEvent.SUBMISSION_AMBIGUOUS}`,
    CryptoPaymentStatus.SUBMISSION_UNKNOWN,
  ],
  [
    `${CryptoPaymentStatus.EXECUTING}:${CryptoPaymentEvent.PRE_SUBMISSION_FAILED}`,
    CryptoPaymentStatus.FAILED_PRE_SUBMISSION,
  ],
  [
    `${CryptoPaymentStatus.SUBMITTED}:${CryptoPaymentEvent.CONFIRMATION_STARTED}`,
    CryptoPaymentStatus.CONFIRMING,
  ],
  [
    `${CryptoPaymentStatus.SUBMITTED}:${CryptoPaymentEvent.RECONCILIATION_STARTED}`,
    CryptoPaymentStatus.RECONCILING,
  ],
  [
    `${CryptoPaymentStatus.SUBMITTED}:${CryptoPaymentEvent.SUBMISSION_AMBIGUOUS}`,
    CryptoPaymentStatus.SUBMISSION_UNKNOWN,
  ],
  [
    `${CryptoPaymentStatus.SUBMISSION_UNKNOWN}:${CryptoPaymentEvent.RECONCILIATION_STARTED}`,
    CryptoPaymentStatus.RECONCILING,
  ],
  [
    `${CryptoPaymentStatus.CONFIRMING}:${CryptoPaymentEvent.PAYMENT_CONFIRMED}`,
    CryptoPaymentStatus.SUCCEEDED,
  ],
  [
    `${CryptoPaymentStatus.CONFIRMING}:${CryptoPaymentEvent.PAYMENT_REVERTED}`,
    CryptoPaymentStatus.FAILED_ONCHAIN,
  ],
  [
    `${CryptoPaymentStatus.CONFIRMING}:${CryptoPaymentEvent.RECONCILIATION_STARTED}`,
    CryptoPaymentStatus.RECONCILING,
  ],
  [
    `${CryptoPaymentStatus.CONFIRMING}:${CryptoPaymentEvent.SUBMISSION_AMBIGUOUS}`,
    CryptoPaymentStatus.SUBMISSION_UNKNOWN,
  ],
  [
    `${CryptoPaymentStatus.RECONCILING}:${CryptoPaymentEvent.RECONCILIATION_FOUND}`,
    CryptoPaymentStatus.CONFIRMING,
  ],
  [
    `${CryptoPaymentStatus.RECONCILING}:${CryptoPaymentEvent.PAYMENT_CONFIRMED}`,
    CryptoPaymentStatus.SUCCEEDED,
  ],
  [
    `${CryptoPaymentStatus.RECONCILING}:${CryptoPaymentEvent.PAYMENT_REVERTED}`,
    CryptoPaymentStatus.FAILED_ONCHAIN,
  ],
  [
    `${CryptoPaymentStatus.RECONCILING}:${CryptoPaymentEvent.SUBMISSION_AMBIGUOUS}`,
    CryptoPaymentStatus.SUBMISSION_UNKNOWN,
  ],
]);

export function getNextCryptoPaymentStatus(
  currentStatus: CryptoPaymentStatus,
  event: CryptoPaymentEvent,
): CryptoPaymentStatus {
  const nextStatus = TRANSITIONS.get(`${currentStatus}:${event}`);
  if (!nextStatus) throw new IllegalCryptoPaymentTransitionError(currentStatus, event);
  return nextStatus;
}

function transitionTimestamps(
  previousStatus: CryptoPaymentStatus,
  status: CryptoPaymentStatus,
  now: Date,
) {
  const reconciliation =
    previousStatus === CryptoPaymentStatus.RECONCILING ? { reconciledAt: now } : {};

  switch (status) {
    case CryptoPaymentStatus.SUBMITTED:
      return { ...reconciliation, submittedAt: now };
    case CryptoPaymentStatus.SUCCEEDED:
      return { ...reconciliation, confirmedAt: now };
    case CryptoPaymentStatus.FAILED_PRE_SUBMISSION:
    case CryptoPaymentStatus.FAILED_ONCHAIN:
      return { ...reconciliation, failedAt: now };
    case CryptoPaymentStatus.RECONCILING:
      return { reconciliationStartedAt: now };
    default:
      return reconciliation;
  }
}

export interface CryptoPaymentTransitionResult {
  payment: CryptoPayment;
  previousStatus: CryptoPaymentStatus;
  newStatus: CryptoPaymentStatus;
}

export async function transitionCryptoPayment(
  paymentId: string,
  event: CryptoPaymentEvent,
  actor: string,
  payload: Record<string, unknown> = {},
): Promise<CryptoPaymentTransitionResult> {
  return prisma.$transaction(async (tx) => {
    const payment = await tx.cryptoPayment.findUnique({ where: { id: paymentId } });
    if (!payment) throw new Error(`Crypto payment not found: ${paymentId}`);

    const previousStatus = payment.status;
    const newStatus = getNextCryptoPaymentStatus(previousStatus, event);
    const now = new Date();
    const result = await tx.cryptoPayment.updateMany({
      where: { id: paymentId, status: previousStatus },
      data: { status: newStatus, ...transitionTimestamps(previousStatus, newStatus, now) },
    });
    if (result.count !== 1) throw new CryptoPaymentTransitionConflictError(paymentId);

    await tx.auditEvent.create({
      data: {
        intentId: payment.intentId,
        actor,
        event: `CRYPTO_${event}`,
        payload: { paymentId, previousStatus, newStatus, ...payload } as Prisma.JsonObject,
      },
    });

    const updated = await tx.cryptoPayment.findUniqueOrThrow({ where: { id: paymentId } });
    return { payment: updated, previousStatus, newStatus };
  });
}
