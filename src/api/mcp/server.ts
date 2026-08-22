import { randomUUID } from 'crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { FastifyInstance } from 'fastify';
import { env } from '@/config/env';
import { SERVER_INSTRUCTIONS } from './instructions';

/**
 * Per-request context captured from the incoming /mcp HTTP request.
 *
 * - `authorization` — the caller's `Authorization: Bearer <user API key>` header,
 *   forwarded verbatim to /v1/intents so user auth works exactly as on REST.
 * - `clientIp` — the real client IP, forwarded so per-IP rate limits
 *   (global 60/min, register 3/10min) key on the agent, not on loopback.
 *
 * Note: the SDK's high-level McpServer/registerTool API is deliberately not used
 * here — its zod 3/4 compat types blow up tsc (TS2589, >25M instantiations).
 * The low-level Server + explicit JSON Schema pattern below typechecks cheaply
 * and matches the repo's existing zod-validator style.
 */
export interface McpRequestContext {
  authorization?: string;
  clientIp?: string;
}

interface ApiCallOptions {
  method: 'GET' | 'POST';
  url: string;
  headers?: Record<string, string>;
  payload?: unknown;
}

interface ToolContent {
  [key: string]: unknown;
  type: 'text';
  text: string;
}

interface ToolResult {
  [key: string]: unknown;
  content: ToolContent[];
  isError?: boolean;
}

const DECISION_POLL_INTERVAL_MS = 2500;
const MAX_WAIT_SECONDS = 25;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorResult(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true };
}

// ---------------------------------------------------------------------------
// Runtime validators (plain zod 3 — cheap types, same style as src/api/validators)
// ---------------------------------------------------------------------------

const registerAgentArgs = z.object({
  agentId: z.string().optional(),
});

const getPairingStatusArgs = z.object({
  agentId: z.string().min(1),
});

const createIntentArgs = z.object({
  query: z.string().min(1).max(500),
  subject: z.string().min(1).max(100).optional(),
  maxBudget: z.number().int().positive(),
  expiresAt: z.string().optional(),
  idempotencyKey: z.string().min(8).max(128).optional(),
});

const submitQuoteArgs = z.object({
  intentId: z.string().min(1),
  merchantName: z.string().min(1),
  merchantUrl: z.string().url(),
  price: z.number().int().positive(),
  currency: z.string().length(3).optional(),
});

const getDecisionArgs = z.object({
  intentId: z.string().min(1),
  waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).optional(),
});

const revealCardArgs = z.object({
  intentId: z.string().min(1),
});

const reportResultArgs = z
  .object({
    intentId: z.string().min(1),
    success: z.boolean(),
    actualAmount: z.number().int().positive().optional(),
    receiptUrl: z.string().optional(),
    errorMessage: z.string().optional(),
  })
  // Money invariant: a successful report without the charged amount would settle
  // the ledger at 0 and refund the whole reserved pot while marking the intent
  // DONE. Reject it here — the REST validator accepts it (pre-existing).
  .superRefine((val, ctx) => {
    if (val.success && val.actualAmount === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['actualAmount'],
        message: 'actualAmount is required when success is true',
      });
    }
  });

