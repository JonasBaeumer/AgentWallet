import { CryptoNetwork, CryptoPaymentStatus, PaymentRail, Prisma } from '@prisma/client';
import { prisma } from '@/db/client';

const CUSTOMER = `0x${'1'.repeat(40)}`;
const EXECUTOR = `0x${'2'.repeat(40)}`;
const TOKEN = `0x${'3'.repeat(40)}`;
const RECIPIENT = `0x${'4'.repeat(40)}`;
const ALLOWANCE = '9999999999999999999999999999999999999999999999999999999999999999999999';

let sequence = 0;
let userId: string;
let walletAccountId: string;
let spendPermissionId: string;

function uniqueHex(): string {
  sequence += 1;
  return `0x${sequence.toString(16).padStart(64, '0')}`;
}

async function createIntent(paymentRail: PaymentRail = PaymentRail.CRYPTO) {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      query: 'Pay an x402 merchant',
      maxBudget: 1000,
      currency: 'usd',
      paymentRail,
      idempotencyKey: `crypto-intent-${Date.now()}-${sequence++}`,
    },
  });
}

async function createIntentWithDefaultRail() {
  return prisma.purchaseIntent.create({
    data: {
      userId,
      query: 'Use the existing card rail',
      maxBudget: 1000,
      currency: 'usd',
      idempotencyKey: `card-intent-${Date.now()}-${sequence++}`,
    },
  });
}

async function createPayment(
  intentId: string,
  overrides: Partial<Prisma.CryptoPaymentUncheckedCreateInput> = {},
) {
  return prisma.cryptoPayment.create({
    data: {
      intentId,
      walletAccountId,
      spendPermissionId,
      network: CryptoNetwork.BASE_SEPOLIA,
      chainId: 84532,
      displayCurrency: 'usd',
      displayAmount: new Prisma.Decimal('1.25'),
      assetSymbol: 'USDC',
      tokenAddress: TOKEN,
      tokenDecimals: 6,
      amountAtomic: new Prisma.Decimal('1250000'),
      recipientAddress: RECIPIENT,
      requestDigest: uniqueHex(),
      executionIdempotencyKey: `crypto-execution-${Date.now()}-${sequence++}`,
      ...overrides,
    },
  });
}

beforeAll(async () => {
  const user = await prisma.user.create({
    data: { email: `crypto-model-${Date.now()}@test.local` },
  });
  userId = user.id;

  const wallet = await prisma.cryptoWalletAccount.create({
    data: {
      userId,
      network: CryptoNetwork.BASE_SEPOLIA,
      chainId: 84532,
      customerAddress: CUSTOMER,
      executorAddress: EXECUTOR,
      executorAccountId: `cdp-account-${Date.now()}`,
      executorAccountName: `agentwallet-executor-${Date.now()}`,
      status: 'ACTIVE',
    },
  });
  walletAccountId = wallet.id;

  const permission = await prisma.cryptoSpendPermission.create({
    data: {
      walletAccountId,
      permissionHash: uniqueHex(),
      network: CryptoNetwork.BASE_SEPOLIA,
      chainId: 84532,
      customerAddress: CUSTOMER,
      spenderAddress: EXECUTOR,
      tokenAddress: TOKEN,
      assetSymbol: 'USDC',
      tokenDecimals: 6,
      allowanceAtomic: new Prisma.Decimal(ALLOWANCE),
      periodSeconds: 86_400,
      validAfter: new Date(Date.now() - 60_000),
      validUntil: new Date(Date.now() + 86_400_000),
      status: 'ACTIVE',
    },
  });
  spendPermissionId = permission.id;
});

afterAll(async () => {
  await prisma.cryptoPayment.deleteMany({ where: { walletAccountId } });
  await prisma.cryptoSpendPermission.deleteMany({ where: { walletAccountId } });
  await prisma.cryptoWalletAccount.delete({ where: { id: walletAccountId } });
  await prisma.purchaseIntent.deleteMany({ where: { userId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

describe('crypto payment database invariants', () => {
  it('preserves CARD as the default rail for existing Stripe write paths', async () => {
    const intent = await createIntentWithDefaultRail();
    expect(intent.paymentRail).toBe(PaymentRail.CARD);
  });

  it('round-trips atomic token amounts beyond JavaScript safe integers without loss', async () => {
    const intent = await createIntent();
    const atomic = '123456789012345678901234567890123456789012345678901234567890';
    const payment = await createPayment(intent.id, {
      amountAtomic: new Prisma.Decimal(atomic),
    });

    expect(payment.amountAtomic.toFixed(0)).toBe(atomic);
    expect(payment.displayCurrency).toBe('usd');
    expect(payment.assetSymbol).toBe('USDC');
    expect(payment.tokenDecimals).toBe(6);
  });

  it('rejects changes to persisted x402 approval terms', async () => {
    const intent = await createIntent();
    const payment = await createPayment(intent.id);

    await expect(
      prisma.cryptoPayment.update({
        where: { id: payment.id },
        data: { recipientAddress: `0x${'5'.repeat(40)}` },
      }),
    ).rejects.toThrow('crypto_payment_terms_immutable');
  });

  it('atomically rejects duplicate submission keys', async () => {
    const firstIntent = await createIntent();
    const secondIntent = await createIntent();
    const key = `duplicate-execution-${Date.now()}`;
    await createPayment(firstIntent.id, { executionIdempotencyKey: key });

    await expect(
      createPayment(secondIntent.id, { executionIdempotencyKey: key }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('allows at most one active crypto execution per intent', async () => {
    const intent = await createIntent();
    const first = await createPayment(intent.id);

    await expect(createPayment(intent.id)).rejects.toMatchObject({ code: 'P2002' });

    await prisma.cryptoPayment.update({
      where: { id: first.id },
      data: { status: CryptoPaymentStatus.DENIED },
    });
    await expect(createPayment(intent.id)).resolves.toMatchObject({ intentId: intent.id });
  });

  it('rejects crypto payment rows attached to a CARD intent', async () => {
    const intent = await createIntent(PaymentRail.CARD);
    await expect(createPayment(intent.id)).rejects.toThrow('crypto_payment_scope_mismatch');
  });

  it('rejects amounts above the persisted spend permission', async () => {
    const intent = await createIntent();
    const tooLarge = new Prisma.Decimal(ALLOWANCE).plus(1);
    await expect(createPayment(intent.id, { amountAtomic: tooLarge })).rejects.toThrow(
      'crypto_payment_scope_mismatch',
    );
  });

  it('rejects illegal direct status transitions at the database boundary', async () => {
    const intent = await createIntent();
    const payment = await createPayment(intent.id);

    await expect(
      prisma.cryptoPayment.update({
        where: { id: payment.id },
        data: { status: CryptoPaymentStatus.SUCCEEDED },
      }),
    ).rejects.toThrow('crypto_payment_invalid_status_transition');
  });
});
