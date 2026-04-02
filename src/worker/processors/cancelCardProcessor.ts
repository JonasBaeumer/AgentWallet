import { Worker, Job } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { getPaymentProvider } from '@/payments';
import { CancelCardJob, QUEUE_NAMES } from '@/contracts';

export function createCancelCardWorker(): Worker {
  return new Worker(
    QUEUE_NAMES.CANCEL_CARD,
    async (job: Job<CancelCardJob>) => {
      const { intentId } = job.data;
      console.log(JSON.stringify({ level: 'info', message: 'Processing cancel card job', intentId }));

      await getPaymentProvider().cancelCard(intentId);

      console.log(JSON.stringify({ level: 'info', message: 'Card cancelled via AFTER_TTL policy', intentId }));
    },
    { connection: getRedisConnectionConfig(), concurrency: 10 },
  );
}
