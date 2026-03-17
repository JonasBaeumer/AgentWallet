jest.mock('@/db/client', () => ({
  prisma: {
    virtualCard: { findUnique: jest.fn() },
    pot: { findFirst: jest.fn() },
  },
}));

jest.mock('@/payments', () => ({
  getPaymentProvider: jest.fn(),
}));

jest.mock('@/ledger/potService', () => ({
  returnIntent: jest.fn(),
}));

jest.mock('@/orchestrator/stateMachine', () => ({
  transitionIntent: jest.fn(),
}));

import { expireIntent } from '@/orchestrator/intentService';
import { prisma } from '@/db/client';
import { getPaymentProvider } from '@/payments';
import { returnIntent } from '@/ledger/potService';
import { transitionIntent } from '@/orchestrator/stateMachine';
import { IntentStatus } from '@/contracts';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;
const mockGetPaymentProvider = getPaymentProvider as jest.Mock;
const mockReturnIntent = returnIntent as jest.Mock;
const mockTransitionIntent = transitionIntent as jest.Mock;

const mockTransitionResult = {
  previousStatus: IntentStatus.CARD_ISSUED,
  newStatus: IntentStatus.EXPIRED,
  intent: { id: 'intent-1', status: IntentStatus.EXPIRED },
};

describe('expireIntent cleanup', () => {
  let mockCancelCard: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockCancelCard = jest.fn().mockResolvedValue(undefined);
    mockGetPaymentProvider.mockReturnValue({ cancelCard: mockCancelCard });
    mockTransitionIntent.mockResolvedValue(mockTransitionResult);
    mockReturnIntent.mockResolvedValue(undefined);
  });

  it('calls cancelCard and returnIntent when card and active pot exist', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({ id: 'card-1', intentId: 'intent-1' });
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue({ id: 'pot-1', intentId: 'intent-1', status: 'ACTIVE' });

    await expireIntent('intent-1');

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockReturnIntent).toHaveBeenCalledWith('intent-1');
  });

  it('calls cancelCard but not returnIntent when card exists but no active pot', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({ id: 'card-1', intentId: 'intent-1' });
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue(null);

    await expireIntent('intent-1');

    expect(mockCancelCard).toHaveBeenCalledWith('intent-1');
    expect(mockReturnIntent).not.toHaveBeenCalled();
  });

  it('calls neither when no card and no pot exist', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue(null);

    await expireIntent('intent-1');

    expect(mockCancelCard).not.toHaveBeenCalled();
    expect(mockReturnIntent).not.toHaveBeenCalled();
  });

  it('resolves and still calls returnIntent when cancelCard throws', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({ id: 'card-1', intentId: 'intent-1' });
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue({ id: 'pot-1', intentId: 'intent-1', status: 'ACTIVE' });
    mockCancelCard.mockRejectedValue(new Error('Stripe error'));

    await expect(expireIntent('intent-1')).resolves.toEqual(mockTransitionResult);
    expect(mockReturnIntent).toHaveBeenCalledWith('intent-1');
  });

  it('resolves when returnIntent throws', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue({ id: 'card-1', intentId: 'intent-1' });
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue({ id: 'pot-1', intentId: 'intent-1', status: 'ACTIVE' });
    mockReturnIntent.mockRejectedValue(new Error('Ledger error'));

    await expect(expireIntent('intent-1')).resolves.toEqual(mockTransitionResult);
  });

  it('does not call returnIntent when pot status is SETTLED', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockResolvedValue(null);
    (mockPrisma.pot.findFirst as jest.Mock).mockResolvedValue(null); // findFirst with status ACTIVE returns null

    await expireIntent('intent-1');

    expect(mockReturnIntent).not.toHaveBeenCalled();
  });

  it('resolves when a Prisma lookup inside cleanup throws', async () => {
    (mockPrisma.virtualCard.findUnique as jest.Mock).mockRejectedValue(new Error('DB connection lost'));

    await expect(expireIntent('intent-1')).resolves.toEqual(mockTransitionResult);
  });
});
