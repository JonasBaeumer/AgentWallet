/**
 * Privacy.com webhook handler.
 *
 * ⚠️ The exact signature scheme is NOT clearly documented in Privacy's public
 * API docs. This implementation uses HMAC-SHA256 over the raw request body,
 * compared against a header configurable via PRIVACY_WEBHOOK_SIGNATURE_HEADER
 * (default `x-privacy-signature`). Before going live, verify the scheme
 * against the webhook config shown in the Privacy.com dashboard and adjust
 * if needed.
 *
 * Privacy's delivery format appears to be the raw `Transaction` JSON object
 * (not a Stripe-style `{type, data}` envelope), per the developer docs.
 */
import crypto from 'crypto';
import { env } from '@/config/env';
import { prisma } from '@/db/client';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'payments/privacy/webhookHandler' });

export interface PrivacyTransactionEvent {
  token?: string;
  card_token?: string;
  amount?: number;
  status?: string;
  result?: string;
  // Privacy's Transaction object has more fields; we only touch these for now.
  [key: string]: unknown;
}

function verifySignature(rawBody: Buffer | string, signature: string): boolean {
  if (!signature) return false;
  const bodyBytes = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : rawBody;
  const expected = crypto
    .createHmac('sha256', env.PRIVACY_WEBHOOK_SECRET)
    .update(bodyBytes)
    .digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'));
  } catch {
    return false;
  }
}

export async function handlePrivacyEvent(
  rawBody: Buffer | string,
  signature: string,
): Promise<Record<string, unknown>> {
  if (!verifySignature(rawBody, signature)) {
    throw new Error('Privacy.com webhook signature verification failed');
  }

  const payload = JSON.parse(
    typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'),
  ) as PrivacyTransactionEvent;

  // Correlate back to our intent via the card_token we stored on the VirtualCard.
  const cardToken = payload.card_token;
  if (!cardToken) {
    log.warn({ payload }, 'Privacy webhook missing card_token — skipping correlation');
    return { received: true };
  }

  const virtualCard = await prisma.virtualCard.findUnique({
    where: { providerCardId: cardToken },
    select: { intentId: true },
  });
  if (!virtualCard) {
    log.warn({ cardToken }, 'Privacy webhook for unknown card_token');
    return { received: true };
  }

  await prisma.auditEvent.create({
    data: {
      intentId: virtualCard.intentId,
      actor: 'privacy_com',
      event: 'PRIVACY_TRANSACTION',
      payload: payload as never,
    },
  });

  return { received: true };
}
