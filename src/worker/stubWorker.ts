import 'dotenv/config';
import { createSearchWorker } from './processors/searchProcessor';
import { createCheckoutWorker } from './processors/checkoutProcessor';
import { createCancelCardWorker } from './processors/cancelCardProcessor';

console.log(JSON.stringify({ level: 'info', message: 'Starting stub worker...' }));

const searchWorker = createSearchWorker();
const checkoutWorker = createCheckoutWorker();
const cancelCardWorker = createCancelCardWorker();

searchWorker.on('completed', (job) => {
  console.log(JSON.stringify({ level: 'info', message: 'Search job completed', jobId: job.id }));
});
searchWorker.on('failed', (job, err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Search job failed', jobId: job?.id, error: String(err) }));
});

checkoutWorker.on('completed', (job) => {
  console.log(JSON.stringify({ level: 'info', message: 'Checkout job completed', jobId: job.id }));
});
checkoutWorker.on('failed', (job, err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Checkout job failed', jobId: job?.id, error: String(err) }));
});

cancelCardWorker.on('completed', (job) => {
  console.log(JSON.stringify({ level: 'info', message: 'Cancel card job completed', jobId: job.id }));
});
cancelCardWorker.on('failed', (job, err) => {
  console.error(JSON.stringify({ level: 'error', message: 'Cancel card job failed', jobId: job?.id, error: String(err) }));
});

console.log(JSON.stringify({ level: 'info', message: 'Stub worker running — listening on search-queue, checkout-queue and cancel-card-queue' }));

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
