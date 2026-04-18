jest.mock('@/db/client', () => ({
  prisma: {
    purchaseIntent: { findUnique: jest.fn(), update: jest.fn() },
    approvalDecision: { findUnique: jest.fn(), create: jest.fn() },
    auditEvent: { create: jest.fn() },
  },
}));

import { recordDecision } from '@/approval/approvalService';
import { prisma } from '@/db/client';
import { ApprovalDecisionType, IntentStatus, InvalidApprovalStateError } from '@/contracts';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

beforeEach(() => jest.clearAllMocks());

describe('recordDecision', () => {
  it('throws InvalidApprovalStateError when not in AWAITING_APPROVAL', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
      id: 'i-1',
      status: IntentStatus.RECEIVED,
    });

    await expect(recordDecision('i-1', ApprovalDecisionType.APPROVED, 'user-1')).rejects.toThrow(
      InvalidApprovalStateError,
    );
  });

  it('is idempotent — second call returns first result', async () => {
    const existingDecision = {
      id: 'ad-1',
      intentId: 'i-1',
      decision: ApprovalDecisionType.APPROVED,
      actorId: 'user-1',
    };
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
      id: 'i-1',
      status: IntentStatus.AWAITING_APPROVAL,
    });
    (mockPrisma.approvalDecision.findUnique as jest.Mock).mockResolvedValue(existingDecision);

    const result = await recordDecision('i-1', ApprovalDecisionType.APPROVED, 'user-1');
    expect(result).toEqual(existingDecision);
    expect(mockPrisma.approvalDecision.create).not.toHaveBeenCalled();
  });

  it('stores APPROVED decision and transitions intent', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
      id: 'i-1',
      status: IntentStatus.AWAITING_APPROVAL,
    });
    (mockPrisma.approvalDecision.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.approvalDecision.create as jest.Mock).mockResolvedValue({
      id: 'ad-1',
      decision: ApprovalDecisionType.APPROVED,
    });
    (mockPrisma.purchaseIntent.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

    await recordDecision('i-1', ApprovalDecisionType.APPROVED, 'user-1');

    expect(mockPrisma.purchaseIntent.update).toHaveBeenCalledWith({
      where: { id: 'i-1' },
      data: { status: IntentStatus.APPROVED },
    });
  });

  it('stores DENIED decision and transitions intent to DENIED', async () => {
    (mockPrisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValue({
      id: 'i-1',
      status: IntentStatus.AWAITING_APPROVAL,
    });
    (mockPrisma.approvalDecision.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.approvalDecision.create as jest.Mock).mockResolvedValue({
      id: 'ad-1',
      decision: ApprovalDecisionType.DENIED,
    });
    (mockPrisma.purchaseIntent.update as jest.Mock).mockResolvedValue({});
    (mockPrisma.auditEvent.create as jest.Mock).mockResolvedValue({});

    await recordDecision('i-1', ApprovalDecisionType.DENIED, 'user-1', 'Too expensive');

    expect(mockPrisma.purchaseIntent.update).toHaveBeenCalledWith({
      where: { id: 'i-1' },
      data: { status: IntentStatus.DENIED },
    });
  });
});
