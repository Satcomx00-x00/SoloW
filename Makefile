# SoloW — developer tasks (Bun workspace)
# Usage: `make <target>` — run `make help` for the list.

SHELL := bash
.DEFAULT_GOAL := help
.PHONY: help install clean build lint format typecheck test smoke smoke-tarball smoke-docker \
	test-docker-live e2e e2e-critical \
	audit audit-executor-boundary secretscan verify dev dev-web flags \
	dev-orchestrator update db-generate db-migrate db-bootstrap openapi openapi-check

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

smoke-tarball: ## Pack the CLI, install the tarball into a clean dir, and boot it (needs a build first)
	./scripts/smoke-tarball.sh

smoke-docker: ## Drive the Docker executor against a live daemon (SMOKE_DOCKER_REQUIRED=1 to forbid the skip)
	bun run smoke:docker

# The driver-agnostic Executor contract, run against a real daemon — `docker.live.test.ts`, which
# delegates to the shared conformance suite in `contract.ts` and is where the differential cases
# that compare what the driver decided against what the daemon actually did belong.
#
# `bun test` alone is not enough to gate it: without `SOLOW_TEST_DOCKER=1` that file registers a
# single visible `it.skip` and passes, which is exactly the green a run with no daemon must not be
# able to report. So the daemon is asked for first, and the same `SMOKE_DOCKER_REQUIRED` that
# `scripts/smoke-docker-executor.sh` reads decides which way "no daemon" goes — one switch for
# both live gates, set once in `.github/workflows/verify.yml`, rather than a second mechanism to
# keep in step with the first.
test-docker-live: ## Run the Executor contract against a live daemon (SMOKE_DOCKER_REQUIRED=1 to forbid the skip)
	@if docker info > /dev/null 2>&1; then \
		SOLOW_TEST_DOCKER=1 bun test apps/orchestrator/src/executor/docker.live.test.ts; \
	elif [ -n "$${SMOKE_DOCKER_REQUIRED:-}" ] && [ "$${SMOKE_DOCKER_REQUIRED}" != "0" ]; then \
		echo "test-docker-live FAILED — SMOKE_DOCKER_REQUIRED is set and no Docker daemon is reachable." >&2; \
		echo "Unset it if this host is deliberately expected not to have one; otherwise this gate" >&2; \
		echo "would report the same green as a run that proved the contract against a daemon." >&2; \
		exit 1; \
	else \
		echo "test-docker-live SKIPPED — no reachable Docker daemon (SMOKE_DOCKER_REQUIRED=1 forbids this skip)."; \
	fi

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

# `smoke-docker` and `test-docker-live` sit directly after `smoke`, and they are the only gates
# that run a container: every other check of the Docker executor is a unit test against a fake
# host, which agrees with whatever the driver says. They are placed here because a failure is
# cheapest to read once lint, types and the tests are green and before the long e2e run — and
# both *skip* on a machine with no daemon, which is right for a laptop and wrong for CI, so
# `.github/workflows/verify.yml` sets `SMOKE_DOCKER_REQUIRED=1` for both and a CI run with no
# daemon fails there instead.
verify: lint typecheck test smoke smoke-docker test-docker-live openapi-check audit audit-executor-boundary audit-provider-branching secretscan e2e ## Every quality gate, in order
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

db-bootstrap: ## Create the local Workspace and its agent catalog (idempotent)
	bun run db:bootstrap

flags: ## List feature flags per Workspace (enable: bun run flag enable ff-core-program)
	bun run flag list

openapi: ## Generate openapi.json from the tRPC routers
	bun run openapi:gen

openapi-check: ## Fail if openapi.json is stale (CI gate)
	bun run openapi:check
