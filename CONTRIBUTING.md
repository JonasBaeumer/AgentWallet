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

These rules must be configured in **Settings → Branches → Add rule** for the `main` branch:

- Direct pushes disabled (require a pull request)
- **Require at least 1 approving review** before merge
- **Require review from Code Owners** (enforces `.github/CODEOWNERS`)
- **Require signed commits** — all commits on the branch must be GPG- or SSH-signed
- All CI status checks must pass (lint, type-check, unit-test, integration-test)

The `.github/CODEOWNERS` file lists all four core contributors (`@JonasBaeumer`, `@georgyia`, `@aleksandr-gorbunov`, `@Hajuj`) as required reviewers for all files. GitHub will automatically request a review from the team on every PR and block merge until at least one approves.

### Setting up commit signing

If you haven't set up commit signing yet, the quickest path is SSH signing (Git ≥ 2.34):

```bash
# Tell Git to sign commits with your SSH key
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Or with a GPG key — see [GitHub's guide](https://docs.github.com/en/authentication/managing-commit-signature-verification).

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
