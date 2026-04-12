import { searchQueue, checkoutQueue, cancelCardQueue } from './queues';
import { JOB_NAMES } from './jobTypes';
import { SearchIntentJob, CheckoutIntentJob } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'queue/producers' });

export async function enqueueSearch(intentId: string, payload: SearchIntentJob): Promise<void> {
  await searchQueue.add(JOB_NAMES.SEARCH_INTENT, payload, {
    jobId: intentId, // deduplication by intentId
  });
  log.info({ intentId }, 'Enqueued search job');
}

export async function enqueueCheckout(intentId: string, payload: CheckoutIntentJob): Promise<void> {
  await checkoutQueue.add(JOB_NAMES.CHECKOUT_INTENT, payload, {
    jobId: intentId, // deduplication by intentId
  });
  log.info({ intentId }, 'Enqueued checkout job');
}

export async function enqueueCancelCard(intentId: string, delayMs: number): Promise<void> {
  await cancelCardQueue.add(
    JOB_NAMES.CANCEL_CARD,
    { intentId },
    { jobId: `cancel-${intentId}`, delay: delayMs },
  );
  log.info({ intentId, delayMs }, 'Enqueued cancel card job');
}
