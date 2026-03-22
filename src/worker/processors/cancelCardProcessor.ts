import { Worker, Job } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { getPaymentProvider } from '@/payments';

interface CancelCardJob {
  intentId: string;
}

export function createCancelCardWorker(): Worker {
  return new Worker(
    'cancel-card-queue',
    async (job: Job<CancelCardJob>) => {
      const { intentId } = job.data;
      console.log(JSON.stringify({ level: 'info', message: 'Processing cancel card job', intentId }));

      await getPaymentProvider().cancelCard(intentId);

      console.log(JSON.stringify({ level: 'info', message: 'Card cancelled via AFTER_TTL policy', intentId }));
    },
    { connection: getRedisConnectionConfig(), concurrency: 10 },
  );
}
