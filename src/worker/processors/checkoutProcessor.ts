import { Worker, Job } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { CheckoutIntentJob } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'worker/processors/checkoutProcessor' });

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';
const WORKER_KEY = process.env.WORKER_API_KEY || 'local-dev-worker-key';

export function createCheckoutWorker(): Worker {
  return new Worker(
    'checkout-queue',
    async (job: Job<CheckoutIntentJob>) => {
      const { intentId, price } = job.data;
      log.info({ intentId }, 'Processing checkout job');

      // Simulate checkout work
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Post result
      const response = await fetch(`${API_BASE}/v1/agent/result`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Worker-Key': WORKER_KEY,
        },
        body: JSON.stringify({
          intentId,
          success: true,
          actualAmount: price,
          receiptUrl: `https://amazon.co.uk/receipt/stub-${intentId}`,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        log.error({ intentId, status: response.status, body }, 'Result post failed');
        throw new Error(`Failed to post result: ${response.status}`);
      }

      log.info({ intentId }, 'Checkout job completed');
    },
    { connection: getRedisConnectionConfig(), concurrency: 5 },
  );
}
