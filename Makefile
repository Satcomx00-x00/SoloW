# GateControl — developer tasks (Bun workspace)
# Usage: `make <target>` — run `make help` for the list.

SHELL := bash
.DEFAULT_GOAL := help
.PHONY: help install clean build typecheck test smoke start dev update db-generate db-migrate

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

typecheck: ## Typecheck every workspace package
	bun run typecheck

build: install typecheck db-generate ## Install, typecheck, and generate DB migrations
	@echo "build complete (typecheck + migrations). SPA bundling arrives with Phase 4."

test: ## Run all unit tests (bun test)
	bun test

smoke: ## Run the end-to-end smoke test (in-memory DB, fake agent, temp git repo)
	bun run scripts/smoke.ts

start: ## Start the orchestrator (WebSocket hub + workflow host)
	bun run apps/orchestrator/src/main.ts

dev: ## Start the orchestrator with hot reload
	bun run dev

update: ## Update dependencies to the latest allowed versions
	bun update
	@echo "dependencies updated — run 'make test' to verify"

db-generate: ## Generate the SQLite migration from the Drizzle schema
	bun run db:generate

db-migrate: ## Apply migrations to the local SQLite database
	bun run db:migrate
