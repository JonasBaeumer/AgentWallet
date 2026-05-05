const mockAutoPagingToArray = jest.fn();
const mockTransactionsList = jest.fn(() => ({ autoPagingToArray: mockAutoPagingToArray }));
const mockStripe = {
  issuing: {
    cards: { retrieve: jest.fn() },
    transactions: { list: mockTransactionsList },
  },
};
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => mockStripe,
}));

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

const mockChildLogger = {
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
};
jest.mock('@/config/logger', () => ({
  logger: { child: jest.fn(() => mockChildLogger) },
}));

import { reconcileIntent } from '@/payments/providers/stripe/reconciliationService';

beforeEach(() => {
  jest.clearAllMocks();
  mockChildLogger.error.mockClear();
});

describe('reconcileIntent — capture amount sign handling (issue #88)', () => {
  it('treats Stripe-style negative capture amounts as positive captured totals', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([{ type: 'SETTLE', amount: 3500 }]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-1', providerCardId: 'ic_neg' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockResolvedValue([{ id: 'itxn_1', amount: -3500, type: 'capture' }]);

    const report = await reconcileIntent('intent-1');

    expect(report.stripe?.totalCaptured).toBe(3500);
    expect(report.inSync).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('flags a real settlement mismatch', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-2', providerCardId: 'ic_mis' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockResolvedValue([{ id: 'itxn_2', amount: -4000, type: 'capture' }]);

    const report = await reconcileIntent('intent-2');

    expect(report.inSync).toBe(false);
    expect(report.discrepancies).toContain('settledAmount 3500 != stripe captured 4000');
  });
});

describe('reconcileIntent — refunds (issue #88)', () => {
  it('subtracts refund transactions from the net captured total', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3000, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([{ type: 'SETTLE', amount: 3000 }]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-3', providerCardId: 'ic_refund' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockResolvedValue([
      { id: 'itxn_cap', amount: -4000, type: 'capture' },
      { id: 'itxn_ref', amount: 1000, type: 'refund' },
    ]);

    const report = await reconcileIntent('intent-3');

    expect(report.stripe?.totalCaptured).toBe(3000);
    expect(report.inSync).toBe(true);
  });
});

describe('reconcileIntent — Stripe API error handling (issue #88)', () => {
  it('returns a discrepancy report instead of throwing when cards.retrieve fails', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-err', providerCardId: 'ic_404' });
    mockStripe.issuing.cards.retrieve.mockRejectedValue(new Error('No such card: ic_404'));

    const report = await reconcileIntent('intent-err');

    expect(report.inSync).toBe(false);
    expect(report.stripe).toBeNull();
    expect(report.discrepancies[0]).toContain('stripe API error');
    expect(mockChildLogger.error).toHaveBeenCalled();
  });

  it('returns a discrepancy report when transactions.list paging fails', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-429', providerCardId: 'ic_429' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockRejectedValue(new Error('Too many requests'));

    const report = await reconcileIntent('intent-429');

    expect(report.inSync).toBe(false);
    expect(report.stripe).toBeNull();
    expect(report.discrepancies[0]).toContain('Too many requests');
  });
});

describe('reconcileIntent — pagination (issue #88)', () => {
  it('uses autoPagingToArray with a safety cap', async () => {
    const txs = Array.from({ length: 250 }, (_, i) => ({
      id: `itxn_${i}`,
      amount: -10,
      type: 'capture',
    }));
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 2500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-page', providerCardId: 'ic_page' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockResolvedValue(txs);

    const report = await reconcileIntent('intent-page');

    expect(mockAutoPagingToArray).toHaveBeenCalledWith({ limit: 1000 });
    expect(report.stripe?.totalCaptured).toBe(2500);
    expect(report.inSync).toBe(true);
  });

  it('flags a discrepancy when the safety cap is hit', async () => {
    const txs = Array.from({ length: 1000 }, (_, i) => ({
      id: `itxn_${i}`,
      amount: -1,
      type: 'capture',
    }));
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 1000, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-cap', providerCardId: 'ic_cap' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'canceled' });
    mockAutoPagingToArray.mockResolvedValue(txs);

    const report = await reconcileIntent('intent-cap');

    expect(report.inSync).toBe(false);
    expect(report.discrepancies.some((d) => d.includes('truncated at 1000'))).toBe(true);
  });
});

describe('reconcileIntent — missing virtualCard (issue #88)', () => {
  it('returns inSync:true when neither pot nor card exists', async () => {
    mockPot.mockResolvedValue(null);
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-empty');

    expect(report.stripe).toBeNull();
    expect(report.inSync).toBe(true);
    expect(mockStripe.issuing.cards.retrieve).not.toHaveBeenCalled();
  });

  it('returns inSync:true when pot is ACTIVE with no settled funds (in-flight)', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 0, status: 'ACTIVE' });
    mockLedgerEntries.mockResolvedValue([{ type: 'RESERVE', amount: 5000 }]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-inflight');

    expect(report.inSync).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  it('returns inSync:false when pot is SETTLED but no virtualCard record exists', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([{ type: 'SETTLE', amount: 3500 }]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-orphaned-pot');

    expect(report.inSync).toBe(false);
    expect(
      report.discrepancies.some((d) => d.includes('virtualCard missing') && d.includes('SETTLED')),
    ).toBe(true);
  });
});

describe('reconcileIntent — card status', () => {
  it('reports a discrepancy when pot is SETTLED but Stripe card is still active', async () => {
    mockPot.mockResolvedValue({ reservedAmount: 5000, settledAmount: 3500, status: 'SETTLED' });
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue({ intentId: 'intent-status', providerCardId: 'ic_active' });
    mockStripe.issuing.cards.retrieve.mockResolvedValue({ status: 'active' });
    mockAutoPagingToArray.mockResolvedValue([{ id: 'itxn_x', amount: -3500, type: 'capture' }]);

    const report = await reconcileIntent('intent-status');

    expect(report.inSync).toBe(false);
    expect(
      report.discrepancies.some((d) => d.includes('expects card canceled but got active')),
    ).toBe(true);
  });
});

describe('reconcileIntent — internal report fields', () => {
  it('reports zero balances and null potStatus when no pot exists', async () => {
    mockPot.mockResolvedValue(null);
    mockLedgerEntries.mockResolvedValue([]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-no-pot');

    expect(report.internal.potStatus).toBeNull();
    expect(report.internal.reserved).toBe(0);
    expect(report.internal.settled).toBe(0);
    expect(report.inSync).toBe(true);
  });

  it('serialises ledger entries into "TYPE:amount" strings', async () => {
    mockPot.mockResolvedValue(null);
    mockLedgerEntries.mockResolvedValue([
      { type: 'RESERVE', amount: 5000 },
      { type: 'SETTLE', amount: 3500 },
    ]);
    mockVirtualCard.mockResolvedValue(null);

    const report = await reconcileIntent('intent-ledger');

    expect(report.internal.ledgerEntries).toEqual(['RESERVE:5000', 'SETTLE:3500']);
  });
});
