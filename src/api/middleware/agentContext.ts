import { FastifyRequest, FastifyReply } from 'fastify';

// Fastify augments: expose request.agentId on any handler under /v1/agent/*.
declare module 'fastify' {
  interface FastifyRequest {
    agentId: string | null;
  }
}

function extractIntentId(request: FastifyRequest): string | null {
  const fromParams = (request.params as { intentId?: string } | undefined)?.intentId;
  if (typeof fromParams === 'string' && fromParams) return fromParams;
  const fromBody = (request.body as { intentId?: string } | undefined)?.intentId;
  if (typeof fromBody === 'string' && fromBody) return fromBody;
  return null;
}

/**
 * Attaches per-request agent context for every /v1/agent/* route:
 *   - Parses the X-Agent-Id header and exposes it as `request.agentId`.
 *   - Rebinds `request.log` to a child logger carrying
 *     { agentId?, intentId?, route } so any log emitted by this handler
 *     (or by a downstream call using request.log) inherits that context.
 *   - Emits a single INFO log line at request start so Fastify's stream
 *     always contains a structured entry with the full context even when
 *     Fastify's own request-completion log does not.
 *
 * Called via fastify.addHook('onRequest', ...) scoped to the agent plugin.
 */
export async function agentContextMiddleware(
  request: FastifyRequest,
  _reply: FastifyReply,
): Promise<void> {
  const rawHeader = request.headers['x-agent-id'];
  const agentId = typeof rawHeader === 'string' && rawHeader.trim() ? rawHeader.trim() : null;
  request.agentId = agentId;

  const intentId = extractIntentId(request);
  const route = request.routerPath ?? request.url.split('?')[0];

  const bindings: Record<string, string> = { route };
  if (agentId) bindings.agentId = agentId;
  if (intentId) bindings.intentId = intentId;

  request.log = request.log.child(bindings);
  request.log.info({ method: request.method }, 'Agent request received');
}
