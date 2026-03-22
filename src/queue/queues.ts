import { Queue } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';

export const searchQueue = new Queue('search-queue', {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const checkoutQueue = new Queue('checkout-queue', {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const cancelCardQueue = new Queue('cancel-card-queue', {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
