import { FastifyRequest } from 'fastify';

export async function agentContextHook(request: FastifyRequest): Promise<void> {
  const agentId = request.authenticatedAgent?.id;

  const params = request.params as { intentId?: string } | undefined;
  const body = request.body as { intentId?: string } | undefined;
  const intentId = params?.intentId ?? body?.intentId;
  const route = request.routeOptions?.url ?? request.url;

  request.log = request.log.child({
    agentId: agentId ?? null,
    agentUserId: request.authenticatedAgent?.userId ?? null,
    intentId: intentId ?? null,
    route,
  });
}
