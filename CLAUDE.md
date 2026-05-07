# CLAUDE.md

This file is loaded by every Claude Code session and agent teammate working in this repo.

## Project Overview

**Trusted Payment Infrastructure for Agents** — a backend system that lets AI agents (e.g. OpenClaw) complete shopping tasks on behalf of a user, with a one-time restricted budget, without ever accessing the user's real bank or card credentials.

The user approves a budget → the backend issues a restricted Stripe virtual card → the agent uses that card for a single checkout → the card is cancelled and the ledger is settled.

## Tech Stack

- **Runtime:** Node.js + TypeScript (strict mode)
- **HTTP:** Fastify
- **ORM:** Prisma + PostgreSQL
- **Queue:** BullMQ + Redis
- **Payments:** Stripe Issuing (test mode)
- **Validation:** Zod
- **Tests:** Jest

## Key Commands

```bash
# Install dependencies
npm install

# Database
npm run db:migrate              # run pending migrations
npm run db:reset                # reset and re-migrate (dev only)
npm run seed                    # create demo@agentpay.dev (link Telegram via /start <code> per docs/telegram-setup.md)
npx prisma studio               # browse DB in browser

# Dev
npm run dev                     # start Fastify server (ts-node-dev)
npm run worker                  # run stub BullMQ worker (simulates OpenClaw locally)

# Tests
npm test                               # all unit tests (no DB or Redis required)
npm run test:integration               # integration tests (requires docker compose up -d first)
npm test -- --testPathPattern=<module> # single module

# Local infra (required before running the dev server or integration tests)
docker compose up -d            # start Postgres + Redis
docker compose down

# Stripe webhooks (local dev)
stripe listen --forward-to localhost:3000/v1/webhooks/stripe
```

## Developer Guides

- Telegram manual testing (with and without OpenClaw): `docs/telegram-setup.md`
- OpenClaw HTTP API reference: `docs/openclaw.md`
- Do not add Co-Authored-By lines to commit messages.

## Architecture

```
Telegram bot ──────┐
OpenClaw worker ───┤──▶ API Gateway (Fastify)
Stripe webhooks ───┘          │
                              ├──▶ Orchestrator (state machine)
                              │         │
                              │         ├──▶ Payments Service (Stripe Issuing)
                              │         ├──▶ Policy & Approval Service
                              │         ├──▶ Ledger Service (Monzo pot simulation)
                              │         └──▶ Job Queue (BullMQ)
                              │                   │
                              │                   └──▶ Stub Worker (simulates OpenClaw)
                              └──▶ PostgreSQL (Prisma)
```

## Module Boundaries (file ownership per agent team)

| Module | Directory | Description |
|--------|-----------|-------------|
| Contracts | `src/contracts/` | Shared TypeScript types/interfaces — source of truth |
| DB | `prisma/`, `src/db/` | Schema, migrations, Prisma client |
| API Gateway | `src/api/`, `src/app.ts`, `src/server.ts` | Fastify routes, middleware, validators |
| Orchestrator | `src/orchestrator/` | PurchaseIntent state machine |
| Payments | `src/payments/` | Stripe Issuing card lifecycle |
| Policy + Ledger | `src/policy/`, `src/approval/`, `src/ledger/` | Rules engine, approvals, Monzo pots |
| Queue + Worker | `src/queue/`, `src/worker/`, `src/config/redis.ts` | BullMQ + stub worker |
| Telegram | `src/telegram/` | Bot client, approval notifications, user signup handler |

**Rule: never edit another module's files.** Cross-module calls use direct function imports from the published module interface, not HTTP.

## Shared Contracts

All shared TypeScript types and service interfaces live in `src/contracts/`. Import from there:

```ts
import { IntentStatus, IntentEvent, PolicyResult } from '@/contracts'
```

Never redefine types that already exist in `src/contracts/`. If a type is missing, add it there.

## Intent State Machine

```
RECEIVED → SEARCHING → QUOTED → AWAITING_APPROVAL → APPROVED → CARD_ISSUED → CHECKOUT_RUNNING → DONE
                                                   ↘ DENIED                                    ↘ FAILED
                                    (any active state) → EXPIRED
```

## Security Rules (non-negotiable)

- **Never store full card PAN, CVC, or expiry in the DB or logs.** `VirtualCard` stores only `stripeCardId` + `last4`.
- Card details are returned to the caller exactly once. `VirtualCard.revealedAt` is set on first reveal; subsequent calls throw `CardAlreadyRevealedError`.
- Worker endpoints (`/v1/agent/*`) require `X-Worker-Key` header verified against `WORKER_API_KEY` env var.
- Stripe webhooks must be verified with `stripe.webhooks.constructEvent()` before processing.
- All approval decisions use `intentId` as an idempotency key — no double-processing.

## Testing Requirements

Every module must have:
- **Unit tests** — pure logic, no DB/network (mock external deps with `jest.mock()`)
- **Integration tests** — real DB + Redis, covering the full module lifecycle

An agent must not commit until its own tests pass:
```bash
npm test -- --testPathPattern=<module>
```

Cross-module E2E tests live in `tests/integration/e2e/` and are owned by the QA agent.

## Environment Variables

```
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/agentpay
REDIS_URL=redis://localhost:6379
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
WORKER_API_KEY=local-dev-worker-key
TELEGRAM_BOT_TOKEN=...
TELEGRAM_WEBHOOK_SECRET=...
PORT=3000
```

Copy `.env.example` to `.env` for local dev.

## What Is NOT in Scope (yet)

- Real OpenClaw / Playwright worker (stub worker handles local testing)
- Production hardening, auth on user-facing routes, PII tokenization
