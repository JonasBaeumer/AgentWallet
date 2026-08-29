import {
  CryptoNetwork,
  CryptoPaymentStatus,
  CryptoPermissionStatus,
  CryptoWalletAccount,
  CryptoWalletStatus,
  Prisma,
} from '@prisma/client';
import { env } from '@/config/env';
import { prisma } from '@/db/client';
import {
  CdpSessionValidationError,
  CryptoFeatureDisabledError,
  CryptoWalletAlreadyBoundError,
  CryptoWalletDisconnectBlockedError,
  CryptoWalletIdentityMismatchError,
  CryptoWalletNotFoundError,
} from '@/contracts/crypto';

const ACTIVE_PAYMENT_STATUSES: CryptoPaymentStatus[] = [
  CryptoPaymentStatus.AWAITING_APPROVAL,
  CryptoPaymentStatus.PREPARED,
  CryptoPaymentStatus.EXECUTING,
  CryptoPaymentStatus.SUBMITTED,
  CryptoPaymentStatus.SUBMISSION_UNKNOWN,
  CryptoPaymentStatus.CONFIRMING,
  CryptoPaymentStatus.RECONCILING,
];

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export interface VerifiedCdpUser {
  userId: string;
  smartAccountAddresses: string[];
}

export interface CdpUserVerifier {
  validateAccessToken(accessToken: string): Promise<VerifiedCdpUser>;
}

export interface CdpAccessTokenClient {
  endUser: {
    validateAccessToken(options: { accessToken: string }): Promise<{
      userId: string;
      evmSmartAccountObjects: Array<{ address: string }>;
    }>;
  };
}

function validationFailureReason(error: unknown): CdpSessionValidationError['reason'] {
  if (!error || typeof error !== 'object') return 'provider_unavailable';
  const candidate = error as {
    status?: number;
    statusCode?: number;
    response?: { status?: number };
  };
  const status = candidate.statusCode ?? candidate.status ?? candidate.response?.status;
  return status && status >= 400 && status < 500 ? 'invalid_session' : 'provider_unavailable';
}

export class CdpSdkUserVerifier implements CdpUserVerifier {
  private readonly client: CdpAccessTokenClient;

  constructor(client?: CdpAccessTokenClient) {
    if (!env.CRYPTO_PAYMENTS_ENABLED) throw new CryptoFeatureDisabledError();
    if (client) {
      this.client = client;
      return;
    }

    // Keep CDP SDK internals outside deterministic Jest module loading. The
    // production CommonJS runtime resolves the SDK only when crypto is enabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { CdpClient } = require('@coinbase/cdp-sdk') as typeof import('@coinbase/cdp-sdk');
    this.client = new CdpClient({
      apiKeyId: env.CDP_API_KEY_ID,
      apiKeySecret: env.CDP_API_KEY_SECRET,
      walletSecret: env.CDP_WALLET_SECRET,
    });
  }

  async validateAccessToken(accessToken: string): Promise<VerifiedCdpUser> {
    try {
      const user = await this.client.endUser.validateAccessToken({ accessToken });
      return {
        userId: user.userId,
        smartAccountAddresses: user.evmSmartAccountObjects.map((account) => account.address),
      };
    } catch (error) {
      throw new CdpSessionValidationError(validationFailureReason(error));
    }
  }
}

let defaultVerifier: CdpUserVerifier | undefined;

function getDefaultVerifier(): CdpUserVerifier {
  defaultVerifier ??= new CdpSdkUserVerifier();
  return defaultVerifier;
}

function normalizeAddress(address: string): string {
  if (!EVM_ADDRESS.test(address)) throw new CdpSessionValidationError('invalid_session');
  return address.toLowerCase();
}

export interface BindCustomerWalletInput {
  accessToken: string;
  smartAccountAddress: string;
}

