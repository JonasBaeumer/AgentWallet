import { prisma } from '@/db/client';
import { IntentStatus, IntentEvent, PurchaseIntentData, IntentNotFoundError } from '@/contracts';
import { getNextStatus } from './transitions';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'orchestrator/stateMachine' });

export interface TransitionResult {
  intent: PurchaseIntentData;
  previousStatus: IntentStatus;
  newStatus: IntentStatus;
}

export interface TransitionOptions {
  actor?: string;
  agentId?: string;
}

export async function transitionIntent(
  intentId: string,
  event: IntentEvent,
  payload: Record<string, unknown> = {},
  options: TransitionOptions = {},
): Promise<TransitionResult> {
  // When an agent triggers the transition, attribute the audit event to the agent:
  // actor is the free-form subject string (agentId takes priority), agentId is the
  // typed column kept in sync for querying/analytics.
  const agentId = options.agentId;
  const actor = options.actor ?? agentId ?? 'system';

  return await prisma.$transaction(async (tx) => {
    const intent = await tx.purchaseIntent.findUnique({ where: { id: intentId } });
    if (!intent) throw new IntentNotFoundError(intentId);

    const previousStatus = intent.status as IntentStatus;
    const newStatus = getNextStatus(previousStatus, event);

    const updated = await tx.purchaseIntent.update({
      where: { id: intentId },
      data: { status: newStatus },
    });

    await tx.auditEvent.create({
      data: {
        intentId,
        actor,
        agentId: agentId ?? null,
        event,
        payload: { previousStatus, newStatus, ...payload } as any,
      },
    });

    log.info({ intentId, event, previousStatus, newStatus, actor, agentId }, 'Intent transition');

    return {
      intent: updated as unknown as PurchaseIntentData,
      previousStatus,
      newStatus,
    };
  });
}
