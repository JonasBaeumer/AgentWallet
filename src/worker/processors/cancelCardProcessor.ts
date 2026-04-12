import { Worker, Job } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { getPaymentProvider } from '@/payments';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'worker/processors/cancelCardProcessor' });

interface CancelCardJob {
  intentId: string;
}

export function createCancelCardWorker(): Worker {
  return new Worker(
    'cancel-card-queue',
    async (job: Job<CancelCardJob>) => {
      const { intentId } = job.data;
      log.info({ intentId }, 'Processing cancel card job');

      await getPaymentProvider().cancelCard(intentId);

      log.info({ intentId }, 'Card cancelled via AFTER_TTL policy');
    },
    { connection: getRedisConnectionConfig(), concurrency: 10 },
  );
}
