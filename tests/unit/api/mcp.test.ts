/**
 * Unit tests for the MCP endpoint (/mcp, Streamable HTTP, stateless mode).
 *
 * The MCP tools delegate to the existing REST routes via app.inject(), so
 * these tests focus on the transport wiring, auth, the tool catalogue, and
 * that tool calls actually reach the underlying routes (mocked at the prisma
 * layer, same pattern as the other API unit tests).
 */

jest.mock('@/config/env', () => ({
  env: {
    WORKER_API_KEY: 'test-worker-key',
    PORT: 3000,
    NODE_ENV: 'test',
    STRIPE_SECRET_KEY: 'sk_test_placeholder',
    STRIPE_WEBHOOK_SECRET: 'whsec_placeholder',
    DATABASE_URL: 'postgresql://test',
    REDIS_URL: 'redis://localhost:6379',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
  },
}));

jest.mock('@/telegram/callbackHandler', () => ({
  handleTelegramCallback: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => ({ webhooks: { constructEvent: jest.fn() } }),
}));
jest.mock('@/orchestrator/intentService', () => ({
  startSearching: jest.fn(),
  receiveQuote: jest.fn(),
  requestApproval: jest.fn(),
  markCardIssued: jest.fn(),
  startCheckout: jest.fn(),
  completeCheckout: jest.fn(),
  failCheckout: jest.fn(),
  getIntentWithHistory: jest.fn(),
}));
jest.mock('@/queue/producers', () => ({
  enqueueSearch: jest.fn(),
  enqueueCheckout: jest.fn(),
}));
jest.mock('@/approval/approvalService', () => ({ recordDecision: jest.fn() }));
jest.mock('@/ledger/potService', () => ({
  reserveForIntent: jest.fn(),
  settleIntent: jest.fn(),
  returnIntent: jest.fn(),
}));
jest.mock('@/payments/providers/stripe/cardService', () => ({
  issueVirtualCard: jest.fn(),
  revealCard: jest.fn(),
  cancelCard: jest.fn(),
}));
jest.mock('@/telegram/notificationService', () => ({
  sendApprovalRequest: jest.fn().mockResolvedValue(undefined),
}));

const dbPairingCodes: Record<string, any> = {};

jest.mock('@/db/client', () => ({
  prisma: {
    user: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    purchaseIntent: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    },
    idempotencyRecord: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
    pairingCode: {
      findUnique: jest.fn(({ where }: any) =>
        Promise.resolve(dbPairingCodes[where.agentId] ?? null),
      ),
      create: jest.fn(),
      update: jest.fn(),
    },
  },
}));

import bcrypt from 'bcryptjs';
import { buildApp } from '@/app';
import { prisma } from '@/db/client';
import { completeCheckout } from '@/orchestrator/intentService';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
  'x-worker-key': 'test-worker-key',
};

/** POST a JSON-RPC message to /mcp and return the parsed JSON-RPC response. */
async function mcpRequest(message: unknown, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/mcp',
    headers: { ...MCP_HEADERS, ...headers },
    body: JSON.stringify(message),
  });
  return res;
}

function rpc(method: string, params: unknown = {}, id = 1) {
  return { jsonrpc: '2.0', id, method, params };
}

function callTool(name: string, args: Record<string, unknown> = {}, id = 1) {
  return rpc('tools/call', { name, arguments: args }, id);
}

beforeAll(async () => {
  app = buildApp();
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(dbPairingCodes)) delete dbPairingCodes[key];
});

// ─── Transport & auth ────────────────────────────────────────────────────────

describe('POST /mcp — transport and auth', () => {
  it('returns 401 without X-Worker-Key', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/mcp',
      headers: { 'content-type': 'application/json', accept: MCP_HEADERS.accept },
      body: JSON.stringify(rpc('tools/list')),
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 401 with a wrong X-Worker-Key', async () => {
    const res = await mcpRequest(rpc('tools/list'), { 'x-worker-key': 'wrong' });
    expect(res.statusCode).toBe(401);
  });

  it('completes the initialize handshake with server info and instructions', async () => {
    const res = await mcpRequest(
      rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      }),
    );
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.result.serverInfo.name).toBe('tranzact');
    expect(body.result.instructions).toContain('one-time virtual card');
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it('rejects GET with 405 (stateless mode has no SSE stream)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/mcp',
      headers: { 'x-worker-key': 'test-worker-key', accept: MCP_HEADERS.accept },
    });
    expect(res.statusCode).toBe(405);
  });

  it('rejects DELETE with 405 (stateless mode has no session)', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/mcp',
      headers: { 'x-worker-key': 'test-worker-key', accept: MCP_HEADERS.accept },
    });
    expect(res.statusCode).toBe(405);
  });
});