// ---------------------------------------------------------------------------
// Tool catalogue — JSON Schemas advertised to MCP clients. Kept literal and in
// sync with the zod validators above so what is advertised is what is enforced.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'register_agent',
    title: 'Register agent',
    description:
      'One-time agent registration. Returns { agentId, pairingCode, expiresAt }. Store the ' +
      'agentId permanently and give the pairingCode to the user to pair via Telegram with ' +
      '/start <pairingCode>. Pass your stored agentId to renew an expired pairing code. ' +
      'Rate limited to 3 calls per 10 minutes.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Existing agentId when renewing an expired pairing code; omit on first call',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_pairing_status',
    title: 'Get pairing status',
    description:
      'Check whether the user has completed Telegram pairing for this agent. Returns ' +
      '{ status: "unclaimed" } while pairing is pending, or { status: "claimed", userId } ' +
      'once the user has linked their account.',
    inputSchema: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: 'The agentId returned by register_agent' },
      },
      required: ['agentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_intent',
    title: 'Create purchase intent',
    description:
      'Register a new purchase task BEFORE searching for the product. Returns ' +
      '{ intentId, status: "SEARCHING" }. Store the intentId — every subsequent tool call ' +
      'for this purchase requires it. maxBudget is an integer in the smallest currency unit ' +
      '(€5.00 = 500); ask the user for a budget if they did not give one. The currency is ' +
      "derived from the user's payment provider on the server. Requires the MCP connection " +
      'to send the user API key as an Authorization: Bearer header.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          minLength: 1,
          maxLength: 500,
          description: 'What to buy, e.g. "Sony WH-1000XM5, black"',
        },
        subject: {
          type: 'string',
          minLength: 1,
          maxLength: 100,
          description: 'Short label for notifications',
        },
        maxBudget: {
          type: 'integer',
          minimum: 1,
          description: 'Maximum spend in smallest currency unit (cents/pence)',
        },
        expiresAt: {
          type: 'string',
          description: 'Optional ISO 8601 datetime after which the intent expires',
        },
        idempotencyKey: {
          type: 'string',
          minLength: 8,
          maxLength: 128,
          description:
            'Stable retry key. When retrying THIS EXACT request after a lost or failed ' +
            'response, reuse the SAME key so the server returns the original intent instead ' +
            'of creating a duplicate. Use a fresh key for each new purchase. Auto-generated ' +
            'when omitted (in which case retries are NOT deduplicated).',
        },
      },
      required: ['query', 'maxBudget'],
      additionalProperties: false,
    },
  },
  {
    name: 'submit_quote',
    title: 'Submit product quote',
    description:
      'Submit the product you found. Transitions the intent to AWAITING_APPROVAL and sends ' +
      'the user a Telegram approval request. price is an integer in the smallest currency ' +
      'unit and must be within the intent budget. Returns 409 if the intent is not in ' +
      'SEARCHING state. Do not submit a second quote for the same intent.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'The intentId from create_intent' },
        merchantName: { type: 'string', description: 'Retailer display name, e.g. "Amazon UK"' },
        merchantUrl: { type: 'string', description: 'Direct product URL' },
        price: {
          type: 'integer',
          minimum: 1,
          description: 'Exact price in smallest currency unit (cents/pence)',
        },
        currency: {
          type: 'string',
          description: '3-letter lowercase ISO code matching the intent currency, e.g. "eur"',
        },
      },
      required: ['intentId', 'merchantName', 'merchantUrl', 'price'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_decision',
    title: 'Get approval decision',
    description:
      "Check the user's approval decision for a quoted intent. Pass waitSeconds (max " +
      `${MAX_WAIT_SECONDS}) to long-poll: the server holds the request open and re-checks ` +
      'until the decision changes or the wait expires. Returns status AWAITING_APPROVAL ' +
      '(keep polling), DENIED (stop — do not check out), or APPROVED with ' +
      '{ checkout: { amount, currency } } — the amount is the spending limit on the card. ' +
      'Call repeatedly while AWAITING_APPROVAL; the user decides in Telegram.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'The intentId from create_intent' },
        waitSeconds: {
          type: 'integer',
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: 'Seconds to hold the request open while the decision is pending',
        },
      },
      required: ['intentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reveal_card',
    title: 'Reveal virtual card',
    description:
      'Reveal the one-time virtual card credentials for an APPROVED intent. WORKS EXACTLY ' +
      'ONCE per intent — a second call returns 409. Hold the credentials in working memory ' +
      'only; never log or persist them. Returns { number, cvc, expMonth, expYear, last4 }. ' +
      'A 429 does NOT consume the reveal — wait 60 seconds and retry. Rate limited to 2 ' +
      'calls per minute per intent.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'The intentId of an approved intent' },
      },
      required: ['intentId'],
      additionalProperties: false,
    },
  },
  {
    name: 'report_result',
    title: 'Report checkout result',
    description:
      'Report the checkout outcome. ALWAYS call this as the final step, on success AND on ' +
      'failure — it settles the ledger and cancels the virtual card. actualAmount (smallest ' +
      'currency unit) is required when success is true and may differ from the quoted price. ' +
      'Returns 409 if the intent is not in CHECKOUT_RUNNING state.',
    inputSchema: {
      type: 'object',
      properties: {
        intentId: { type: 'string', description: 'The intentId from create_intent' },
        success: { type: 'boolean', description: 'Whether the merchant checkout completed' },
        actualAmount: {
          type: 'integer',
          minimum: 1,
          description: 'Amount actually charged, smallest currency unit. Required on success.',
        },
        receiptUrl: { type: 'string', description: 'Order confirmation URL, if available' },
        errorMessage: { type: 'string', description: 'Failure reason when success is false' },
      },
      required: ['intentId', 'success'],
      // actualAmount is mandatory on success — see the reportResultArgs refinement.
      allOf: [
        {
          if: { properties: { success: { const: true } }, required: ['success'] },
          then: { required: ['actualAmount'] },
        },
      ],
      additionalProperties: false,
    },
  },
];

/**
 * Build an MCP server whose tools delegate to the existing REST routes via
 * fastify's inject(). The routes stay the single source of truth: zod
 * validation, state-machine checks, per-intent rate limits, idempotency and
 * audit logging all run unchanged for MCP calls.
 */
