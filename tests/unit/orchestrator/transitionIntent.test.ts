jest.mock('@/db/client', () => ({
  prisma: {
    $transaction: jest.fn(),
    purchaseIntent: { findUnique: jest.fn(), update: jest.fn() },
    auditEvent: { create: jest.fn() },
  },
}));

import {
  IntentStatus,
  IntentEvent,
  IllegalTransitionError,
  IntentNotFoundError,
} from '@/contracts';
import { transitionIntent } from '@/orchestrator/stateMachine';
import { prisma } from '@/db/client';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

describe('transitionIntent', () => {
  beforeEach(() => jest.clearAllMocks());

  it('performs legal transition and writes audit event', async () => {
    const mockIntent = { id: 'intent-1', status: IntentStatus.RECEIVED };
    const mockUpdated = { ...mockIntent, status: IntentStatus.SEARCHING };

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const txMock = {
        purchaseIntent: {
          findUnique: jest.fn().mockResolvedValue(mockIntent),
          update: jest.fn().mockResolvedValue(mockUpdated),
        },
        auditEvent: { create: jest.fn().mockResolvedValue({}) },
      };
      return fn(txMock);
    });

    const result = await transitionIntent('intent-1', IntentEvent.INTENT_CREATED);
    expect(result.previousStatus).toBe(IntentStatus.RECEIVED);
    expect(result.newStatus).toBe(IntentStatus.SEARCHING);
  });

  it('throws IntentNotFoundError when intent does not exist', async () => {
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const txMock = {
        purchaseIntent: { findUnique: jest.fn().mockResolvedValue(null) },
        auditEvent: { create: jest.fn() },
      };
      return fn(txMock);
    });

    await expect(transitionIntent('nonexistent', IntentEvent.INTENT_CREATED)).rejects.toThrow(
      IntentNotFoundError,
    );
  });

  it('throws IllegalTransitionError for invalid transition', async () => {
    const mockIntent = { id: 'intent-1', status: IntentStatus.DONE };

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const txMock = {
        purchaseIntent: { findUnique: jest.fn().mockResolvedValue(mockIntent) },
        auditEvent: { create: jest.fn() },
      };
      return fn(txMock);
    });

    await expect(transitionIntent('intent-1', IntentEvent.USER_APPROVED)).rejects.toThrow(
      IllegalTransitionError,
    );
  });

  it('writes AuditEvent on every transition', async () => {
    const mockIntent = { id: 'intent-1', status: IntentStatus.RECEIVED };
    const auditCreateMock = jest.fn().mockResolvedValue({});

    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
      const txMock = {
        purchaseIntent: {
          findUnique: jest.fn().mockResolvedValue(mockIntent),
          update: jest.fn().mockResolvedValue({ ...mockIntent, status: IntentStatus.SEARCHING }),
        },
        auditEvent: { create: auditCreateMock },
      };
      return fn(txMock);
    });

    await transitionIntent('intent-1', IntentEvent.INTENT_CREATED);
    expect(auditCreateMock).toHaveBeenCalledTimes(1);
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ intentId: 'intent-1', event: IntentEvent.INTENT_CREATED }),
      }),
    );
  });

  describe('actor attribution', () => {
    function runTransition() {
      const mockIntent = { id: 'intent-1', status: IntentStatus.RECEIVED };
      const auditCreateMock = jest.fn().mockResolvedValue({});
      (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => {
        const txMock = {
          purchaseIntent: {
            findUnique: jest.fn().mockResolvedValue(mockIntent),
            update: jest.fn().mockResolvedValue({ ...mockIntent, status: IntentStatus.SEARCHING }),
          },
          auditEvent: { create: auditCreateMock },
        };
        return fn(txMock);
      });
      return { auditCreateMock };
    }

    it('defaults actor to "system" and agentId to null when no options passed', async () => {
      const { auditCreateMock } = runTransition();
      await transitionIntent('intent-1', IntentEvent.INTENT_CREATED);
      expect(auditCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'system', agentId: null }),
        }),
      );
    });

    it('uses agentId as actor and populates agentId column when only agentId provided', async () => {
      const { auditCreateMock } = runTransition();
      await transitionIntent('intent-1', IntentEvent.INTENT_CREATED, {}, { agentId: 'ag_abc123' });
      expect(auditCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'ag_abc123', agentId: 'ag_abc123' }),
        }),
      );
    });

    it('keeps explicit actor (e.g. user) and still records agentId separately', async () => {
      const { auditCreateMock } = runTransition();
      await transitionIntent(
        'intent-1',
        IntentEvent.INTENT_CREATED,
        {},
        { actor: 'user-1', agentId: 'ag_abc123' },
      );
      expect(auditCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'user-1', agentId: 'ag_abc123' }),
        }),
      );
    });

    it('uses explicit actor without agentId when agent is not involved', async () => {
      const { auditCreateMock } = runTransition();
      await transitionIntent(
        'intent-1',
        IntentEvent.INTENT_CREATED,
        {},
        { actor: 'approval-service' },
      );
      expect(auditCreateMock).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ actor: 'approval-service', agentId: null }),
        }),
      );
    });
  });
});
