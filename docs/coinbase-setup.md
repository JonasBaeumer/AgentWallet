# Coinbase setup

AgentWallet's first crypto release is limited to Base Sepolia and testnet USDC. The
feature remains disabled until the wallet, permission, approval, execution, and
reconciliation issues linked from #166 have landed.

## Credential separation

| Value | Runtime | Sensitivity |
| --- | --- | --- |
| `CDP_API_KEY_ID` | Backend only | Secret operational credential; redact from logs |
| `CDP_API_KEY_SECRET` | Backend only | Secret; authorizes CDP API requests |
| `CDP_WALLET_SECRET` | Backend only | Secret; required for wallet signing operations |
| `VITE_CDP_PROJECT_ID` | Frontend only | Public project identifier |

No backend credential may use a `VITE_` prefix. Vite exposes every such value to
browser code. Store backend credentials in the deployment secret manager and grant
them only to the API and crypto worker processes that require signing access.

## CDP Portal setup

1. Create separate CDP projects and credentials for development and production.
2. Create a Secret API Key for the backend. Select only the API scopes required to
   manage the intended non-custodial wallet operations.
3. Do **not** grant the private-key Export scope. AgentWallet never imports or
   exports executor private keys.
4. Generate the project's Wallet Secret and place it directly in the environment's
   secret manager. Coinbase displays it once.
5. For the future customer wallet frontend, copy the Project ID into
   `VITE_CDP_PROJECT_ID` and allowlist each exact frontend origin in CDP Portal.
   For local development that origin is normally `http://localhost:3000`.

Where the CDP platform permits separate policies or credentials, use a runtime key
for wallet operations and a different operator credential for policy changes.
Neither credential should be available to an agent process or browser bundle.

## Local configuration

Use Node.js 22 and copy the environment template:

```bash
nvm use
cp .env.example .env
```

Leave `CRYPTO_PAYMENTS_ENABLED=false` for Stripe-only development. In this state,
Coinbase secrets and x402 limits are not required and are not retained in the
exported server configuration.

To validate the future testnet configuration, set all backend CDP credentials,
choose explicit x402 limits, and then enable the feature:

```dotenv
CRYPTO_PAYMENTS_ENABLED=true
CDP_NETWORK=base-sepolia
CDP_API_KEY_ID=<secret-manager-reference>
CDP_API_KEY_SECRET=<secret-manager-reference>
CDP_WALLET_SECRET=<secret-manager-reference>
CDP_EXECUTOR_ACCOUNT_PREFIX=agentwallet-executor
X402_MAX_PAYMENT_ATOMIC_UNITS=1000000
X402_CONFIRMATION_COUNT=2
X402_MAX_SUBMISSION_RETRIES=3
```

`X402_MAX_PAYMENT_ATOMIC_UNITS` is a lossless integer string in the token's atomic
units. The application rejects zero, negative, fractional, and uint256-overflowing
values. Confirmation count is limited to 1-64 and submission retries to 0-10.
Mainnet values are rejected even when the feature is disabled.

CDP named EVM accounts allow 2-36 alphanumeric or hyphen characters. The executor
prefix is limited to 20 lowercase characters and must end alphanumerically, leaving
16 characters for the deterministic customer suffix defined by #193.

The checked-in examples are placeholders, not usable credentials. Never put real
values in a GitHub issue, pull request, fixture, snapshot, shell history, or log.

## Customer prerequisites

The crypto payment UI is not available yet. After the dependent issues land, a
customer must complete these steps before an agent can pay:

1. Sign in through the CDP user-wallet flow and provision a Smart Account on Base
   Sepolia.
2. Fund the customer account with the supported testnet USDC and any gas required
   by the final account configuration.
3. Grant the dedicated AgentWallet executor a time-bounded USDC Spend Permission.
4. Approve the immutable x402 recipient, asset, network, amount, and expiry shown by
   AgentWallet.

Creating an account or adding credentials does not grant an agent permission to
spend. The onchain permission and AgentWallet approval are both required.

## Rotation and compromise response

The two backend credentials rotate differently, and conflating them produces the
wrong runbook. The Secret API Key supports an overlap window: the replacement and
the old key are both valid until you revoke the old one, so rotation needs no
outage. The Wallet Secret has no overlap; rotating it invalidates the previous
secret immediately, so rotation is a planned signing outage. The credential table
in [ADR 001](architecture/001-coinbase-crypto-payment-rail.md) records the same
split.

Rotate the Secret API Key on its own where possible:

1. Disable crypto payments and stop new payment submissions.
2. Allow submitted transactions to reconcile; do not blindly retry unknown jobs.
3. Create a least-privilege replacement key and update the secret manager.
4. Deploy, validate CDP read access and executor account lookup, then re-enable the
   feature.
5. Revoke the old API key and review audit logs for unexpected operations.

Rotating the Wallet Secret immediately invalidates the previous secret. Treat the
rotation as a signing outage: disable execution, rotate in CDP Portal, update every
signing process atomically, validate existing executor access, and reconcile all
in-flight payments before resuming. If compromise is suspected, also revoke active
customer permissions before rotating credentials.

Never delete or recreate executor account records as part of credential rotation.
Account identity and transaction history must remain stable across credentials.

## Production gate

`CDP_NETWORK=base` is intentionally rejected. Production enablement requires the
mainnet review and operational evidence listed in
[ADR 001](architecture/001-coinbase-crypto-payment-rail.md); changing an environment
variable is not sufficient.

## References

- [CDP API-key wallet quickstart](https://docs.cdp.coinbase.com/wallet-api/v2/introduction/quickstart)
- [CDP wallet authentication and Wallet Secret rotation](https://docs.cdp.coinbase.com/wallets/authentication/overview)
- [CDP API authentication](https://docs.cdp.coinbase.com/api-reference/v2/authentication)
- [CDP wallet import/export scopes](https://docs.cdp.coinbase.com/wallets/using-wallets/import-and-export)
- [CDP named-account constraints](https://docs.cdp.coinbase.com/server-wallets/v2/using-the-wallet-api/managing-accounts)
