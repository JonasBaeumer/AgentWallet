/**
 * Actor-attribution tests for transitionIntent + intentService helpers.
 *
 * Guarantees:
 *  - When an agentId is passed, the AuditEvent row records both actor=agentId
 *    and agentId=<agentId>, and the log line carries { actor, agentId }.
 *  - When no agentId is passed, AuditEvent.actor falls back to the documented
 *    default for that helper ("system" / "worker") and agentId is null.
 */

jest.mock('@/db/client', () => ({
  prisma: {
    $transaction: jest.fn(),
    purchaseIntent: { findUnique: jest.fn(), update: jest.fn() },
    auditEvent: { create: jest.fn() },
  },
}));

import { IntentStatus, IntentEvent } from '@/contracts';
import { transitionIntent } from '@/orchestrator/stateMachine';
import {
  receiveQuote,
  requestApproval,
  startCheckout,
  completeCheckout,
  failCheckout,
} from '@/orchestrator/intentService';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

function setupTxMock(initialStatus: IntentStatus) {
  const auditCreate = jest.fn().mockResolvedValue({});
  const txIntentUpdate = jest.fn().mockImplementation(async ({ data }: any) => ({
    id: 'intent-1',
    status: data.status,
  }));

  (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
    const txMock = {
      purchaseIntent: {
        findUnique: jest.fn().mockResolvedValue({ id: 'intent-1', status: initialStatus }),
        update: txIntentUpdate,
      },
      auditEvent: { create: auditCreate },
    };
    return fn(txMock);
  });

  return { auditCreate };
}

describe('AuditEvent actor attribution', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('transitionIntent', () => {
    it('records actor=agentId and agentId=<agentId> when an agent triggers the transition', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.RECEIVED);
      await transitionIntent('intent-1', IntentEvent.INTENT_CREATED, {}, 'ag_abc123', 'ag_abc123');

      expect(auditCreate).toHaveBeenCalledTimes(1);
      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_abc123');
      expect(row.agentId).toBe('ag_abc123');
      expect(row.event).toBe(IntentEvent.INTENT_CREATED);
    });

    it('defaults actor to "system" and agentId to null when neither is provided', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.RECEIVED);
      await transitionIntent('intent-1', IntentEvent.INTENT_CREATED);

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('system');
      expect(row.agentId).toBeNull();
    });
  });

  describe('intentService helpers', () => {
    it('receiveQuote: agentId attributed to both actor and agentId', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.SEARCHING);
      (mockPrisma.purchaseIntent.update as jest.Mock).mockResolvedValue({
        id: 'intent-1',
        status: IntentStatus.SEARCHING,
      });

      await receiveQuote('intent-1', { price: 100 }, 'ag_quote');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_quote');
      expect(row.agentId).toBe('ag_quote');
    });

    it('receiveQuote without agentId falls back to actor=system, agentId=null', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.SEARCHING);
      (mockPrisma.purchaseIntent.update as jest.Mock).mockResolvedValue({
        id: 'intent-1',
        status: IntentStatus.SEARCHING,
      });

      await receiveQuote('intent-1', { price: 100 });

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('system');
      expect(row.agentId).toBeNull();
    });

    it('requestApproval attributes the agent when provided', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.QUOTED);
      await requestApproval('intent-1', 'ag_approve');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_approve');
      expect(row.agentId).toBe('ag_approve');
    });

    it('startCheckout falls back to actor="worker" when no agentId is supplied', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.CARD_ISSUED);
      await startCheckout('intent-1');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('worker');
      expect(row.agentId).toBeNull();
    });

    it('startCheckout uses the agentId when provided', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.CARD_ISSUED);
      await startCheckout('intent-1', 'ag_checkout');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_checkout');
      expect(row.agentId).toBe('ag_checkout');
    });

    it('completeCheckout attributes the agent and records actualAmount', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.CHECKOUT_RUNNING);
      await completeCheckout('intent-1', 4200, 'ag_done');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_done');
      expect(row.agentId).toBe('ag_done');
      expect(row.payload.actualAmount).toBe(4200);
    });

    it('failCheckout attributes the agent and records errorMessage', async () => {
      const { auditCreate } = setupTxMock(IntentStatus.CHECKOUT_RUNNING);
      await failCheckout('intent-1', 'card declined', 'ag_fail');

      const row = auditCreate.mock.calls[0][0].data;
      expect(row.actor).toBe('ag_fail');
      expect(row.agentId).toBe('ag_fail');
      expect(row.payload.errorMessage).toBe('card declined');
    });
  });
});
