## Summary

<!-- What does this PR do? 1-3 sentences. Link the related issue: "Closes #123" -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Tests only
- [ ] Docs / config

## Module(s) affected

<!-- Check all that apply. Each module owns its own directory — do not edit another module's files. -->

- [ ] Contracts (`src/contracts/`)
- [ ] DB / Prisma (`prisma/`, `src/db/`)
- [ ] API Gateway (`src/api/`, `src/app.ts`)
- [ ] Orchestrator (`src/orchestrator/`)
- [ ] Payments (`src/payments/`)
- [ ] Policy / Approval (`src/policy/`, `src/approval/`)
- [ ] Ledger (`src/ledger/`)
- [ ] Queue / Worker (`src/queue/`, `src/worker/`)
- [ ] Telegram (`src/telegram/`)
- [ ] Tests / QA
- [ ] Docs / Tooling

## Checklist

- [ ] `npm test` passes locally
- [ ] New or changed logic has unit tests
- [ ] Integration tests added/updated if DB or Redis is touched
- [ ] No PAN, CVC, or card expiry is logged or stored (security rule)
- [ ] No new cross-module file edits (used function imports instead)
- [ ] Types added/updated in `src/contracts/` if shared across modules
- [ ] `.env.example` updated if new env vars are introduced

## How to test

<!-- Steps for the reviewer to verify this manually, e.g. seed data, curl commands, Stripe test mode steps -->

## Notes for reviewer

<!-- Anything non-obvious: tradeoffs made, known limitations, follow-up issues -->
