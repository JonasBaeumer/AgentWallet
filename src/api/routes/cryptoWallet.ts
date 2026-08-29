import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { userAuthMiddleware } from '@/api/middleware/userAuth';
import {
  CdpSessionValidationError,
  CryptoFeatureDisabledError,
  CryptoWalletAlreadyBoundError,
  CryptoWalletDisconnectBlockedError,
  CryptoWalletIdentityMismatchError,
  CryptoWalletNotFoundError,
} from '@/contracts';
import {
  bindCustomerWallet,
  disconnectCustomerWallet,
  getCustomerWallet,
} from '@/crypto/customerWalletService';

const BindWalletSchema = z.object({
  accessToken: z.string().min(1).max(16_384),
  smartAccountAddress: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
});

function serializeWallet(wallet: NonNullable<Awaited<ReturnType<typeof getCustomerWallet>>>) {
  const permission = wallet.spendPermissions[0];
  return {
    id: wallet.id,
    network: 'base-sepolia',
    chainId: wallet.chainId,
    customerAddress: wallet.customerAddress,
    executorAddress: wallet.executorAddress,
    status: wallet.status,
    disconnectedAt: wallet.disconnectedAt,
    permission: permission
      ? {
          permissionHash: permission.permissionHash,
          tokenAddress: permission.tokenAddress,
          assetSymbol: permission.assetSymbol,
          tokenDecimals: permission.tokenDecimals,
          allowanceAtomic: permission.allowanceAtomic.toFixed(0),
          periodSeconds: permission.periodSeconds,
          validAfter: permission.validAfter,
          validUntil: permission.validUntil,
          status: permission.status,
          revokedAt: permission.revokedAt,
          lastSyncedAt: permission.lastSyncedAt,
        }
      : null,
  };
}

export async function cryptoWalletRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/v1/crypto/wallet', { preHandler: userAuthMiddleware }, async (request, reply) => {
    const wallet = await getCustomerWallet(request.user!.id);
    return reply.send({ wallet: wallet ? serializeWallet(wallet) : null });
  });

  fastify.post(
    '/v1/crypto/wallet/bind',
    { preHandler: userAuthMiddleware },
    async (request, reply) => {
      const parsed = BindWalletSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'invalid_wallet_binding' });
      }

      try {
        const wallet = await bindCustomerWallet(request.user!.id, parsed.data);
        const withPermission = await getCustomerWallet(request.user!.id);
        if (!withPermission) throw new Error(`Bound wallet disappeared: ${wallet.id}`);
        return reply.send({ wallet: serializeWallet(withPermission) });
      } catch (error) {
        if (error instanceof CryptoFeatureDisabledError) {
          return reply.status(503).send({ error: 'crypto_onboarding_disabled' });
        }
        if (error instanceof CdpSessionValidationError) {
          const status = error.reason === 'invalid_session' ? 401 : 502;
          return reply.status(status).send({ error: error.reason });
        }
        if (error instanceof CryptoWalletAlreadyBoundError) {
          return reply.status(409).send({ error: 'wallet_already_bound' });
        }
        if (error instanceof CryptoWalletIdentityMismatchError) {
          return reply.status(409).send({ error: 'wallet_identity_mismatch' });
        }
        throw error;
      }
    },
  );

  fastify.post(
    '/v1/crypto/wallet/disconnect',
    { preHandler: userAuthMiddleware },
    async (request, reply) => {
      try {
        const wallet = await disconnectCustomerWallet(request.user!.id);
        return reply.send({ disconnected: true, disconnectedAt: wallet.disconnectedAt });
      } catch (error) {
        if (error instanceof CryptoWalletDisconnectBlockedError) {
          return reply.status(409).send({ error: 'wallet_disconnect_blocked' });
        }
        if (error instanceof CryptoWalletNotFoundError) {
          return reply.status(404).send({ error: 'wallet_not_found' });
        }
        throw error;
      }
    },
  );
}
