import { Worker, Job } from 'bullmq';
import { getRedisConnectionConfig } from '@/config/redis';
import { SearchIntentJob } from '@/contracts';
import { logger } from '@/config/logger';

const log = logger.child({ module: 'worker/processors/searchProcessor' });

const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';
const AGENT_KEY = process.env.OPENCLAW_AGENT_KEY;

export function createSearchWorker(): Worker {
  return new Worker(
    'search-queue',
    async (job: Job<SearchIntentJob>) => {
      const { intentId, maxBudget, currency } = job.data;
      log.info({ intentId }, 'Processing search job');

      if (!AGENT_KEY) {
        throw new Error('OPENCLAW_AGENT_KEY is required by the stub search worker');
      }

      // Post a stub quote immediately
      const response = await fetch(`${API_BASE}/v1/agent/quote`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Agent-Key': AGENT_KEY,
        },
        body: JSON.stringify({
          intentId,
          merchantName: 'Amazon UK',
          merchantUrl: 'https://amazon.co.uk/stub',
          price: Math.min(maxBudget, maxBudget), // Use the full budget as stub price
          currency,
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        log.warn({ intentId, status: response.status, body }, 'Quote post failed');
        // Don't throw — intent may already be in AWAITING_APPROVAL or later
        return;
      }

      log.info({ intentId }, 'Search job completed — quote posted');
    },
    { connection: getRedisConnectionConfig(), concurrency: 5 },
  );
}
