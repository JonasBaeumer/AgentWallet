const mockConstructEvent = jest.fn();
const mockStripe = {
  webhooks: { constructEvent: mockConstructEvent },
};

jest.mock('@/payments/providers/stripe/stripeClient', () => ({
  getStripeClient: () => mockStripe,
}));

const mockAuditCreate = jest.fn().mockResolvedValue({});
jest.mock('@/db/client', () => ({
  prisma: { auditEvent: { create: mockAuditCreate } },
}));

const mockReconcileIntent = jest.fn();
jest.mock('@/payments/providers/stripe/reconciliationService', () => ({
  reconcileIntent: (...args: any[]) => mockReconcileIntent(...args),
}));

import { handleStripeEvent } from '@/payments/providers/stripe/webhookHandler';

const RAW_BODY = Buffer.from('{"test":true}');
const SIGNATURE = 'sig_test';

function makeEvent(type: string, object: Record<string, any> = {}): any {
  return { type, data: { object } };
}

beforeAll(() => {
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test';
});

beforeEach(() => {
  jest.clearAllMocks();
  mockReconcileIntent.mockResolvedValue({ inSync: true, discrepancies: [] });
});

// ─── Signature verification ──────────────────────────────────────────────────

describe('signature verification', () => {
  it('throws when STRIPE_WEBHOOK_SECRET is not set', async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    await expect(handleStripeEvent(RAW_BODY, SIGNATURE)).rejects.toThrow('STRIPE_WEBHOOK_SECRET not set');
    process.env.STRIPE_WEBHOOK_SECRET = saved;
  });

  it('throws when constructEvent rejects the signature', async () => {
    mockConstructEvent.mockImplementation(() => { throw new Error('bad sig'); });
    await expect(handleStripeEvent(RAW_BODY, SIGNATURE)).rejects.toThrow('Webhook signature verification failed');
  });

  it('passes rawBody, signature, and secret to constructEvent', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('unknown.event'));
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockConstructEvent).toHaveBeenCalledWith(RAW_BODY, SIGNATURE, 'whsec_test');
  });
});

// ─── issuing_authorization.request ───────────────────────────────────────────

describe('issuing_authorization.request', () => {
  const authObj = { id: 'iauth_1', amount: 5000, metadata: { intentId: 'intent-1' } };

  beforeEach(() => {
    mockConstructEvent.mockReturnValue(makeEvent('issuing_authorization.request', authObj));
  });

  it('returns { approved: true } in the response body', async () => {
    const result = await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(result).toEqual({ approved: true });
  });

  it('logs STRIPE_AUTHORIZATION_REQUEST audit event', async () => {
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: {
        intentId: 'intent-1',
        actor: 'stripe',
        event: 'STRIPE_AUTHORIZATION_REQUEST',
        payload: { authId: 'iauth_1', amount: 5000 },
      },
    });
  });
});

// ─── issuing_authorization.created ───────────────────────────────────────────

describe('issuing_authorization.created', () => {
  it('logs STRIPE_AUTHORIZATION_CREATED audit event', async () => {
    const authObj = { id: 'iauth_2', amount: 3000, metadata: { intentId: 'intent-2' } };
    mockConstructEvent.mockReturnValue(makeEvent('issuing_authorization.created', authObj));
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: {
        intentId: 'intent-2',
        actor: 'stripe',
        event: 'STRIPE_AUTHORIZATION_CREATED',
        payload: { authId: 'iauth_2', amount: 3000 },
      },
    });
  });

  it('returns { received: true }', async () => {
    const authObj = { id: 'iauth_2', amount: 3000, metadata: { intentId: 'intent-2' } };
    mockConstructEvent.mockReturnValue(makeEvent('issuing_authorization.created', authObj));
    const result = await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(result).toEqual({ received: true });
  });
});

// ─── issuing_transaction.created ─────────────────────────────────────────────

describe('issuing_transaction.created', () => {
  it('logs STRIPE_TRANSACTION_CREATED audit event', async () => {
    const txnObj = { id: 'itxn_1', amount: 4500, metadata: { intentId: 'intent-3' } };
    mockConstructEvent.mockReturnValue(makeEvent('issuing_transaction.created', txnObj));
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockAuditCreate).toHaveBeenCalledWith({
      data: {
        intentId: 'intent-3',
        actor: 'stripe',
        event: 'STRIPE_TRANSACTION_CREATED',
        payload: { transactionId: 'itxn_1', amount: 4500 },
      },
    });
  });
});

// ─── issuing_transaction.created — reconciliation ────────────────────────────

describe('issuing_transaction.created reconciliation', () => {
  const txnObj = { id: 'itxn_r1', amount: 4500, metadata: { intentId: 'intent-recon' } };

  beforeEach(() => {
    mockConstructEvent.mockReturnValue(makeEvent('issuing_transaction.created', txnObj));
  });

  it('calls reconcileIntent with the intentId', async () => {
    mockReconcileIntent.mockResolvedValue({ inSync: true, discrepancies: [] });
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    // Allow fire-and-forget to settle
    await new Promise(resolve => setImmediate(resolve));
    expect(mockReconcileIntent).toHaveBeenCalledWith('intent-recon');
  });

  it('logs RECONCILIATION_DISCREPANCY when reconcileIntent returns inSync:false', async () => {
    const discrepancies = ['settledAmount 3500 != stripe captured 4000'];
    const report = { inSync: false, discrepancies, intentId: 'intent-recon', internal: {}, stripe: null };
    mockReconcileIntent.mockResolvedValue(report);

    await handleStripeEvent(RAW_BODY, SIGNATURE);
    await new Promise(resolve => setImmediate(resolve));

    expect(mockAuditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          event: 'RECONCILIATION_DISCREPANCY',
          intentId: 'intent-recon',
        }),
      }),
    );
  });

  it('does not throw when reconcileIntent rejects', async () => {
    mockReconcileIntent.mockRejectedValue(new Error('stripe down'));

    const result = await handleStripeEvent(RAW_BODY, SIGNATURE);
    await new Promise(resolve => setImmediate(resolve));

    expect(result).toEqual({ received: true });
  });
});

// ─── Unknown / unhandled events ──────────────────────────────────────────────

describe('unhandled event types', () => {
  it('returns { received: true } for unknown event type', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('customer.created', { id: 'cus_1' }));
    const result = await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(result).toEqual({ received: true });
  });

  it('does not log an audit event for unknown event type', async () => {
    mockConstructEvent.mockReturnValue(makeEvent('customer.created', { id: 'cus_1' }));
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });
});

// ─── Audit logging edge cases ────────────────────────────────────────────────

describe('audit logging edge cases', () => {
  it('skips audit logging when intentId is missing (unknown)', async () => {
    const authObj = { id: 'iauth_no_meta', amount: 1000 };
    mockConstructEvent.mockReturnValue(makeEvent('issuing_authorization.created', authObj));
    await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(mockAuditCreate).not.toHaveBeenCalled();
  });

  it('still returns { received: true } when audit DB write fails', async () => {
    const authObj = { id: 'iauth_3', amount: 2000, metadata: { intentId: 'intent-4' } };
    mockConstructEvent.mockReturnValue(makeEvent('issuing_authorization.created', authObj));
    mockAuditCreate.mockRejectedValueOnce(new Error('DB down'));
    const result = await handleStripeEvent(RAW_BODY, SIGNATURE);
    expect(result).toEqual({ received: true });
  });
});
