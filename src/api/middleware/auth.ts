import { FastifyRequest, FastifyReply } from 'fastify';
import { env } from '@/config/env';

export async function workerAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const workerKey = request.headers['x-worker-key'];
  if (!workerKey || workerKey !== env.WORKER_API_KEY) {
    reply.status(401).send({ error: 'Unauthorized: invalid or missing X-Worker-Key' });
  }
}
