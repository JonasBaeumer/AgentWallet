jest.mock('@/config/env', () => ({
  env: {
    CRYPTO_PAYMENTS_ENABLED: true,
    CDP_API_KEY_ID: 'test-id',
    CDP_API_KEY_SECRET: 'test-secret',
    CDP_WALLET_SECRET: 'test-wallet-secret',
  },
}));

import { CdpSessionValidationError } from '@/contracts';
import { CdpAccessTokenClient, CdpSdkUserVerifier } from '@/crypto/customerWalletService';

function clientReturning(result: unknown): CdpAccessTokenClient {
  return {
    endUser: {
      validateAccessToken: jest.fn().mockResolvedValue(result),
    },
  } as CdpAccessTokenClient;
}

describe('CDP user access-token verifier', () => {
  it('returns only stable identity and Smart Account addresses', async () => {
    const verifier = new CdpSdkUserVerifier(
      clientReturning({
        userId: 'cdp-user-1',
        evmSmartAccountObjects: [
          { address: `0x${'1'.repeat(40)}`, ownerAddresses: [], createdAt: '2026-08-21' },
        ],
        authenticationMethods: { email: { email: 'private@example.com' } },
      }),
    );

    await expect(verifier.validateAccessToken('access-token')).resolves.toEqual({
      userId: 'cdp-user-1',
      smartAccountAddresses: [`0x${'1'.repeat(40)}`],
    });
  });

  it('maps rejected tokens to an invalid session without returning provider details', async () => {
    const client = clientReturning({});
    (client.endUser.validateAccessToken as jest.Mock).mockRejectedValue({
      statusCode: 401,
      message: 'provider response containing sensitive diagnostics',
    });
    const verifier = new CdpSdkUserVerifier(client);

    await expect(verifier.validateAccessToken('expired-token')).rejects.toMatchObject({
      name: 'CdpSessionValidationError',
      reason: 'invalid_session',
      message: expect.not.stringContaining('sensitive diagnostics'),
    });
  });

  it('distinguishes provider outages from invalid customer sessions', async () => {
    const client = clientReturning({});
    (client.endUser.validateAccessToken as jest.Mock).mockRejectedValue(new Error('timeout'));
    const verifier = new CdpSdkUserVerifier(client);

    await expect(verifier.validateAccessToken('valid-token')).rejects.toEqual(
      new CdpSessionValidationError('provider_unavailable'),
    );
  });

  it('fails closed on malformed Coinbase responses', async () => {
    const verifier = new CdpSdkUserVerifier(clientReturning({ userId: 'cdp-user-1' }));

    await expect(verifier.validateAccessToken('access-token')).rejects.toMatchObject({
      reason: 'provider_unavailable',
    });
  });
});
