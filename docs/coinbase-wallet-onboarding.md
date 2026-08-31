# Customer wallet onboarding

The `web/` application is the operational customer surface for Coinbase User
Wallet setup. It is fixed to Base Sepolia, CDP Smart Accounts, and testnet USDC.

## Operator setup

1. Open **CDP Portal → Wallets → Non-custodial → Clients** and select the
   development project.
2. Add the exact local origin `http://localhost:5173` to the domain allowlist.
3. Put the public Project ID in `web/.env.local`:

   ```dotenv
   VITE_CDP_PROJECT_ID=<development-project-id>
   ```

4. Keep `CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`, and `CDP_WALLET_SECRET` only in
   the backend environment. Never add a `VITE_` prefix to those values.
5. Enable the backend testnet configuration described in
   [Coinbase setup](coinbase-setup.md), then run the API and frontend:

   ```bash
   npm run dev
   npm run web:dev
   ```

The frontend runs at `http://localhost:5173` and proxies `/v1` to the API at
`http://127.0.0.1:3000`. The AgentWallet API key is held only in React memory;
refreshing or closing the tab requires it again.

## Customer flow

The customer authenticates their existing AgentWallet account, signs in to CDP
with email, SMS, or Google, and receives or recovers the same Smart Account. The
provider configuration creates new accounts with Spend Permissions enabled.

Binding requires two independent proofs in one request:

- the AgentWallet bearer key selects the current AgentWallet customer;
- the short-lived CDP access token is validated server-side by Coinbase and must
  contain the submitted Smart Account address.

The backend lowercases the verified address and uniquely stores both the CDP user
ID and Smart Account address. A conflicting customer receives `409`; raw access
tokens and backend CDP credentials are never written to audit events or responses.

The wallet view shows the onchain Base Sepolia USDC balance, Smart Account,
executor state, and current Spend Permission. Customers can copy the funding
address, open the CDP faucet, create a bounded permission when an executor exists,
revoke it, and disconnect. Disconnect is rejected while a stored active permission
or crypto payment exists, and it closes rather than deletes the wallet record.

## Production domains

Use a separate production CDP project. Allowlist only the exact HTTPS production
origin and do not include localhost. Serve the frontend and `/v1` API from the same
site or configure a narrowly scoped API CORS policy with credentials disabled.

Set only `VITE_CDP_PROJECT_ID` in the browser deployment. Build-time and source-map
checks can be run with:

```bash
npm run web:test:secrets
```

This test injects backend-secret sentinels while building and fails if either value
appears in a browser asset or source map.

## Tests

```bash
npm run web:test
```

Playwright uses the deterministic CDP adapter and mocked AgentWallet endpoints. It
covers desktop and mobile layouts, rejected OTP and signature requests, missing
Smart Accounts, network mismatch, binding, permission lifecycle, and disconnect.

The opt-in CDP access-token smoke test requires:

```dotenv
CDP_LIVE_ACCESS_TOKEN=<short-lived-user-access-token>
CDP_LIVE_USER_ID=<expected-cdp-user-id>
CDP_LIVE_SMART_ACCOUNT_ADDRESS=<expected-smart-account-address>
```

Run it immediately after signing in because CDP access tokens expire after roughly
15 minutes:

```bash
npx jest --runInBand tests/integration/coinbase/customerWallet.live.test.ts
```

## References

- [User Wallet quickstart](https://docs.cdp.coinbase.com/wallets/quickstart/user-auth)
- [Authentication implementation guide](https://docs.cdp.coinbase.com/wallets/authentication/implementation-guide)
- [Smart Accounts](https://docs.cdp.coinbase.com/wallets/using-wallets/smart-accounts)
- [Spend Permissions](https://docs.cdp.coinbase.com/wallets/using-wallets/spend-permissions)
- [Domain allowlisting](https://docs.cdp.coinbase.com/wallets/security-and-policies/domain-allowlisting)
