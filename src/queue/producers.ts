import { searchQueue, checkoutQueue, cancelCardQueue } from './queues';
import { JOB_NAMES } from './jobTypes';
import { SearchIntentJob, CheckoutIntentJob } from '@/contracts';

export async function enqueueSearch(intentId: string, payload: SearchIntentJob): Promise<void> {
  await searchQueue.add(JOB_NAMES.SEARCH_INTENT, payload, {
    jobId: intentId, // deduplication by intentId
  });
  console.log(JSON.stringify({ level: 'info', message: 'Enqueued search job', intentId }));
}

export async function enqueueCheckout(intentId: string, payload: CheckoutIntentJob): Promise<void> {
  await checkoutQueue.add(JOB_NAMES.CHECKOUT_INTENT, payload, {
    jobId: intentId, // deduplication by intentId
  });
  console.log(JSON.stringify({ level: 'info', message: 'Enqueued checkout job', intentId }));
}

export async function enqueueCancelCard(intentId: string, delayMs: number): Promise<void> {
  await cancelCardQueue.add(
    JOB_NAMES.CANCEL_CARD,
    { intentId },
    { jobId: `cancel-${intentId}`, delay: delayMs },
  );
  console.log(JSON.stringify({ level: 'info', message: 'Enqueued cancel card job', intentId, delayMs }));
}
