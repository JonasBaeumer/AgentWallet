import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { workerAuthMiddleware } from '@/api/middleware/auth';
import { buildMcpServer } from './server';

/**
 * MCP endpoint (Streamable HTTP transport, stateless mode).
 *
 * Agents connect here instead of driving the /v1 REST endpoints from a skill.
 * Auth mirrors the REST design: X-Worker-Key is required on every request, and
 * the user's API key is forwarded as an Authorization: Bearer header for the
 * tools that act on the user's behalf (create_intent).
 *
 * Stateless: each POST builds a fresh server + transport pair, so requests are
 * independent and horizontally scalable — no session affinity required. GET
 * (server-initiated SSE stream) and DELETE (session teardown) only make sense
 * for stateful sessions and return 405 per the Streamable HTTP spec.
 */
export async function mcpRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post(
    '/mcp',
    { preHandler: workerAuthMiddleware },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const server = buildMcpServer(fastify, {
        authorization: request.headers.authorization,
        clientIp: request.ip,
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });

      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });

      await server.connect(transport);
      // Hand the raw response to the transport — fastify must not touch it again.
      reply.hijack();
      await transport.handleRequest(request.raw, reply.raw, request.body);
    },
  );

  const methodNotAllowed = async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply
      .status(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Method not allowed: stateless MCP server, POST only' },
        id: null,
      });
  };

  fastify.get('/mcp', { preHandler: workerAuthMiddleware }, methodNotAllowed);
  fastify.delete('/mcp', { preHandler: workerAuthMiddleware }, methodNotAllowed);
}
