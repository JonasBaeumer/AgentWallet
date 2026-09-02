/**
 * Drift guard between the MCP tool validators and the REST validators they
 * mirror (requested in PR #216 review). The duplication is deliberate — the
 * advertised JSON Schemas must stay literal — so this test is what fails when
 * one side changes without the other.
 *
 * Two kinds of assertions:
 *  - agreement rows: a probe input must be accepted or rejected by BOTH sides;
 *  - deliberate divergences: pinned explicitly so they are visibly intentional.
 */

import { mcpArgSchemas } from '@/api/mcp/server';
import { createIntentSchema } from '@/api/validators/intents';
import { agentQuoteSchema, agentResultSchema, agentRegisterSchema } from '@/api/validators/agent';

const { createIntentArgs, submitQuoteArgs, reportResultArgs, registerAgentArgs } = mcpArgSchemas;

type Probe = {
  name: string;
  mcp: Record<string, unknown>;
  rest?: Record<string, unknown>; // defaults to the same object as mcp
};

function agrees(
  mcpSchema: { safeParse: (v: unknown) => { success: boolean } },
  restSchema: { safeParse: (v: unknown) => { success: boolean } },
  probe: Probe,
) {
  const mcpResult = mcpSchema.safeParse(probe.mcp).success;
  const restResult = restSchema.safeParse(probe.rest ?? probe.mcp).success;
  expect(`${probe.name}: mcp=${mcpResult} rest=${restResult}`).toBe(
    `${probe.name}: mcp=${mcpResult} rest=${mcpResult}`,
  );
}

describe('MCP validators agree with the REST validators they mirror', () => {
  const intentBase = { query: 'headphones', maxBudget: 500 };
  const intentProbes: Probe[] = [
    { name: 'valid base', mcp: intentBase },
    { name: 'empty query', mcp: { ...intentBase, query: '' } },
    { name: 'query at 500 chars', mcp: { ...intentBase, query: 'x'.repeat(500) } },
    { name: 'query over 500 chars', mcp: { ...intentBase, query: 'x'.repeat(501) } },
    { name: 'maxBudget at ceiling', mcp: { ...intentBase, maxBudget: 1000000 } },
    { name: 'maxBudget over ceiling', mcp: { ...intentBase, maxBudget: 1000001 } },
    { name: 'maxBudget zero', mcp: { ...intentBase, maxBudget: 0 } },
    { name: 'maxBudget non-integer', mcp: { ...intentBase, maxBudget: 10.5 } },
    { name: 'subject at 100 chars', mcp: { ...intentBase, subject: 's'.repeat(100) } },
    { name: 'subject over 100 chars', mcp: { ...intentBase, subject: 's'.repeat(101) } },
    { name: 'UTC expiresAt', mcp: { ...intentBase, expiresAt: '2027-01-01T00:00:00Z' } },
    { name: 'non-datetime expiresAt', mcp: { ...intentBase, expiresAt: 'tomorrow' } },
    { name: 'offset expiresAt', mcp: { ...intentBase, expiresAt: '2027-01-01T00:00:00+02:00' } },
  ];
  it.each(intentProbes)('create_intent ⇄ createIntentSchema: $name', (probe) => {
    agrees(createIntentArgs, createIntentSchema, probe);
  });

  const quoteBase = {
    intentId: 'i-1',
    merchantName: 'Amazon',
    merchantUrl: 'https://example.com/p/1',
    price: 100,
  };
  const quoteProbes: Probe[] = [
    { name: 'valid base', mcp: quoteBase },
    { name: 'empty intentId', mcp: { ...quoteBase, intentId: '' } },
    { name: 'empty merchantName', mcp: { ...quoteBase, merchantName: '' } },
    { name: 'non-URL merchantUrl', mcp: { ...quoteBase, merchantUrl: 'not-a-url' } },
    { name: 'zero price', mcp: { ...quoteBase, price: 0 } },
    { name: 'non-integer price', mcp: { ...quoteBase, price: 9.99 } },
    { name: 'valid currency', mcp: { ...quoteBase, currency: 'eur' } },
    { name: 'two-letter currency', mcp: { ...quoteBase, currency: 'eu' } },
    { name: 'four-letter currency', mcp: { ...quoteBase, currency: 'euro' } },
  ];
  it.each(quoteProbes)('submit_quote ⇄ agentQuoteSchema: $name', (probe) => {
    agrees(submitQuoteArgs, agentQuoteSchema, probe);
  });

  const resultBase = { intentId: 'i-1', success: false };
  const resultProbes: Probe[] = [
    { name: 'valid failure report', mcp: resultBase },
    { name: 'explicit zero amount', mcp: { intentId: 'i-1', success: true, actualAmount: 0 } },
    { name: 'negative amount', mcp: { ...resultBase, actualAmount: -1 } },
    { name: 'non-integer amount', mcp: { ...resultBase, actualAmount: 1.5 } },
    { name: 'non-URL receiptUrl', mcp: { ...resultBase, receiptUrl: 'order-123' } },
    { name: 'valid receiptUrl', mcp: { ...resultBase, receiptUrl: 'https://example.com/r/1' } },
    { name: 'empty intentId', mcp: { ...resultBase, intentId: '' } },
  ];
  it.each(resultProbes)('report_result ⇄ agentResultSchema: $name', (probe) => {
    agrees(reportResultArgs, agentResultSchema, probe);
  });

  const registerProbes: Probe[] = [
    { name: 'omitted agentId', mcp: {} },
    { name: 'valid agentId', mcp: { agentId: 'ag_1' } },
    { name: 'empty agentId', mcp: { agentId: '' } },
  ];
  it.each(registerProbes)('register_agent ⇄ agentRegisterSchema: $name', (probe) => {
    agrees(registerAgentArgs, agentRegisterSchema, probe);
  });
});

describe('deliberate MCP/REST divergences stay pinned', () => {
  it('MCP requires actualAmount on success; REST accepts its omission (pre-existing)', () => {
    const probe = { intentId: 'i-1', success: true };
    expect(mcpArgSchemas.reportResultArgs.safeParse(probe).success).toBe(false);
    expect(agentResultSchema.safeParse(probe).success).toBe(true);
  });

  it('MCP is strict about unknown keys; REST strips them', () => {
    const probe = { intentId: 'i-1', success: false, idempotency_key: 'oops' };
    expect(mcpArgSchemas.reportResultArgs.safeParse(probe).success).toBe(false);
    expect(agentResultSchema.safeParse(probe).success).toBe(true);
  });

  it('MCP leaves currency optional with no default; REST defaults to eur', () => {
    const parsed = agentQuoteSchema.safeParse({
      intentId: 'i-1',
      merchantName: 'A',
      merchantUrl: 'https://example.com',
      price: 1,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.currency).toBe('eur');
    const mcpParsed = mcpArgSchemas.submitQuoteArgs.safeParse({
      intentId: 'i-1',
      merchantName: 'A',
      merchantUrl: 'https://example.com',
      price: 1,
    });
    expect(mcpParsed.success).toBe(true);
    if (mcpParsed.success) {
      expect((mcpParsed.data as { currency?: string }).currency).toBeUndefined();
    }
  });
});
