import { CryptoPayment, CryptoPaymentStatus, Prisma } from '@prisma/client';
import { prisma } from '@/db/client';
import {
  CryptoPaymentEvent,
  CryptoPaymentNotFoundError,
  CryptoPaymentTransitionConflictError,
  IllegalCryptoPaymentTransitionError,
} from '@/contracts/crypto';

/**
 * The same rule about which state follows which is also encoded in the database:
 * `enforce_crypto_payment_status_transition()` and the predicate of
 * `CryptoPayment_one_active_per_intent_key`. That duplication is deliberate -- it
 * keeps direct SQL and future workers inside the reviewed lifecycle -- but none
 * of the three copies is loud when it drifts. Exported so
 * `tests/integration/db/cryptoTransitionParity.test.ts` can read all three and
 * assert they still agree.
 */
export const TRANSITIONS = new Map<string, CryptoPaymentStatus>([
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
  // Leaving RECONCILING only counts as reconciled if reconciliation actually
  // resolved something. RECONCILING + SUBMISSION_AMBIGUOUS returns to
  // SUBMISSION_UNKNOWN with the payment still ambiguous, and the next
  // RECONCILING writes a fresh reconciliationStartedAt -- so stamping
  // reconciledAt on that edge leaves the row with reconciledAt earlier than
  // reconciliationStartedAt, and any query treating a non-null reconciledAt as
  // "finished" reports a false positive for a payment that is still unresolved.
  const resolvesReconciliation =
    previousStatus === CryptoPaymentStatus.RECONCILING &&
    status !== CryptoPaymentStatus.SUBMISSION_UNKNOWN;
  const reconciliation = resolvesReconciliation ? { reconciledAt: now } : {};

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
    if (!payment) throw new CryptoPaymentNotFoundError(paymentId);

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
        // Caller metadata is nested rather than spread: a payload carrying
        // paymentId, previousStatus, or newStatus would otherwise overwrite the
        // authoritative transition values and record a misleading financial
        // audit event while the state update itself was correct.
        payload: { paymentId, previousStatus, newStatus, detail: payload } as Prisma.JsonObject,
      },
    });

    const updated = await tx.cryptoPayment.findUniqueOrThrow({ where: { id: paymentId } });
    return { payment: updated, previousStatus, newStatus };
  });
}