export function buildMcpServer(app: FastifyInstance, ctx: McpRequestContext): Server {
  const server = new Server(
    { name: 'tranzact', version: '1.0.0' },
    { capabilities: { tools: {} }, instructions: SERVER_INSTRUCTIONS },
  );

  async function callApi(opts: ApiCallOptions): Promise<{ statusCode: number; body: string }> {
    const headers: Record<string, string> = {
      'x-worker-key': env.WORKER_API_KEY,
      ...opts.headers,
    };
    if (opts.payload !== undefined) {
      headers['content-type'] = 'application/json';
    }
    const res = await app.inject({
      method: opts.method,
      url: opts.url,
      headers,
      // Preserve the real client IP so per-IP rate limits key on the agent,
      // not on the loopback address every injected request would share.
      remoteAddress: ctx.clientIp,
      ...(opts.payload !== undefined ? { payload: JSON.stringify(opts.payload) } : {}),
    });
    return { statusCode: res.statusCode, body: res.body };
  }

  function toResult(statusCode: number, body: string): ToolResult {
    const ok = statusCode >= 200 && statusCode < 300;
    return {
      content: [{ type: 'text', text: ok ? body : `HTTP ${statusCode}: ${body}` }],
      isError: !ok,
    };
  }

  const handlers: Record<string, (args: unknown) => Promise<ToolResult>> = {
    async register_agent(args) {
      const { agentId } = registerAgentArgs.parse(args ?? {});
      const { statusCode, body } = await callApi({
        method: 'POST',
        url: '/v1/agent/register',
        payload: agentId ? { agentId } : {},
      });
      return toResult(statusCode, body);
    },

    async get_pairing_status(args) {
      const { agentId } = getPairingStatusArgs.parse(args);
      const { statusCode, body } = await callApi({
        method: 'GET',
        url: '/v1/agent/user',
        headers: { 'x-agent-id': agentId },
      });
      return toResult(statusCode, body);
    },

    async create_intent(args) {
      if (!ctx.authorization) {
        return errorResult(
          'Missing user credentials: the MCP connection must send the user API key as an ' +
            '"Authorization: Bearer <key>" header (issued during Telegram signup).',
        );
      }
      const { query, subject, maxBudget, expiresAt, idempotencyKey } = createIntentArgs.parse(args);
      const { statusCode, body } = await callApi({
        method: 'POST',
        url: '/v1/intents',
        headers: {
          authorization: ctx.authorization,
          // Caller-supplied key survives MCP-level retries and hits the
          // idempotency cache; a generated one is unique per execution.
          'x-idempotency-key': idempotencyKey ?? randomUUID(),
        },
        payload: { query, subject, maxBudget, expiresAt },
      });
      return toResult(statusCode, body);
    },

    async submit_quote(args) {
      const payload = submitQuoteArgs.parse(args);
      const { statusCode, body } = await callApi({
        method: 'POST',
        url: '/v1/agent/quote',
        payload,
      });
      return toResult(statusCode, body);
    },

    async get_decision(args) {
      const { intentId, waitSeconds } = getDecisionArgs.parse(args);
      const url = `/v1/agent/decision/${intentId}`;
      const deadline = Date.now() + Math.min(waitSeconds ?? 0, MAX_WAIT_SECONDS) * 1000;

      let res = await callApi({ method: 'GET', url });
      while (
        res.statusCode === 200 &&
        res.body.includes('AWAITING_APPROVAL') &&
        Date.now() < deadline
      ) {
        // Sleep the remaining wait when it is shorter than the poll interval,
        // so waits below 2.5s still get a recheck instead of returning early.
        await sleep(Math.min(DECISION_POLL_INTERVAL_MS, Math.max(deadline - Date.now(), 1)));
        res = await callApi({ method: 'GET', url });
      }
      return toResult(res.statusCode, res.body);
    },

    async reveal_card(args) {
      const { intentId } = revealCardArgs.parse(args);
      const { statusCode, body } = await callApi({
        method: 'GET',
        url: `/v1/agent/card/${intentId}`,
      });
      return toResult(statusCode, body);
    },

    async report_result(args) {
      const payload = reportResultArgs.parse(args);
      const { statusCode, body } = await callApi({
        method: 'POST',
        url: '/v1/agent/result',
        payload,
      });
      return toResult(statusCode, body);
    },
  };

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const handler = handlers[name];
    if (!handler) {
      return errorResult(`Unknown tool: ${name}`);
    }
    try {
      return await handler(args);
    } catch (err) {
      if (err instanceof z.ZodError) {
        return errorResult(`Invalid arguments for ${name}: ${JSON.stringify(err.issues)}`);
      }
      throw err;
    }
  });

  return server;
}
