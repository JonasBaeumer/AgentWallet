jest.mock('@/api/middleware/userAuth', () => ({
  userAuthMiddleware: jest.fn(async (request: { user?: unknown }) => {
    request.user = { id: 'user-1' };
  }),
}));

jest.mock('@/crypto/customerWalletService', () => ({
  bindCustomerWallet: jest.fn(),
  disconnectCustomerWallet: jest.fn(),
  getCustomerWallet: jest.fn(),
}));

import Fastify from 'fastify';
import { CryptoNetwork, CryptoWalletStatus } from '@prisma/client';
import { cryptoWalletRoutes } from '@/api/routes/cryptoWallet';
import {
  bindCustomerWallet,
  disconnectCustomerWallet,
  getCustomerWallet,
} from '@/crypto/customerWalletService';
import {
  CdpSessionValidationError,
  CryptoFeatureDisabledError,
  CryptoWalletAlreadyBoundError,
  CryptoWalletDisconnectBlockedError,
  CryptoWalletIdentityMismatchError,
  CryptoWalletNotFoundError,
} from '@/contracts';

const mockBind = bindCustomerWallet as jest.MockedFunction<typeof bindCustomerWallet>;
const mockDisconnect = disconnectCustomerWallet as jest.MockedFunction<
  typeof disconnectCustomerWallet
>;
const mockGet = getCustomerWallet as jest.MockedFunction<typeof getCustomerWallet>;

function walletRecord() {
  return {
    id: 'wallet-1',
    userId: 'user-1',
    network: CryptoNetwork.BASE_SEPOLIA,
    chainId: 84532,
    customerAddress: `0x${'1'.repeat(40)}`,
    customerAccountId: 'cdp-user-1',
    executorAddress: null,
    executorAccountId: null,
    executorAccountName: null,
    status: CryptoWalletStatus.PROVISIONING,
    disconnectedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    spendPermissions: [],
  };
}

async function app() {
  const instance = Fastify();
  await instance.register(cryptoWalletRoutes);
  await instance.ready();
  return instance;
}

describe('crypto wallet onboarding routes', () => {
  beforeEach(() => jest.clearAllMocks());

  it('returns only public wallet fields', async () => {
    mockGet.mockResolvedValue(walletRecord());
    const instance = await app();

    const response = await instance.inject({ method: 'GET', url: '/v1/crypto/wallet' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      wallet: {
        id: 'wallet-1',
        network: 'base-sepolia',
        chainId: 84532,
        customerAddress: `0x${'1'.repeat(40)}`,
        executorAddress: null,
        status: 'PROVISIONING',
        disconnectedAt: null,
        permission: null,
      },
    });
    await instance.close();
  });

  it('passes the access token only to the server-side verifier and never echoes it', async () => {
    const wallet = walletRecord();
    mockBind.mockResolvedValue(wallet);
    mockGet.mockResolvedValue(wallet);
    const instance = await app();

    const response = await instance.inject({
      method: 'POST',
      url: '/v1/crypto/wallet/bind',
      payload: {
        accessToken: 'short-lived-cdp-token',
        smartAccountAddress: wallet.customerAddress,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(mockBind).toHaveBeenCalledWith('user-1', {
      accessToken: 'short-lived-cdp-token',
      smartAccountAddress: wallet.customerAddress,
    });
    expect(response.body).not.toContain('short-lived-cdp-token');
    expect(response.body).not.toContain('customerAccountId');
    await instance.close();
  });

  it.each([
    [new CryptoFeatureDisabledError(), 503, 'crypto_onboarding_disabled'],
    [new CdpSessionValidationError('invalid_session'), 401, 'invalid_session'],
    [new CdpSessionValidationError('provider_unavailable'), 502, 'provider_unavailable'],
    [new CryptoWalletAlreadyBoundError(), 409, 'wallet_already_bound'],
    [new CryptoWalletIdentityMismatchError(), 409, 'wallet_identity_mismatch'],
  ])('maps binding failure %s to a stable response', async (error, status, code) => {
    mockBind.mockRejectedValue(error);
    const instance = await app();

    const response = await instance.inject({
      method: 'POST',
      url: '/v1/crypto/wallet/bind',
      payload: {
        accessToken: 'token',
        smartAccountAddress: `0x${'1'.repeat(40)}`,
      },
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code });
    await instance.close();
  });

  it.each([
    [new CryptoWalletDisconnectBlockedError(), 409, 'wallet_disconnect_blocked'],
    [new CryptoWalletNotFoundError(), 404, 'wallet_not_found'],
  ])('maps disconnect failure %s to a stable response', async (error, status, code) => {
    mockDisconnect.mockRejectedValue(error);
    const instance = await app();

    const response = await instance.inject({
      method: 'POST',
      url: '/v1/crypto/wallet/disconnect',
    });

    expect(response.statusCode).toBe(status);
    expect(response.json()).toEqual({ error: code });
    await instance.close();
  });
});
