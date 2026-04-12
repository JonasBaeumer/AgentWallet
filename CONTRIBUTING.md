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

## Branch protection (main)

These rules are configured in **Settings → Branches** for the `main` branch:

- Direct pushes disabled (require a pull request)
- **Require at least 1 approving review** before merge
- **Require review from Code Owners** (enforces `.github/CODEOWNERS`)
- **Require signed commits** — all commits on the branch must be GPG- or SSH-signed
- All CI status checks must pass

The `.github/CODEOWNERS` file lists all four core contributors (`@JonasBaeumer`, `@georgyia`, `@aleksandr-gorbunov`, `@Hajuj`) as required reviewers for all files. GitHub will automatically request a review from the team on every PR and block merge until at least one approves.

### Setting up commit signing

If you haven't set up commit signing yet, the quickest path is SSH signing (Git ≥ 2.34):

```bash
git config --global gpg.format ssh
git config --global user.signingkey ~/.ssh/id_ed25519.pub
git config --global commit.gpgsign true
```

Or with a GPG key — see [GitHub's guide](https://docs.github.com/en/authentication/managing-commit-signature-verification).

## Pull request checklist

- [ ] Commits are signed
- [ ] New behaviour is covered by tests
