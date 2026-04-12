import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '@/db/client';

export async function idempotencyMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const idempotencyKey = request.headers['x-idempotency-key'] as string | undefined;
  if (!idempotencyKey) return; // not required for all routes, just skip

  const existing = await prisma.idempotencyRecord.findUnique({ where: { key: idempotencyKey } });
  if (existing) {
    reply.status(200).send(existing.responseBody);
    return;
  }

  // Attach key to request for handler to use
  (request as FastifyRequest & { idempotencyKey?: string }).idempotencyKey = idempotencyKey;
}

export async function saveIdempotencyResponse(key: string, responseBody: unknown): Promise<void> {
  await prisma.idempotencyRecord.upsert({
    where: { key },
    update: {},
    create: { key, responseBody: responseBody as any },
  });
}
