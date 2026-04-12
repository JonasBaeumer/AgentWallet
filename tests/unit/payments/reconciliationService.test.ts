// Mock stripe before imports
const mockStripe = {
  issuing: {
    cards: { retrieve: jest.fn() },
    transactions: { list: jest.fn() },
  },
};
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => mockStripe,
}));

// Mock prisma before imports
const mockPot = jest.fn();
const mockLedgerEntries = jest.fn();
const mockVirtualCard = jest.fn();
jest.mock('@/db/client', () => ({
  prisma: {
    pot: { findUnique: (...args: any[]) => mockPot(...args) },
    ledgerEntry: { findMany: (...args: any[]) => mockLedgerEntries(...args) },
    virtualCard: { findUnique: (...args: any[]) => mockVirtualCard(...args) },
  },
}));

import { reconcileIntent } from '@/payments/providers/stripe/reconciliationService';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('reconcileIntent', () => {
  it('returns inSync:true when settledAmount matches stripe captured and card is canceled', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([
      { type: 'RESERVE', amount: 5000 },
      { type: 'SETTLE', amount: 3500 },
    ]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-1', stripeCardId: 'ic_123' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockStripe.issuing.transactions.list.mockResolvedValue({
      data: [{ id: 'itxn_1', amount: 3500, type: 'capture' }],
    });

    const report = await reconcileIntent('intent-1');

    expect(report.inSync).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
    expect(report.stripe?.totalCaptured).toBe(3500);
  });

  it('returns inSync:false with discrepancy when settledAmount differs from stripe captured', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-2', stripeCardId: 'ic_456' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockStripe.issuing.transactions.list.mockResolvedValue({
      data: [{ id: 'itxn_2', amount: 4000, type: 'capture' }],
    });

    const report = await reconcileIntent('intent-2');

    expect(report.inSync).toBe(false);
    expect(report.discrepancies).toContain('settledAmount 3500 != stripe captured 4000');
  });

  it('returns inSync:false with discrepancy when pot is SETTLED but card is still active', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-3', stripeCardId: 'ic_789' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'active' });
    mockStripe.issuing.transactions.list.mockResolvedValue({
      data: [{ id: 'itxn_3', amount: 3500, type: 'capture' }],
    });

    const report = await reconcileIntent('intent-3');

    expect(report.inSync).toBe(false);
    expect(
      report.discrepancies.some((d) => d.includes('expects card canceled but got active')),
    ).toBe(true);
  });

  it('returns stripe:null and inSync:true when no VirtualCard exists', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 0, status: 'ACTIVE' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-4');

    expect(report.stripe).toBeNull();
    expect(report.inSync).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
    expect(mockStripe.issuing.cards.retrieve).not.toHaveBeenCalled();
  });

  it('returns potStatus:null and inSync:true when no Pot exists', async () => {
    mockPot.mockResolvedValue(null);
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-5');

    expect(report.internal.potStatus).toBeNull();
    expect(report.internal.reserved).toBe(0);
    expect(report.internal.settled).toBe(0);
    expect(report.inSync).toBe(true);
  });
});
