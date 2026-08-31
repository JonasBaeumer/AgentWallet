import { expect, Page, test } from '@playwright/test';

const SMART_ACCOUNT = `0x${'1'.repeat(40)}`;
const EXECUTOR = `0x${'3'.repeat(40)}`;

async function mockAgentWalletApi(page: Page, chainId = 84532) {
  await page.route('**/v1/users/me', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer aw_test_customer_key_123456');
    await route.fulfill({ json: { id: 'user-1', email: 'customer@example.com' } });
  });
  await page.route('**/v1/crypto/wallet', async (route) => {
    await route.fulfill({ json: { wallet: null } });
  });
  await page.route('**/v1/crypto/wallet/bind', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      accessToken: 'mock-cdp-access-token',
      smartAccountAddress: SMART_ACCOUNT,
    });
    await route.fulfill({
      json: {
        wallet: {
          id: 'wallet-1',
          network: 'base-sepolia',
          chainId,
          customerAddress: SMART_ACCOUNT,
          executorAddress: EXECUTOR,
          status: 'ACTIVE',
          disconnectedAt: null,
          permission: null,
        },
      },
    });
  });
  await page.route('**/v1/crypto/wallet/disconnect', async (route) => {
    await route.fulfill({ json: { disconnected: true } });
  });
}

async function authenticateAgentWallet(page: Page) {
  await page.getByLabel('AgentWallet API key').fill('aw_test_customer_key_123456');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your Smart Account' })).toBeVisible();
}

async function signInToCoinbase(page: Page) {
  await page.getByLabel('Email address').fill('customer@example.com');
  await page.getByRole('button', { name: 'Send code' }).click();
  await page.getByLabel('Verification code').fill('000000');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('alert')).toContainText('incorrect or expired');
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button', { name: 'Verify' }).click();
  await expect(page.getByRole('heading', { name: 'Connect it to AgentWallet' })).toBeVisible();
}

test('completes wallet onboarding, handles rejected signatures, revokes, and disconnects', async ({
  page,
}, testInfo) => {
  await mockAgentWalletApi(page);
  await page.goto('/');
  await authenticateAgentWallet(page);
  await signInToCoinbase(page);
  await page.getByRole('button', { name: 'Connect Smart Account' }).click();

  await expect(page.getByRole('heading', { name: 'Crypto wallet' })).toBeVisible();
  await expect(page.getByText('24.50 USDC')).toBeVisible();
  await expect(page.getByText('Ready')).toBeVisible();

  await page.getByLabel('Allowance').fill('13');
  await page.getByRole('button', { name: 'Create permission' }).click();
  await expect(page.getByRole('alert')).toContainText('signature was rejected');

  await page.getByLabel('Allowance').fill('5');
  await page.getByRole('button', { name: 'Create permission' }).click();
  await expect(page.getByText('Active')).toBeVisible();
  await expect(page.getByText('5.00 USDC')).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('wallet-dashboard.png'), fullPage: true });

  await page.getByRole('button', { name: 'Revoke permission' }).click();
  await expect(page.getByRole('button', { name: 'Create permission' })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect' }).click();
  await page.getByRole('button', { name: 'Confirm disconnect' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in to your Smart Account' })).toBeVisible();
});

test('shows missing-wallet and network-mismatch recovery states on a mobile viewport', async ({
  page,
}) => {
  await mockAgentWalletApi(page, 1);
  await page.goto('/?mock=missing-wallet');
  await authenticateAgentWallet(page);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Smart Account unavailable' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await page.goto('/');
  await authenticateAgentWallet(page);
  await page.getByRole('button', { name: 'Continue with Google' }).click();
  await page.getByRole('button', { name: 'Connect Smart Account' }).click();
  await expect(page.getByRole('heading', { name: 'Unsupported network' })).toBeVisible();
});