export async function bindCustomerWallet(
  userId: string,
  input: BindCustomerWalletInput,
  verifier: CdpUserVerifier = getDefaultVerifier(),
): Promise<CryptoWalletAccount> {
  const verifiedUser = await verifier.validateAccessToken(input.accessToken);
  const customerAddress = normalizeAddress(input.smartAccountAddress);
  const verifiedAddresses = verifiedUser.smartAccountAddresses.map(normalizeAddress);
  if (!verifiedAddresses.includes(customerAddress)) {
    throw new CdpSessionValidationError('invalid_session');
  }

  try {
    return await prisma.$transaction(async (tx) => {
      const claimed = await tx.cryptoWalletAccount.findFirst({
        where: {
          OR: [
            { customerAccountId: verifiedUser.userId },
            { network: CryptoNetwork.BASE_SEPOLIA, customerAddress },
          ],
        },
      });
      if (claimed && claimed.userId !== userId) throw new CryptoWalletAlreadyBoundError();

      const existing = await tx.cryptoWalletAccount.findUnique({
        where: { userId_network: { userId, network: CryptoNetwork.BASE_SEPOLIA } },
      });
      if (existing) {
        if (
          existing.customerAccountId !== verifiedUser.userId ||
          existing.customerAddress.toLowerCase() !== customerAddress
        ) {
          throw new CryptoWalletIdentityMismatchError();
        }

        const wallet = await tx.cryptoWalletAccount.update({
          where: { id: existing.id },
          data: {
            disconnectedAt: null,
            status: existing.executorAddress
              ? CryptoWalletStatus.ACTIVE
              : CryptoWalletStatus.PROVISIONING,
          },
        });
        await writeWalletAudit(tx, userId, 'CRYPTO_WALLET_RECONNECTED', wallet);
        return wallet;
      }

      const wallet = await tx.cryptoWalletAccount.create({
        data: {
          userId,
          network: CryptoNetwork.BASE_SEPOLIA,
          chainId: 84532,
          customerAddress,
          customerAccountId: verifiedUser.userId,
          status: CryptoWalletStatus.PROVISIONING,
        },
      });
      await writeWalletAudit(tx, userId, 'CRYPTO_WALLET_BOUND', wallet);
      return wallet;
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new CryptoWalletAlreadyBoundError();
    }
    throw error;
  }
}

async function writeWalletAudit(
  tx: Prisma.TransactionClient,
  userId: string,
  event: string,
  wallet: CryptoWalletAccount,
): Promise<void> {
  await tx.auditEvent.create({
    data: {
      intentId: null,
      actor: userId,
      event,
      payload: {
        walletAccountId: wallet.id,
        network: wallet.network,
        chainId: wallet.chainId,
        customerAddress: wallet.customerAddress,
        customerAccountId: wallet.customerAccountId,
      } as Prisma.JsonObject,
    },
  });
}

export async function disconnectCustomerWallet(userId: string): Promise<CryptoWalletAccount> {
  return prisma.$transaction(async (tx) => {
    const wallet = await tx.cryptoWalletAccount.findUnique({
      where: { userId_network: { userId, network: CryptoNetwork.BASE_SEPOLIA } },
      include: {
        spendPermissions: {
          where: { status: CryptoPermissionStatus.ACTIVE },
          select: { id: true },
          take: 1,
        },
        cryptoPayments: {
          where: { status: { in: ACTIVE_PAYMENT_STATUSES } },
          select: { id: true },
          take: 1,
        },
      },
    });
    if (!wallet) throw new CryptoWalletNotFoundError();
    if (wallet.spendPermissions.length > 0 || wallet.cryptoPayments.length > 0) {
      throw new CryptoWalletDisconnectBlockedError();
    }

    const disconnected = await tx.cryptoWalletAccount.update({
      where: { id: wallet.id },
      data: { status: CryptoWalletStatus.CLOSED, disconnectedAt: new Date() },
    });
    await writeWalletAudit(tx, userId, 'CRYPTO_WALLET_DISCONNECTED', disconnected);
    return disconnected;
  });
}

export async function getCustomerWallet(userId: string) {
  return prisma.cryptoWalletAccount.findUnique({
    where: { userId_network: { userId, network: CryptoNetwork.BASE_SEPOLIA } },
    include: {
      spendPermissions: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });
}
