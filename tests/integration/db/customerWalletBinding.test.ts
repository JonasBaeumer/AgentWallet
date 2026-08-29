import { CryptoNetwork, CryptoPermissionStatus, CryptoWalletStatus, Prisma } from '@prisma/client';
import { prisma } from '@/db/client';
import {
  bindCustomerWallet,
  CdpUserVerifier,
  disconnectCustomerWallet,
} from '@/crypto/customerWalletService';
import {
  CdpSessionValidationError,
  CryptoWalletAlreadyBoundError,
  CryptoWalletDisconnectBlockedError,
} from '@/contracts';

const CUSTOMER_ADDRESS = `0x${'a'.repeat(40)}`;
const SECOND_ADDRESS = `0x${'b'.repeat(40)}`;
const EXECUTOR_ADDRESS = `0x${'c'.repeat(40)}`;
const TOKEN_ADDRESS = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';

function verifier(userId: string, smartAccountAddress: string): CdpUserVerifier {
  return {
    validateAccessToken: jest.fn().mockResolvedValue({
      userId,
      smartAccountAddresses: [smartAccountAddress],
    }),
  };
}

const createdUserIds: string[] = [];

async function createUser(label: string): Promise<string> {
  const user = await prisma.user.create({
    data: { email: `wallet-${label}-${Date.now()}-${createdUserIds.length}@test.local` },
  });
  createdUserIds.push(user.id);
  return user.id;
}

afterAll(async () => {
  await prisma.auditEvent.deleteMany({ where: { actor: { in: createdUserIds } } });
  await prisma.cryptoSpendPermission.deleteMany({
    where: { walletAccount: { userId: { in: createdUserIds } } },
  });
  await prisma.cryptoWalletAccount.deleteMany({ where: { userId: { in: createdUserIds } } });
  await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await prisma.$disconnect();
});

describe('customer wallet binding invariants', () => {
  it('binds and reconnects the verified Smart Account idempotently', async () => {
    const userId = await createUser('idempotent');
    const cdpVerifier = verifier('cdp-user-idempotent', CUSTOMER_ADDRESS);

    const first = await bindCustomerWallet(
      userId,
      { accessToken: 'short-lived-token', smartAccountAddress: `0x${'A'.repeat(40)}` },
      cdpVerifier,
    );
    const second = await bindCustomerWallet(
      userId,
      { accessToken: 'refreshed-token', smartAccountAddress: CUSTOMER_ADDRESS },
      cdpVerifier,
    );

    expect(second.id).toBe(first.id);
    expect(second.customerAddress).toBe(CUSTOMER_ADDRESS);
    expect(second.customerAccountId).toBe('cdp-user-idempotent');
    expect(second.executorAddress).toBeNull();
    expect(second.status).toBe(CryptoWalletStatus.PROVISIONING);

    const audits = await prisma.auditEvent.findMany({
      where: { actor: userId },
      orderBy: { createdAt: 'asc' },
    });
    expect(audits.map((audit) => audit.event)).toEqual([
      'CRYPTO_WALLET_BOUND',
      'CRYPTO_WALLET_RECONNECTED',
    ]);
    expect(JSON.stringify(audits.map((audit) => audit.payload))).not.toContain('short-lived-token');
  });

  it('rejects a Smart Account not present in the validated CDP session', async () => {
    const userId = await createUser('mismatch');

    await expect(
      bindCustomerWallet(
        userId,
        { accessToken: 'valid-token', smartAccountAddress: CUSTOMER_ADDRESS },
        verifier('cdp-user-mismatch', SECOND_ADDRESS),
      ),
    ).rejects.toThrow(CdpSessionValidationError);
  });

  it('atomically permits only one customer to claim a CDP identity', async () => {
    const firstUserId = await createUser('claim-a');
    const secondUserId = await createUser('claim-b');
    const sharedVerifier = verifier('cdp-user-shared', SECOND_ADDRESS);

    const results = await Promise.allSettled([
      bindCustomerWallet(
        firstUserId,
        { accessToken: 'token-a', smartAccountAddress: SECOND_ADDRESS },
        sharedVerifier,
      ),
      bindCustomerWallet(
        secondUserId,
        { accessToken: 'token-b', smartAccountAddress: SECOND_ADDRESS },
        sharedVerifier,
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(rejected?.reason).toBeInstanceOf(CryptoWalletAlreadyBoundError);
    expect(
      await prisma.cryptoWalletAccount.count({
        where: { customerAccountId: 'cdp-user-shared' },
      }),
    ).toBe(1);
  });

  it('closes and reconnects the same wallet without deleting its identity', async () => {
    const userId = await createUser('disconnect');
    const cdpVerifier = verifier('cdp-user-disconnect', `0x${'d'.repeat(40)}`);
    const wallet = await bindCustomerWallet(
      userId,
      { accessToken: 'token', smartAccountAddress: `0x${'d'.repeat(40)}` },
      cdpVerifier,
    );

    const disconnected = await disconnectCustomerWallet(userId);
    expect(disconnected.id).toBe(wallet.id);
    expect(disconnected.status).toBe(CryptoWalletStatus.CLOSED);
    expect(disconnected.disconnectedAt).toBeInstanceOf(Date);

    const reconnected = await bindCustomerWallet(
      userId,
      { accessToken: 'new-token', smartAccountAddress: `0x${'d'.repeat(40)}` },
      cdpVerifier,
    );
    expect(reconnected.id).toBe(wallet.id);
    expect(reconnected.status).toBe(CryptoWalletStatus.PROVISIONING);
    expect(reconnected.disconnectedAt).toBeNull();
  });

  it('requires active permissions to be revoked before disconnecting', async () => {
    const userId = await createUser('permission');
    const address = `0x${'e'.repeat(40)}`;
    const wallet = await bindCustomerWallet(
      userId,
      { accessToken: 'token', smartAccountAddress: address },
      verifier('cdp-user-permission', address),
    );

    await prisma.cryptoSpendPermission.create({
      data: {
        walletAccountId: wallet.id,
        permissionHash: `0x${'f'.repeat(64)}`,
        network: CryptoNetwork.BASE_SEPOLIA,
        chainId: 84532,
        customerAddress: address,
        spenderAddress: EXECUTOR_ADDRESS,
        tokenAddress: TOKEN_ADDRESS,
        assetSymbol: 'USDC',
        tokenDecimals: 6,
        allowanceAtomic: new Prisma.Decimal('1000000'),
        periodSeconds: 86_400,
        validAfter: new Date(Date.now() - 1_000),
        validUntil: new Date(Date.now() + 86_400_000),
        status: CryptoPermissionStatus.ACTIVE,
      },
    });

    await expect(disconnectCustomerWallet(userId)).rejects.toThrow(
      CryptoWalletDisconnectBlockedError,
    );
  });
});
