import { prisma } from '@/db/client';
import {
  VirtualCardData,
  CardReveal,
  CardAlreadyRevealedError,
  IntentNotFoundError,
  UnsupportedProviderOperationError,
  PaymentProvider,
} from '@/contracts';
import { logger } from '@/config/logger';
import { createCard, updateCard, PrivacyApiError } from './privacyClient';
import { store, takeOnce } from './revealCache';

const log = logger.child({ module: 'payments/privacy/cardService' });

/**
 * Issue a SINGLE_USE Privacy.com card for the given intent.
 *
 * Privacy.com has no idempotency-key header, so we dedupe client-side: if a
 * VirtualCard row already exists for this intent, return it unchanged.
 */
export async function issueVirtualCard(intentId: string, amount: number): Promise<VirtualCardData> {
  const intent = await prisma.purchaseIntent.findUnique({ where: { id: intentId } });
  if (!intent) throw new IntentNotFoundError(intentId);

  // Client-side idempotency: Privacy.com has no Idempotency-Key header.
  const existing = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (existing) return existing as unknown as VirtualCardData;

  let card;
  try {
    card = await createCard({
      type: 'SINGLE_USE',
      memo: (intent.subject ?? intent.query).slice(0, 50),
      spend_limit: amount,
      spend_limit_duration: 'TRANSACTION',
      state: 'OPEN',
    });
  } catch (err) {
    if (err instanceof PrivacyApiError) {
      log.error({ intentId, status: err.status }, 'Privacy.com card creation failed');
    }
    throw err;
  }

  // Cache PAN/CVV in process memory for the subsequent revealCard call.
  // Never persisted to the DB (PCI scope).
  store(intentId, {
    number: card.pan,
    cvc: card.cvv,
    expMonth: parseInt(card.exp_month, 10),
    expYear: parseInt(card.exp_year, 10),
    last4: card.last_four,
  });

  const virtualCard = await prisma.virtualCard.create({
    data: {
      intentId,
      providerCardId: card.token,
      last4: card.last_four,
    },
  });

  return virtualCard as unknown as VirtualCardData;
}

export async function revealCard(intentId: string): Promise<CardReveal> {
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!card) throw new IntentNotFoundError(intentId);
  if (card.revealedAt) throw new CardAlreadyRevealedError(intentId);

  const reveal = takeOnce(intentId);
  if (!reveal) {
    // Cache miss: server restart, TTL expired, or the intent was issued on a
    // different node. Privacy.com doesn't let us re-retrieve PAN server-side,
    // so the card is effectively unreachable from this side.
    throw new Error(
      `Privacy.com card reveal cache miss for intent ${intentId} — card is no longer retrievable`,
    );
  }

  await prisma.virtualCard.update({
    where: { intentId },
    data: { revealedAt: new Date() },
  });

  return reveal;
}

export async function freezeCard(_intentId: string): Promise<void> {
  // Privacy.com's SINGLE_USE cards don't support pausing — the card either
  // has unused spend and is OPEN, or has been used and is CLOSED.
  throw new UnsupportedProviderOperationError(PaymentProvider.PRIVACY_COM, 'freezeCard');
}

/**
 * Best-effort cancel. Privacy.com SINGLE_USE cards self-close after the first
 * transaction; calling PATCH /cards/{token} {state: CLOSED} on an already-
 * closed card returns an error that we swallow.
 */
export async function cancelCard(intentId: string): Promise<void> {
  const card = await prisma.virtualCard.findUnique({ where: { intentId } });
  if (!card) throw new IntentNotFoundError(intentId);
  if (card.cancelledAt) return;

  try {
    await updateCard(card.providerCardId, { state: 'CLOSED' });
  } catch (err) {
    if (err instanceof PrivacyApiError) {
      // Already closed (self-closed after use) — not an error from our side.
      log.warn(
        { intentId, status: err.status },
        'Privacy.com card close failed — likely already closed',
      );
    } else {
      throw err;
    }
  }

  await prisma.virtualCard.update({
    where: { intentId },
    data: { cancelledAt: new Date() },
  });
}
