import { Queue } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { QUEUE_NAMES } from '@/contracts';

export const searchQueue = new Queue(QUEUE_NAMES.SEARCH, {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const checkoutQueue = new Queue(QUEUE_NAMES.CHECKOUT, {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});

export const cancelCardQueue = new Queue(QUEUE_NAMES.CANCEL_CARD, {
  connection: getRedisConnectionConfig(),
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 100,
    removeOnFail: 200,
  },
});
