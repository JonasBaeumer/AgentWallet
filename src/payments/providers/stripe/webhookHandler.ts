import Stripe from 'stripe';
import { getStripeClient } from './stripeClient';
import { prisma } from '@/db/client';
import { reconcileIntent } from './reconciliationService';

export async function handleStripeEvent(rawBody: Buffer | string, signature: string): Promise<Record<string, unknown>> {
  const stripe = getStripeClient();
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET not set');

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', message: 'Invalid Stripe webhook signature', error: String(err) }));
    throw new Error(`Webhook signature verification failed: ${String(err)}`);
  }

  const intentId: string = (event.data.object as any)?.metadata?.intentId ?? 'unknown';

  switch (event.type) {
    case 'issuing_authorization.request': {
      // Return { approved: true } in the response body — the approve/decline
      // endpoints are deprecated; Stripe now reads the decision from the HTTP
      // response body within the 2-second window.
      const auth = event.data.object as Stripe.Issuing.Authorization;
      await logAuditEvent(intentId, 'STRIPE_AUTHORIZATION_REQUEST', { authId: auth.id, amount: auth.amount });
      return { approved: true };
    }

    case 'issuing_authorization.created': {
      const auth = event.data.object as Stripe.Issuing.Authorization;
      await logAuditEvent(intentId, 'STRIPE_AUTHORIZATION_CREATED', { authId: auth.id, amount: auth.amount });
      break;
    }

    case 'issuing_transaction.created': {
      const txn = event.data.object as Stripe.Issuing.Transaction;
      await logAuditEvent(intentId, 'STRIPE_TRANSACTION_CREATED', { transactionId: txn.id, amount: txn.amount });
      // Fire-and-forget reconciliation — discrepancy failure must not break webhook
      reconcileIntent(intentId).then(async (report) => {
        if (!report.inSync) {
          await logAuditEvent(intentId, 'RECONCILIATION_DISCREPANCY', { discrepancies: report.discrepancies, report });
        }
      }).catch((err) => {
        console.error(JSON.stringify({ level: 'error', message: 'Reconciliation failed', intentId, error: String(err) }));
      });
      break;
    }

    default:
      console.log(JSON.stringify({ level: 'info', message: 'Unhandled Stripe event', type: event.type }));
  }

  return { received: true };
}

async function logAuditEvent(intentId: string, eventName: string, payload: Record<string, unknown>): Promise<void> {
  try {
    if (intentId === 'unknown') return;
    await prisma.auditEvent.create({
      data: { intentId, actor: 'stripe', event: eventName, payload: payload as any },
    });
  } catch {
    // Don't let audit logging failure break webhook processing
  }
}