// ─── Tool catalogue ──────────────────────────────────────────────────────────

describe('tools/list', () => {
  it('advertises the full purchase-flow tool set', async () => {
    const res = await mcpRequest(rpc('tools/list'));
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const names = body.result.tools.map((t: any) => t.name).sort();
    expect(names).toEqual([
      'create_intent',
      'get_decision',
      'get_pairing_status',
      'register_agent',
      'report_result',
      'reveal_card',
      'submit_quote',
    ]);
  });

  it('every tool has a description and an object input schema', async () => {
    const res = await mcpRequest(rpc('tools/list'));
    const body = JSON.parse(res.body);
    for (const tool of body.result.tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

// ─── Tool calls (delegation to the REST routes) ──────────────────────────────

describe('tools/call', () => {
  it('get_pairing_status reports unclaimed for a registered but unpaired agent', async () => {
    dbPairingCodes['ag_test1'] = { agentId: 'ag_test1', claimedByUserId: null };
    const res = await mcpRequest(callTool('get_pairing_status', { agentId: 'ag_test1' }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text)).toEqual({ status: 'unclaimed' });
  });

  it('get_pairing_status reports claimed with the linked userId', async () => {
    dbPairingCodes['ag_test2'] = { agentId: 'ag_test2', claimedByUserId: 'user-42' };
    const res = await mcpRequest(callTool('get_pairing_status', { agentId: 'ag_test2' }));
    const body = JSON.parse(res.body);
    expect(JSON.parse(body.result.content[0].text)).toEqual({
      status: 'claimed',
      userId: 'user-42',
    });
  });

  it('surfaces downstream HTTP errors as tool errors with the status code', async () => {
    const res = await mcpRequest(callTool('get_pairing_status', { agentId: 'ag_missing' }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('HTTP 404');
  });

  it('get_decision returns 404 error result for an unknown intent', async () => {
    const res = await mcpRequest(callTool('get_decision', { intentId: 'nope' }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('HTTP 404');
  });

  it('create_intent fails with guidance when no Authorization header is on the connection', async () => {
    const res = await mcpRequest(
      callTool('create_intent', { query: 'headphones', maxBudget: 500 }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Authorization: Bearer');
  });

  it('rejects invalid tool arguments via zod before touching any route', async () => {
    const res = await mcpRequest(
      callTool('submit_quote', {
        intentId: 'x',
        merchantName: '',
        merchantUrl: 'not-a-url',
        price: -5,
      }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments for submit_quote');
  });

  it('returns an error result for an unknown tool', async () => {
    const res = await mcpRequest(callTool('steal_card'));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Unknown tool');
  });
});

// ─── Regressions from Codex review round 1 ───────────────────────────────────

describe('tools/call — review regressions', () => {
  it('report_result rejects success:true without actualAmount (would settle 0 and refund the pot)', async () => {
    const res = await mcpRequest(callTool('report_result', { intentId: 'i-1', success: true }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('actualAmount is required when success is true');
  });

  it('report_result still accepts success:false without actualAmount', async () => {
    // Reaches the route and 404s on the unknown intent — validation passed.
    const res = await mcpRequest(callTool('report_result', { intentId: 'i-1', success: false }));
    const body = JSON.parse(res.body);
    expect(body.result.content[0].text).toContain('HTTP 404');
  });

  it('report_result accepts an explicit actualAmount of 0 (fully discounted order)', async () => {
    // Matches REST's nonnegative contract; validation passes and the route 404s.
    const res = await mcpRequest(
      callTool('report_result', { intentId: 'i-1', success: true, actualAmount: 0 }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.content[0].text).toContain('HTTP 404');
  });

  it('server instructions preserve the ten-minute approval timeout from the replaced skill', async () => {
    const res = await mcpRequest(
      rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.instructions).toContain('10 minutes');
    expect(body.result.instructions).toContain('do not\n   keep polling indefinitely');
  });

  it('create_intent forwards a caller-supplied idempotencyKey so retries return the original intent', async () => {
    const rawKey = 'testkey_0123456789abcdef';
    (prisma.user.findUnique as jest.Mock).mockImplementationOnce(({ where }: any) =>
      Promise.resolve(
        where?.apiKeyPrefix === rawKey.slice(0, 16)
          ? {
              id: 'user-1',
              apiKeyPrefix: rawKey.slice(0, 16),
              apiKeyHash: bcrypt.hashSync(rawKey, 4),
              paymentProvider: 'STRIPE',
            }
          : null,
      ),
    );
    const stored = { intentId: 'intent-original', status: 'SEARCHING' };
    // The forwarded key is namespaced by the bearer's 16-char prefix so two
    // users supplying the same caller key can never replay each other's intent.
    (prisma.idempotencyRecord.findUnique as jest.Mock).mockImplementationOnce(({ where }: any) =>
      Promise.resolve(
        where?.key === 'testkey_01234567:stable-retry-key-1' ? { responseBody: stored } : null,
      ),
    );

    const res = await mcpRequest(
      callTool('create_intent', {
        query: 'headphones',
        maxBudget: 500,
        idempotencyKey: 'stable-retry-key-1',
      }),
      { authorization: `Bearer ${rawKey}` },
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBeFalsy();
    expect(JSON.parse(body.result.content[0].text)).toEqual(stored);
    expect(prisma.purchaseIntent.create).not.toHaveBeenCalled();
  });

  it('report_result rejects a non-URL receiptUrl at the tool boundary (mirrors REST .url())', async () => {
    const res = await mcpRequest(
      callTool('report_result', { intentId: 'i-1', success: false, receiptUrl: 'order-123' }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments for report_result');
  });

  it('register_agent rejects an explicit empty agentId instead of silently registering a new agent', async () => {
    const res = await mcpRequest(callTool('register_agent', { agentId: '' }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments for register_agent');
  });

  it('create_intent rejects maxBudget above the REST ceiling at the tool boundary', async () => {
    // No auth header on purpose: schema validation must run before the credential check.
    const res = await mcpRequest(
      callTool('create_intent', { query: 'a yacht', maxBudget: 2_000_000 }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments for create_intent');
  });

  it('advertised create_intent schema carries the maxBudget ceiling', async () => {
    const res = await mcpRequest(rpc('tools/list'));
    const body = JSON.parse(res.body);
    const tool = body.result.tools.find((t: any) => t.name === 'create_intent');
    expect(tool.inputSchema.properties.maxBudget.maximum).toBe(1000000);
  });

  it('get_decision passes non-approved statuses through and instructions define the stop rule', async () => {
    (prisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'i-exp',
      status: 'EXPIRED',
    });
    const res = await mcpRequest(callTool('get_decision', { intentId: 'i-exp' }));
    const body = JSON.parse(res.body);
    expect(body.result.content[0].text).toContain('EXPIRED');

    const init = await mcpRequest(
      rpc('initialize', {
        protocolVersion: '2025-03-26',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '0.0.1' },
      }),
    );
    const instructions = JSON.parse(init.body).result.instructions;
    expect(instructions).toContain('Any other');
    expect(instructions).toContain('only APPROVED continues the flow');
  });

  it('forwards the connection X-Agent-Id to delegated routes for audit attribution', async () => {
    (prisma.purchaseIntent.findUnique as jest.Mock).mockResolvedValueOnce({
      id: 'i-att',
      status: 'CHECKOUT_RUNNING',
      metadata: {},
    });
    const res = await mcpRequest(
      callTool('report_result', { intentId: 'i-att', success: true, actualAmount: 100 }),
      { 'x-agent-id': 'ag-conn-1' },
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBeFalsy();
    expect(completeCheckout).toHaveBeenCalledWith('i-att', 100, 'ag-conn-1');
  });

  it('tool dispatch does not resolve inherited Object.prototype members', async () => {
    for (const name of ['toString', 'constructor', 'valueOf']) {
      const res = await mcpRequest(callTool(name));
      const body = JSON.parse(res.body);
      expect(body.result.isError).toBe(true);
      expect(body.result.content[0].text).toContain(`Unknown tool: ${name}`);
    }
  });

  it('get_decision with waitSeconds shorter than the poll interval still rechecks', async () => {
    (prisma.purchaseIntent.findUnique as jest.Mock)
      .mockResolvedValueOnce({ id: 'i-wait', status: 'AWAITING_APPROVAL' })
      .mockResolvedValueOnce({ id: 'i-wait', status: 'DENIED' });

    const res = await mcpRequest(callTool('get_decision', { intentId: 'i-wait', waitSeconds: 1 }));
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBeFalsy();
    expect(body.result.content[0].text).toContain('DENIED');
  });

  it('rejects undeclared tool arguments instead of silently stripping them', async () => {
    // A misspelled idempotency_key must error (advertised additionalProperties:
    // false), not be dropped — dropping it silently loses retry deduplication.
    const res = await mcpRequest(
      callTool('create_intent', { query: 'usb hub', maxBudget: 500, idempotency_key: 'p-1' }),
    );
    const body = JSON.parse(res.body);
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain('Invalid arguments for create_intent');

    // Same through the refined report_result chain (.strict() before .superRefine).
    const res2 = await mcpRequest(
      callTool('report_result', { intentId: 'i-1', success: false, actual_amount: 100 }),
    );
    const body2 = JSON.parse(res2.body);
    expect(body2.result.isError).toBe(true);
    expect(body2.result.content[0].text).toContain('Invalid arguments for report_result');
  });
});
