import { prisma } from '@/db/client';
import {
  ApprovalDecisionType,
  ApprovalDecisionData,
  IntentStatus,
  InvalidApprovalStateError,
  IntentNotFoundError,
} from '@/contracts';

export async function requestApproval(intentId: string): Promise<void> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new IntentNotFoundError(intentId);

  // Transition to AWAITING_APPROVAL if in QUOTED
  if (intent.status === IntentStatus.QUOTED) {
    await prisma.purchaseIntent.update({
      where: { id: intentId },
      data: { status: IntentStatus.AWAITING_APPROVAL },
    });
    await prisma.auditEvent.create({
      data: { intentId, actor: 'approval-service', event: 'APPROVAL_REQUESTED', payload: {} },
    });
  }
}

export async function recordDecision(
  intentId: string,
  decision: ApprovalDecisionType,
  actorId: string,
  reason?: string,
): Promise<ApprovalDecisionData> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new IntentNotFoundError(intentId);

  if (intent.status !== IntentStatus.AWAITING_APPROVAL) {
    throw new InvalidApprovalStateError(intentId, intent.status);
  }

  // Idempotency: if decision already exists, return it
  const existing = await prisma.approvalDecision.findUnique({ where: { intentId } });
  if (existing) {
    return existing as unknown as ApprovalDecisionData;
  }

  // Store decision
  const approvalDecision = await prisma.approvalDecision.create({
    data: { intentId, decision, actorId, reason },
  });

  // Transition intent state
  const newStatus =
    decision === ApprovalDecisionType.APPROVED ? IntentStatus.APPROVED : IntentStatus.DENIED;
  await prisma.purchaseIntent.update({ where: { id: intentId }, data: { status: newStatus } });
  await prisma.auditEvent.create({
    data: {
      intentId,
      actor: actorId,
      event: decision === ApprovalDecisionType.APPROVED ? 'USER_APPROVED' : 'USER_DENIED',
      payload: { reason } as any,
    },
  });

  return approvalDecision as unknown as ApprovalDecisionData;
}
