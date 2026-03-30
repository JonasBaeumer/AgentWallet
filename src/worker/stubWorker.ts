import 'dotenv/config';
import { createSearchWorker } from './processors/searchProcessor';
import { createCheckoutWorker } from './processors/checkoutProcessor';
import { createCancelCardWorker } from './processors/cancelCardProcessor';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'worker/stubWorker' });

log.info('Starting stub worker...');

const searchWorker = createSearchWorker();
const checkoutWorker = createCheckoutWorker();
const cancelCardWorker = createCancelCardWorker();

searchWorker.on('completed', (job) => {
  log.info({ jobId: job.id }, 'Search job completed');
});
searchWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Search job failed');
});

checkoutWorker.on('completed', (job) => {
  log.info({ jobId: job.id }, 'Checkout job completed');
});
checkoutWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Checkout job failed');
});

cancelCardWorker.on('completed', (job) => {
  log.info({ jobId: job.id }, 'Cancel card job completed');
});
cancelCardWorker.on('failed', (job, err) => {
  log.error({ jobId: job?.id, err }, 'Cancel card job failed');
});

log.info('Stub worker running — listening on search-queue, checkout-queue and cancel-card-queue');

// Graceful shutdown
process.on('SIGTERM', async () => {
  await searchWorker.close();
  await checkoutWorker.close();
  await cancelCardWorker.close();
  process.exit(0);
});
process.on('SIGINT', async () => {
  await searchWorker.close();
  await checkoutWorker.close();
  await cancelCardWorker.close();
  process.exit(0);
});
