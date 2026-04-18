import { FastifyRequest } from 'fastify';

declare module 'fastify' {
  interface FastifyRequest {
    agentId?: string;
  }
}

export async function agentContextHook(request: FastifyRequest): Promise<void> {
  const raw = request.headers['x-agent-id'];
  const agentId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
  request.agentId = agentId;

  const params = request.params as { intentId?: string } | undefined;
  const body = request.body as { intentId?: string } | undefined;
  const intentId = params?.intentId ?? body?.intentId;
  const route = request.routeOptions?.url ?? request.url;

  request.log = request.log.child({
    agentId: agentId ?? null,
    intentId: intentId ?? null,
    route,
  });
}
