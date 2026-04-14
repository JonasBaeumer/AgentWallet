import { createIntentSchema } from '@/api/validators/intents';
import { approvalDecisionSchema } from '@/api/validators/approvals';
import { agentQuoteSchema, agentResultSchema } from '@/api/validators/agent';

describe('createIntentSchema', () => {
  it('accepts valid input', () => {
    const result = createIntentSchema.safeParse({ query: 'buy headphones', maxBudget: 10000 });
    expect(result.success).toBe(true);
  });

  it('rejects missing query', () => {
    const result = createIntentSchema.safeParse({ maxBudget: 10000 });
    expect(result.success).toBe(false);
  });

  it('rejects negative maxBudget', () => {
    const result = createIntentSchema.safeParse({ query: 'test', maxBudget: -1 });
    expect(result.success).toBe(false);
  });

  it('rejects maxBudget over limit', () => {
    const result = createIntentSchema.safeParse({ query: 'test', maxBudget: 9999999 });
    expect(result.success).toBe(false);
  });
});

describe('approvalDecisionSchema', () => {
  it('accepts APPROVED', () => {
    const result = approvalDecisionSchema.safeParse({ decision: 'APPROVED', actorId: 'user-1' });
    expect(result.success).toBe(true);
  });

  it('accepts DENIED with reason', () => {
    const result = approvalDecisionSchema.safeParse({
      decision: 'DENIED',
      actorId: 'user-1',
      reason: 'Too expensive',
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid decision', () => {
    const result = approvalDecisionSchema.safeParse({ decision: 'MAYBE', actorId: 'user-1' });
    expect(result.success).toBe(false);
  });
});

describe('agentQuoteSchema', () => {
  it('accepts valid quote', () => {
    const result = agentQuoteSchema.safeParse({
      intentId: 'i-1',
      merchantName: 'Amazon UK',
      merchantUrl: 'https://amazon.co.uk',
      price: 9999,
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid URL', () => {
    const result = agentQuoteSchema.safeParse({
      intentId: 'i-1',
      merchantName: 'Amazon',
      merchantUrl: 'not-a-url',
      price: 9999,
    });
    expect(result.success).toBe(false);
  });
});

describe('agentResultSchema', () => {
  it('accepts success result', () => {
    const result = agentResultSchema.safeParse({
      intentId: 'i-1',
      success: true,
      actualAmount: 9999,
    });
    expect(result.success).toBe(true);
  });

  it('accepts failure result', () => {
    const result = agentResultSchema.safeParse({
      intentId: 'i-1',
      success: false,
      errorMessage: 'checkout failed',
    });
    expect(result.success).toBe(true);
  });
});
