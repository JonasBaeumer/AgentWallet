import { agentContextHook } from '@/api/middleware/agentContext';

describe('agentContextHook', () => {
  function makeRequest(overrides: Record<string, unknown> = {}) {
    const childLogger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const childSpy = jest.fn().mockReturnValue(childLogger);
    const baseLogger = { child: childSpy };
    const req = {
      headers: {},
      params: {},
      body: {},
      url: '/v1/agent/quote',
      routeOptions: { url: '/v1/agent/quote' },
      log: baseLogger,
      ...overrides,
    } as any;
    return { req, childSpy };
  }

  it('sets request.agentId from X-Agent-Id header', async () => {
    const { req } = makeRequest({ headers: { 'x-agent-id': 'ag_abc123' } });
    await agentContextHook(req);
    expect(req.agentId).toBe('ag_abc123');
  });

  it('leaves request.agentId undefined when header is missing', async () => {
    const { req } = makeRequest();
    await agentContextHook(req);
    expect(req.agentId).toBeUndefined();
  });

  it('treats empty X-Agent-Id string as missing', async () => {
    const { req } = makeRequest({ headers: { 'x-agent-id': '' } });
    await agentContextHook(req);
    expect(req.agentId).toBeUndefined();
  });

  it('enriches req.log with agentId, intentId from params, and route', async () => {
    const { req, childSpy } = makeRequest({
      headers: { 'x-agent-id': 'ag_abc123' },
      params: { intentId: 'intent-99' },
      routeOptions: { url: '/v1/agent/card/:intentId' },
    });
    await agentContextHook(req);
    expect(childSpy).toHaveBeenCalledWith({
      agentId: 'ag_abc123',
      intentId: 'intent-99',
      route: '/v1/agent/card/:intentId',
    });
  });

  it('falls back to intentId in request body when not in params', async () => {
    const { req, childSpy } = makeRequest({
      headers: { 'x-agent-id': 'ag_abc123' },
      body: { intentId: 'intent-from-body' },
    });
    await agentContextHook(req);
    expect(childSpy).toHaveBeenCalledWith(
      expect.objectContaining({ intentId: 'intent-from-body' }),
    );
  });

  it('sets agentId and intentId to null in log fields when both are absent', async () => {
    const { req, childSpy } = makeRequest();
    await agentContextHook(req);
    expect(childSpy).toHaveBeenCalledWith({
      agentId: null,
      intentId: null,
      route: '/v1/agent/quote',
    });
  });
});
