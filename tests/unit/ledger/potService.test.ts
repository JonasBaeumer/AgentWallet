jest.mock('@/db/client', () => ({
  prisma: {
    $transaction: jest.fn(),
  },
}));

import { reserveForIntent, settleIntent, returnIntent } from '@/ledger/potService';
import { prisma } from '@/db/client';
import { InsufficientFundsError, IntentNotFoundError } from '@/contracts';

const mockPrisma = prisma as jest.Mocked<typeof prisma>;

beforeEach(() => jest.clearAllMocks());

function makeTxMock(overrides: Record<string, any> = {}) {
  return {
    user: { findUnique: jest.fn(), update: jest.fn() },
    pot: { create: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
    ledgerEntry: { create: jest.fn() },
    purchaseIntent: {
      // Default: intent belongs to 'user-1' so the ownership check in
      // reserveForIntent passes for the common test setup.
      findUnique: jest.fn().mockResolvedValue({ currency: 'eur', userId: 'user-1' }),
    },
    ...overrides,
  };
}

describe('reserveForIntent', () => {
  it('throws InsufficientFundsError when balance too low', async () => {
    const tx = makeTxMock();
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', mainBalance: 500 });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await expect(reserveForIntent('user-1', 'intent-1', 1000)).rejects.toThrow(
      InsufficientFundsError,
    );
  });

  it('creates pot and ledger entry when balance sufficient', async () => {
    const tx = makeTxMock();
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', mainBalance: 10000 });
    tx.pot.create.mockResolvedValue({ id: 'pot-1', reservedAmount: 5000, status: 'ACTIVE' });
    tx.ledgerEntry.create.mockResolvedValue({});
    tx.user.update.mockResolvedValue({});
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await reserveForIntent('user-1', 'intent-1', 5000);

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { mainBalance: { decrement: 5000 } },
    });
    expect(tx.pot.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ reservedAmount: 5000, status: 'ACTIVE' }),
      }),
    );
  });

  it('writes ledger entry with the currency fetched from the intent', async () => {
    const tx = makeTxMock({
      purchaseIntent: {
        findUnique: jest.fn().mockResolvedValue({ currency: 'usd', userId: 'user-1' }),
      },
    });
    tx.user.findUnique.mockResolvedValue({ id: 'user-1', mainBalance: 10000 });
    tx.pot.create.mockResolvedValue({ id: 'pot-1', reservedAmount: 5000, status: 'ACTIVE' });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await reserveForIntent('user-1', 'intent-1', 5000);

    expect(tx.ledgerEntry.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: 'usd' }),
      }),
    );
  });

  it('throws IntentNotFoundError when the intent does not exist', async () => {
    const tx = makeTxMock({
      purchaseIntent: { findUnique: jest.fn().mockResolvedValue(null) },
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await expect(reserveForIntent('user-1', 'intent-1', 1000)).rejects.toThrow(IntentNotFoundError);
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.pot.create).not.toHaveBeenCalled();
  });

  it('throws IntentNotFoundError when the intent belongs to a different user', async () => {
    const tx = makeTxMock({
      purchaseIntent: {
        findUnique: jest.fn().mockResolvedValue({ currency: 'eur', userId: 'someone-else' }),
      },
    });
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await expect(reserveForIntent('user-1', 'intent-1', 1000)).rejects.toThrow(IntentNotFoundError);
    // Ownership check must short-circuit before any user lookup or writes.
    expect(tx.user.findUnique).not.toHaveBeenCalled();
    expect(tx.pot.create).not.toHaveBeenCalled();
    expect(tx.ledgerEntry.create).not.toHaveBeenCalled();
  });
});

describe('settleIntent', () => {
  it('returns surplus to mainBalance', async () => {
    const tx = makeTxMock();
    tx.pot.findUnique.mockResolvedValue({
      id: 'pot-1',
      userId: 'user-1',
      reservedAmount: 10000,
      status: 'ACTIVE',
    });
    tx.pot.update.mockResolvedValue({});
    tx.user.update.mockResolvedValue({});
    tx.ledgerEntry.create.mockResolvedValue({});
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await settleIntent('intent-1', 7000); // spent 7000, reserved 10000 → surplus 3000

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { mainBalance: { increment: 3000 } },
    });
  });

  it('does not update balance when no surplus', async () => {
    const tx = makeTxMock();
    tx.pot.findUnique.mockResolvedValue({
      id: 'pot-1',
      userId: 'user-1',
      reservedAmount: 5000,
      status: 'ACTIVE',
    });
    tx.pot.update.mockResolvedValue({});
    tx.ledgerEntry.create.mockResolvedValue({});
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await settleIntent('intent-1', 5000);

    expect(tx.user.update).not.toHaveBeenCalled();
  });
});

describe('returnIntent', () => {
  it('returns full reserved amount to mainBalance', async () => {
    const tx = makeTxMock();
    tx.pot.findUnique.mockResolvedValue({
      id: 'pot-1',
      userId: 'user-1',
      reservedAmount: 8000,
      status: 'ACTIVE',
    });
    tx.user.update.mockResolvedValue({});
    tx.pot.update.mockResolvedValue({});
    tx.ledgerEntry.create.mockResolvedValue({});
    (mockPrisma.$transaction as jest.Mock).mockImplementation(async (fn: Function) => fn(tx));

    await returnIntent('intent-1');

    expect(tx.user.update).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { mainBalance: { increment: 8000 } },
    });
  });
});
