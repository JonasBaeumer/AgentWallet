import { Worker, Job, UnrecoverableError } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { getProviderForIntent } from '@/payments';
import { IntentNotFoundError } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'worker/processors/cancelCardProcessor' });

interface CancelCardJob {
  intentId: string;
}

/**
 * Pure job handler — exported so unit tests can drive it without standing up
 * a real BullMQ Worker (which would require Redis). Keeping this separate from
 * the Worker factory also means the retry / failure semantics are explicit
 * and easy to reason about.
 */
export async function handleCancelCardJob(job: Job<CancelCardJob>): Promise<void> {
  const { intentId } = job.data;
  log.info({ intentId, attempt: job.attemptsMade + 1 }, 'Processing cancel card job');

  try {
    const provider = await getProviderForIntent(intentId);
    await provider.cancelCard(intentId);
    log.info({ intentId }, 'Card cancelled via AFTER_TTL policy');
  } catch (err) {
    // If the intent no longer exists (already cancelled, manually cleaned up,
    // etc.) further retries cannot succeed. Mark the job unrecoverable so
    // BullMQ stops retrying instead of burning through all attempts.
    if (err instanceof IntentNotFoundError) {
      log.warn({ intentId, err }, 'Cancel card job: intent not found — marking unrecoverable');
      throw new UnrecoverableError(`Intent ${intentId} not found during AFTER_TTL cancel`);
    }

    // All other failures (Stripe 5xx, DB unreachable, …) are retried using
    // the queue's configured exponential backoff. Log with full context so
    // on-call engineers can diagnose.
    log.error(
      { intentId, attempt: job.attemptsMade + 1, err },
      'Cancel card job failed — BullMQ will retry',
    );
    throw err;
  }
}

export function createCancelCardWorker(): Worker {
  const worker = new Worker<CancelCardJob>('cancel-card-queue', handleCancelCardJob, {
    connection: getRedisConnectionConfig(),
    concurrency: 10,
  });

  worker.on('failed', (job, err) => {
    if (!job) {
      log.error({ err }, 'Cancel card job failed without job context');
      return;
    }
    const exhausted = job.attemptsMade >= (job.opts.attempts ?? 1);
    // A permanently-live virtual card is a real money leak — escalate loudly
    // when all retries are exhausted so operators can intervene manually.
    log.error(
      {
        intentId: job.data.intentId,
        attemptsMade: job.attemptsMade,
        maxAttempts: job.opts.attempts,
        exhausted,
        err,
      },
      exhausted
        ? 'Cancel card job exhausted retries — card may remain active, manual intervention required'
        : 'Cancel card job attempt failed',
    );
  });

  worker.on('error', (err) => {
    log.error({ err }, 'Cancel card worker error');
  });

  return worker;
}
