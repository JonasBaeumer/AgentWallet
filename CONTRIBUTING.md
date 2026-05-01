# Contributing

## Prerequisites

- Node.js 20+
- Docker (for local integration tests)

## Getting started

```bash
git clone https://github.com/JonasBaeumer/trustedpaymentinfrastructureforagents.git
cd trustedpaymentinfrastructureforagents
cp .env.example .env        # fill in your values
npm ci
docker compose up -d        # start Postgres + Redis
npx prisma migrate dev
```

## Running checks locally

```bash
npm run lint          # ESLint
npm run format:check  # Prettier (read-only)
npm run format        # Prettier (auto-fix)
npx tsc --noEmit      # type check
npm test              # unit tests
npm run test:integration  # integration tests (requires Docker services running)
```

## CI pipeline

Every pull request targeting `main` runs four parallel jobs:

| Job | What it checks |
|-----|---------------|
| **Lint & Format** | ESLint + Prettier formatting |
| **Type Check** | `tsc --noEmit` |
| **Unit Tests** | Jest unit suite with coverage artifact |
| **Integration Tests** | Jest integration suite against Postgres 16 + Redis 7 service containers |

All four checks must pass before a PR can be merged.

## Branch protection (main)

- Direct pushes to `main` are disabled
- At least 1 approving review required
- All CI status checks must pass

## Required repository secrets

Configure these under **Settings → Secrets and variables → Actions**:

| Secret | Purpose |
|--------|---------|
| `STRIPE_SECRET_KEY` | Enables live Stripe integration tests (`sk_test_*` key) |

The integration test job runs without a real Stripe key — Stripe calls are skipped when the key is the placeholder value. Adding the secret enables the full Stripe integration suite.

## Pull request checklist

- [ ] `npm run lint` passes with no errors
- [ ] `npm run format:check` passes (run `npm run format` to fix)
- [ ] `npx tsc --noEmit` passes
- [ ] `npm test` passes
- [ ] New behaviour is covered by tests
- [ ] If routes in [`src/api/routes/`](src/api/routes) or schemas in [`src/api/validators/`](src/api/validators) changed, [`docs/api.md`](docs/api.md) is updated in the same PR to stay in sync (and with any OpenAPI spec once it lands).
