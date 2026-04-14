import { FastifyRequest, FastifyReply } from 'fastify';
import bcrypt from 'bcryptjs';
import { prisma } from '@/db/client';

declare module 'fastify' {
  interface FastifyRequest {
    user?: import('@prisma/client').User;
  }
}

export async function userAuthMiddleware(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const authHeader = request.headers['authorization'];
  if (!authHeader?.startsWith('Bearer ')) {
    return reply
      .status(401)
      .header('WWW-Authenticate', 'Bearer realm="agentpay"')
      .send({ error: 'Unauthorized: missing or invalid Authorization header' });
  }
  const rawKey = authHeader.slice(7);

  const prefix = rawKey.slice(0, 16);
  const user = await prisma.user.findUnique({ where: { apiKeyPrefix: prefix } });
  if (!user?.apiKeyHash || !(await bcrypt.compare(rawKey, user.apiKeyHash))) {
    return reply
      .status(401)
      .header('WWW-Authenticate', 'Bearer realm="agentpay"')
      .send({ error: 'Unauthorized: invalid API key' });
  }
  request.user = user;
}
