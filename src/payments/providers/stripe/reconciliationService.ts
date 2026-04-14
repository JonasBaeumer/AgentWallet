import { getStripeClient } from './stripeClient';
import { prisma } from '@/db/client';
import type { ReconciliationReport } from '@/contracts';

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

  if (!card) {
    return { intentId, internal, stripe: null, inSync: true, discrepancies: [] };
  }

  const stripe = getStripeClient();
  const stripeCard = await stripe.issuing.cards.retrieve(card.stripeCardId);
  const txList = await stripe.issuing.transactions.list({
    card: card.stripeCardId,
    type: 'capture',
  });

  const totalCaptured = txList.data.reduce((sum, t) => sum + t.amount, 0);
  const stripeReport = {
    cardStatus: stripeCard.status,
    transactions: txList.data.map((t) => ({ id: t.id, amount: t.amount, type: t.type })),
    totalCaptured,
  };

  const discrepancies: string[] = [];
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
