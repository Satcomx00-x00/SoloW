# GateControl — developer tasks (Bun workspace)
# Usage: `make <target>` — run `make help` for the list.

SHELL := bash
.DEFAULT_GOAL := help
.PHONY: help install clean build lint format typecheck test smoke e2e e2e-critical \
	audit audit-executor-boundary secretscan verify dev dev-web flags \
	dev-orchestrator update db-generate db-migrate db-seed openapi openapi-check

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (bun)
	bun install

clean: ## Remove node_modules and all build/output artifacts
	find . -name node_modules -type d -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type d \( -name dist -o -name build -o -name .next -o -name coverage \) -prune -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name '*.tsbuildinfo' -delete 2>/dev/null || true
	@echo "cleaned node_modules + build artifacts"

lint: ## Lint + format-check with Biome
	bun run lint

format: ## Auto-format the codebase with Biome
	bun run format

typecheck: ## Typecheck every workspace package
	bun run typecheck

build: install lint typecheck db-generate openapi-check ## Install, lint, typecheck, migrations, OpenAPI
	cd apps/web && bun --bun run build
	@echo "build complete (lint + typecheck + migrations + openapi + SPA bundle)."


test: ## Run all unit tests (per-package, picks up each bunfig preload)
	bun run test

smoke: ## Run the end-to-end smoke test (in-memory DB, fake agent, temp git repo)
	bun run scripts/smoke.ts

e2e: ## Run the Playwright E2E suite (boots the SPA + an orchestrator harness)
	bunx playwright test

e2e-critical: ## Run only the @critical isolation E2E — this one blocks merge
	bunx playwright test --grep @critical

audit: ## Dependency audit at the project severity threshold
	bun run audit

audit-executor-boundary: ## No direct host access (Bun.spawn/$/fs) outside the local Executor (issue #1)
	bun run audit:executor-boundary

.PHONY: audit-provider-branching
audit-provider-branching: ## No product code branching on a provider's id (issue #122, Decision 0016)
	bun run scripts/audit-provider-branching.ts

secretscan: ## Scan the repository and its history for committed secrets
	bun run secretscan

verify: lint typecheck test smoke openapi-check audit audit-executor-boundary audit-provider-branching secretscan e2e ## Every quality gate, in order
	@echo "all quality gates passed"

dev: ## Start ALL services (web :5000 + orchestrator :5001 + Inngest Dev Server :8288) with hot reload; auto-migrates+seeds
	bun run dev

dev-web: ## Start only the web app (SPA + API) on :5000
	bun run dev:web

dev-orchestrator: ## Start only the orchestrator (WebSocket hub) on :5001
	bun run dev:orchestrator

update: ## Update dependencies to the latest allowed versions
	bun update
	@echo "dependencies updated — run 'make test' to verify"

db-generate: ## Generate the SQLite migration from the Drizzle schema
	bun run db:generate

db-migrate: ## Apply migrations to the local SQLite database
	bun run db:migrate

db-seed: ## Seed the local database with the two-Workspace fixture
	bun run db:seed

flags: ## List feature flags per Workspace (enable: bun run flag enable ff-core-program)
	bun run flag list

openapi: ## Generate openapi.json from the tRPC routers
	bun run openapi:gen

openapi-check: ## Fail if openapi.json is stale (CI gate)
	bun run openapi:check
