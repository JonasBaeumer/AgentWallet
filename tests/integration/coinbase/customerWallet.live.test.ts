import { CdpSdkUserVerifier } from '@/crypto/customerWalletService';

const liveConfiguration = {
  accessToken: process.env.CDP_LIVE_ACCESS_TOKEN,
  userId: process.env.CDP_LIVE_USER_ID,
  smartAccountAddress: process.env.CDP_LIVE_SMART_ACCOUNT_ADDRESS,
};

const live = Object.values(liveConfiguration).every(Boolean) ? describe : describe.skip;

live('CDP customer wallet access token', () => {
  it('validates the live user and recovers the expected Smart Account', async () => {
    const verifier = new CdpSdkUserVerifier();
    const user = await verifier.validateAccessToken(liveConfiguration.accessToken!);

    expect(user.userId).toBe(liveConfiguration.userId);
    expect(user.smartAccountAddresses.map((address) => address.toLowerCase())).toContain(
      liveConfiguration.smartAccountAddress!.toLowerCase(),
    );
  });
});
