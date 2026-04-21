## Trusted Payment Infrastructure for Agents — developer Makefile
##
## Thin wrappers around `npm run` scripts and scripts/setup.sh so common dev
## workflows are discoverable via `make help`. Use `make -n <target>` to dry-run.

SHELL := /usr/bin/env bash

.DEFAULT_GOAL := help
.PHONY: help setup dev worker test test-integration migrate migrate-create seed reset lint format format-check build clean infra infra-down

help: ## Show this help.
	@awk 'BEGIN {FS = ":.*##"; printf "\nAvailable targets:\n"} /^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

setup: ## One-command first-run setup (prereqs, .env, docker, migrate, seed).
	./scripts/setup.sh

dev: ## Start the Fastify dev server with hot reload.
	npm run dev

worker: ## Start the stub BullMQ worker (simulates OpenClaw locally).
	npm run worker

test: ## Run fast unit tests (no DB/Redis required).
	npm test

test-integration: ## Run integration tests (requires docker compose up -d).
	npm run test:integration

migrate: ## Apply pending Prisma migrations (deploy mode, CI-safe).
	npx prisma migrate deploy

migrate-create: ## Create and apply a new Prisma migration (interactive).
	npm run db:migrate

seed: ## Seed the database with the demo user.
	npm run seed

reset: ## Reset the database (drops all data) and re-run migrations + seed.
	npm run db:reset

lint: ## Run ESLint across src + tests.
	npm run lint

format: ## Format all TypeScript sources with Prettier.
	npm run format

format-check: ## Verify Prettier formatting without writing.
	npm run format:check

build: ## Compile TypeScript to dist/.
	npm run build

infra: ## Start Postgres + Redis via docker compose.
	docker compose up -d

infra-down: ## Stop Postgres + Redis containers.
	docker compose down

clean: ## Remove build artefacts and node_modules.
	rm -rf dist node_modules
