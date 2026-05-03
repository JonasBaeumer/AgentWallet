import { getStripeClient } from './stripeClient';
import { prisma } from '@/db/client';
import { logger } from '@/config/logger';
import type { ReconciliationReport } from '@/contracts';

const log = logger.child({ module: 'payments/stripe/reconciliationService' });

// Safety cap for stripe.issuing.transactions.list pagination. A single intent
// shouldn't generate anywhere near this many transactions; the cap prevents
// unbounded memory use if a metadata mistake points many transactions at the
// same card.
const MAX_TRANSACTIONS = 1000;

export async function reconcileIntent(intentId: string): Promise<ReconciliationReport> {
  const pot = await prisma.pot.findUnique({ where: { intentId } });
  const entries = await prisma.ledgerEntry.findMany({ where: { intentId } });
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });

  const internal = {
    reserved: pot?.reservedAmount ?? 0,
    settled: pot?.settledAmount ?? 0,
    potStatus: pot?.status ?? null,
    ledgerEntries: entries.map((e) => `${e.type}:${e.amount}`),
  };

  // No DB virtual card. The previous behaviour was to return inSync:true
  // unconditionally — that's a false clean signal whenever the pot shows that
  // money already moved (settled/returned) without a card record on file.
  if (!card) {
    const discrepancies: string[] = [];
    const moneyMoved =
      pot !== null &&
      (pot.settledAmount > 0 || pot.status === 'SETTLED' || pot.status === 'RETURNED');
    if (moneyMoved) {
      discrepancies.push(
        `virtualCard missing for intent with pot status ${pot!.status} (settledAmount ${pot!.settledAmount})`,
      );
    }
    return {
      intentId,
      internal,
      stripe: null,
      inSync: discrepancies.length === 0,
      discrepancies,
    };
  }

  const stripe = getStripeClient();

  // Wrap the Stripe calls so a 404/429/network blip surfaces as a structured
  // discrepancy instead of an unhandled exception. The webhook caller's outer
  // catch already swallows throws silently — we want the audit trail.
  let stripeCard;
  let transactions;
  try {
    stripeCard = await stripe.issuing.cards.retrieve(card.providerCardId);
    transactions = await stripe.issuing.transactions
      .list({ card: card.providerCardId })
      .autoPagingToArray({ limit: MAX_TRANSACTIONS });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      { intentId, providerCardId: card.providerCardId, err },
      'Stripe API call failed during reconciliation',
    );
    return {
      intentId,
      internal,
      stripe: null,
      inSync: false,
      discrepancies: [`stripe API error: ${message}`],
    };
  }

  // Net captured = sum of capture-side amounts minus refunds.
  // Stripe Issuing returns capture amounts as NEGATIVE integers (the
  // cardholder's balance decreases) and refund/return amounts as POSITIVE.
  // The previous code summed `t.amount` directly, which produced a negative
  // total that never matched the positive `settledAmount` — every reconcile
  // run reported a discrepancy. Using Math.abs and sign-correcting by type
  // gives the comparable positive net.
  let totalCaptured = 0;
  for (const t of transactions) {
    const abs = Math.abs(t.amount);
    if (t.type === 'refund') {
      totalCaptured -= abs;
    } else {
      totalCaptured += abs;
    }
  }

  const stripeReport = {
    cardStatus: stripeCard.status,
    transactions: transactions.map((t) => ({ id: t.id, amount: t.amount, type: t.type })),
    totalCaptured,
  };

  const discrepancies: string[] = [];

  if (transactions.length >= MAX_TRANSACTIONS) {
    discrepancies.push(
      `stripe transactions truncated at ${MAX_TRANSACTIONS} — totalCaptured may be incomplete`,
    );
  }

  if (pot !== null && pot.settledAmount !== totalCaptured) {
    discrepancies.push(`settledAmount ${pot.settledAmount} != stripe captured ${totalCaptured}`);
  }

  const expectedCardStatus =
    pot?.status === 'SETTLED' || pot?.status === 'RETURNED' ? 'canceled' : 'active';
  if (stripeCard.status !== expectedCardStatus) {
    discrepancies.push(
      `pot status ${pot?.status} expects card ${expectedCardStatus} but got ${stripeCard.status}`,
    );
  }

  return {
    intentId,
    internal,
    stripe: stripeReport,
    inSync: discrepancies.length === 0,
    discrepancies,
  };
}
