# Tasks: Core Program — End-to-End Task Loop

**Plan ref**: [plan.md](./plan.md)
**Spec ref**: [spec.md](./spec.md)
**Feature slug**: `core-program`
**Feature flag**: `ff-core-program` (must be OFF at merge)
**Phase**: P1 (core loop) with P2/P3 stories tagged per task
**Total tasks**: 29
**Constitution ref**: `.specify/memory/constitution.md` (v1.3.0)

**Organization**: grouped by layer in dependency order (contracts → DB → DAL → services → API →
orchestrator → SPA → tests). The `@critical` Workspace/worktree-isolation E2E (TASK-027) MUST
pass before the PR is opened (Principle V). `[P]` = parallelizable (different files, no shared
dependency).

**Directive key** (from the constitution): I = Review-First · II = Safe Parallel Isolation ·
III = Durable/Resumable · IV = Credential Safety & Billing Integrity · V = Workspace Tenancy ·
VI = Test-First · VII = One Product/Two Deployments.

---

## Implementation Progress (2026-08-17)

Started via `/speckit-implement`. **Toolchain: Bun 1.3.14** (switched from pnpm/Node — no
`node-gyp`, so the DB uses Bun's built-in `bun:sqlite` via `drizzle-orm/bun-sqlite` instead of
`better-sqlite3`). Dependencies installed with `bun install`.

**VERIFIED this session** — all three packages typecheck clean (`bunx tsc --noEmit`), the
services tests pass (**9/9**, incl. the billing-integrity strip), and the generated migration
**applies cleanly** to a fresh SQLite DB (all 11 tables). `✅` = verified; `◑` = written,
verification pending; `☐` = not started.

- ✅ **TASK-001** flag registry — `apps/web/src/server/flags.ts`
- ✅ **TASK-002** Zod contracts — `packages/contracts/src/*`
- ✅ **TASK-003** Drizzle schema (11 tables, SQLite dialect) — `packages/db/src/schema.ts`
- ✅ **TASK-006** encrypted secret store + validated env modules — `packages/db/src/{secret-store,env}.ts`, `apps/web/src/server/env.ts`
- ✅ **TASK-004** migration generated + applies cleanly — `packages/db/migrations/0000_*.sql`
- ☐ **TASK-005** seed — pending
- Also scaffolded: monorepo config (`pnpm-workspace.yaml`, root `package.json`,
  `tsconfig.base.json`), `.gitignore`, `packages/db/drizzle.config.ts`.

Phase 2 (backend) — second `/speckit-implement` pass:
- ✅ **TASK-009** services (pure) — `apps/web/src/server/services/{task,issue,billing}.ts`
  (state machine, `deriveIssueStatus`, `resolveAgentRunEnv` billing-strip, concurrency, failure classify)
- ✅ **TASK-010** services tests — `services/{task,billing}.test.ts` (incl. subscription strips `ANTHROPIC_API_KEY`)
- ✅ **TASK-007** DAL (complete) — `apps/web/src/server/dal/{context,mappers,issue,task,secret,profile,repository,session,review}.ts`
  (server-only, `workspaceId`-filtered, `Result`, secret excluded from DTOs; orchestrator-only ciphertext path marked C1).

Phase 2 (API surface) — third `/speckit-implement` pass:
- ✅ **TASK-011** tRPC surface — `apps/web/src/server/{trpc,context,http,orchestrator-client}.ts`,
  `auth/session.ts`, `routers/{issue,task,profile,repository,review,secret,index}.ts`.
  Middleware enforces Parse→Authorize(session)→Ownership(workspaceId)→DTO + `ff-core-program`
  flag guard on every procedure. `task.launch` enforces the concurrency cap and emits an
  orchestrator event; `review.decide` records the decision (Principle I) and resumes the workflow.
  Known stubs: `auth/session.ts` (BetterAuth wiring TODO) and `orchestrator-client.ts` (Inngest
  wiring is Phase 3) throw explicitly rather than silently.
Refactor: pure services extracted to **`packages/core`** (shared by web + orchestrator — single
source of truth, Principle VII); `apps/web` imports them from there.

Phase 3 (orchestrator) — fourth pass, **VERIFIED** (typecheck + `bun test`):
- ✅ **TASK-014** agent runner — `apps/orchestrator/src/agent/runner.ts` (`AgentRunner` interface,
  `SpawnAgentRunner` via `Bun.spawn`, `FakeAgentRunner`). *Real ACP JSON-RPC handshake is a TODO
  behind the interface.*
- ✅ **TASK-015** worktree manager — `worktree/manager.ts` (provision from local path/remote URL,
  commit to new local branch, discard, cleanup, `hasChanges`) + helper tests.
- ✅ **TASK-016/017** billing guard + tests — `billing/guard.ts` (decrypt + `resolveAgentRunEnv`
  strip, concurrency, classify) + `guard.test.ts` (verifies subscription strips `ANTHROPIC_API_KEY`).
- ✅ **TASK-018** WebSocket hub — `ws/hub.ts` (workspace-scoped pub/sub) + `index.ts` `Bun.serve`
  WS server + tests. *Connection auth is a TODO.*
- ✅ **TASK-019** Inngest `task-run` — `inngest/functions/task-run.ts` (durable steps: load →
  provision → agent-run → `to-review` → `waitForEvent(review.decided)` → approve/reject/
  request-changes loop → park-on-quota → cleanup) + `data.ts` (orchestrator queries).
- **Not started:** TASK-013 (openapi export), TASK-008/012/020 (integration tests — need a real
  DB / Inngest harness), BetterAuth session wiring, Phase 4 (SPA), Phase 5 (E2E/gates).

**Verified with:** `bun install` → `bun run typecheck` (3/3 clean) → `bunx vitest run` (9/9) → `bun run db:generate` (+ applies clean to a fresh DB).

**Carried finding C1** (Principle IV credential nuance) is documented inline in
`secret-store.ts` and `apps/web/src/server/env.ts` as a v1 limitation to resolve for hosted.

Backend-completion pass (fifth `/speckit-implement`) — **VERIFIED** (biome + typecheck + tests + openapi):
- ✅ **TASK-005** seed — `packages/db/src/seed.ts` (+`db:seed`): two non-overlapping Workspaces,
  idempotent via fixed ids + `onConflictDoNothing`, secrets stored as ciphertext. `seed.test.ts` (3).
- ✅ **TASK-008** DAL isolation tests — already present (`dal/{issue,task,mappers}.test.ts`), confirmed
  covering cross-Workspace `NOT_FOUND`.
- ✅ **TASK-012** tRPC integration tests — `routers/index.test.ts` (9): auth, flag-OFF, cross-Workspace
  isolation, Zod validation, secret write-only, **rate-limit trip**, task ownership. Added the
  **rate limiter** (`rate-limit.ts`, TASK-011 gap) on `secret.set`/`task.launch`, and closed a
  **cross-tenant leak** in `task.create` (now verifies issue/agent/executor/repo ownership;
  added `getRepository`/`getExecutorProfile` DAL).
- ✅ **TASK-013** OpenAPI export — `src/openapi.ts` + `scripts/gen-openapi.ts` (+ `stub-server-only.ts`
  preload); `.meta()`/`.output()` on all 17 procedures; committed `apps/web/openapi.json`;
  `openapi:check` gate fails on drift. (`.output()` also strips the tenant key from profile DTOs.)
- ✅ **TASK-020** orchestrator integration test — refactored `task-run.ts` into injectable
  `runTaskLifecycle(deps, …)` (fake ACP agent + controllable step); `task-run.test.ts` (7): approve/
  reject/request-changes, park-on-quota→resume, hard-failure (worktree preserved), concurrent-Task
  isolation, no-secret-in-logs.
- ✅ **TASK-027** observability — new `packages/observability` (pino): structured logs, run-context
  child logger, state-transition + worktree→task audit lines, `captureException`, credential-key
  redaction. Wired into `task-run.ts`. `index.test.ts` (5).
- ✅ **TASK-028** retry — already implemented in `task.retry` (new session, prior session preserved).
- ➕ **Tooling (user request): BiomeJS** adopted as the lint/format toolchain — `biome.json`, root
  `lint`/`format`/`check` scripts, per-package `lint` switched off `eslint`, whole tree reformatted;
  Makefile `lint`/`format`/`db-seed`/`openapi` targets; `build` now runs lint + openapi-check.

**Verified with:** `bun install` → `bunx biome check .` (clean) → `bun run typecheck` (6/6) →
`bun run test` (**107 pass**) → `bun run openapi:check` (17 paths, current).

**Still not started:** Phase 4 SPA (TASK-021/022/023/024 — no Next.js/React scaffold yet), Phase 5
E2E (TASK-025 happy, TASK-026 @critical isolation — need the SPA + Playwright), and TASK-029 final
gates (lint/typecheck/tests/openapi pass now; `gitleaks` + dep-audit + E2E still pending).

Phase 4 vertical slice (sixth `/speckit-implement`) — **VERIFIED** (build under Bun + live data):
- ◑ **TASK-021** Kanban board — *vertical slice done*: Next.js 15 App-Router SPA (`apps/web/src/app`),
  tRPC React client (`src/trpc/react.ts` + `app/providers.tsx`), tRPC HTTP route handler
  (`app/api/trpc/[trpc]/route.ts` → existing `http.ts`), and a **board reading live data** —
  lifecycle columns from `task.list` with loading/error/empty states and accessible markup
  (`components/features/board/*`). *Follow-up for full TASK-021: dnd-kit drag + live WebSocket
  status updates + richer empty-state CTA.*
- ➕ **Next-under-Bun proven**: `bun --bun run build` compiles (bun:sqlite kept external via
  `serverExternalPackages` + webpack externals; NodeNext `.js` specifiers resolved via
  `resolve.extensionAlias`; Next's duplicate type/lint pass disabled — we gate with tsc + Biome).
  Running server verified: `task.list`/`issue.list` return the seeded WS_A rows only (WS_B not
  leaked — tenancy holds through SPA→tRPC→DAL→bun:sqlite); `/board`→200, `/`→307→`/board`.
- ➕ **Local dev-owner path**: `GATECONTROL_DEV_OWNER=on` → `context.ts` resolves a fixed Owner on
  the seeded Workspace with `ff-core-program` enabled (stand-in until BetterAuth is wired).
- ➕ **Fixed `db:migrate`**: replaced the broken `drizzle-kit migrate` (better-sqlite3 native binding
  fails under Bun) with a `bun:sqlite` migrator (`packages/db/src/migrate.ts`).

**Run the SPA locally** (from repo root):
`GATECONTROL_SQLITE_PATH=./.gatecontrol/dev.db GATECONTROL_SECRET_KEY=$(openssl rand -base64 32) \
 bun run db:migrate && … db:seed`, then in `apps/web`:
`GATECONTROL_DEV_OWNER=on GATECONTROL_AUTH_SECRET=dev … bun --bun run dev` → http://localhost:3000/board

**Verified with:** `bun --bun run build` (✓ compiled) → live `task.list` scoped to WS_A →
`bun run typecheck` (6/6) → `bun run test` (107 pass) → `bunx biome check .` (clean) → `openapi:check`.

**Still not started:** TASK-022 review workspace (xterm + diff), TASK-023 settings, TASK-024 client
tests, Phase 5 E2E (TASK-025/026), TASK-029 gitleaks/dep-audit.

Phase 4 settings pass (seventh `/speckit-implement`) — **VERIFIED** (build + live write path):
- ✅ **TASK-023** Settings — `/settings` page + four sections (`components/features/settings/*`):
  Secrets (write-only set + metadata list), Agent Profiles (auth mode + secret select + cap),
  Executor Profiles, Repositories (local path / remote URL). tRPC mutations with query
  invalidation; accessible labelled forms; submit disabled while pending; "add a secret first"
  guard. Live-smoked: `secret.set` creates without echoing the value; `secret.list` shows the
  new secret's metadata but **never the value** (Principle IV holds through the real stack).
- ➕ **`secret.list`** procedure added (metadata only — id/name/kind) + DAL `listSecretRefs`;
  OpenAPI now **18 paths**.
- ◑ **TASK-024** client tests — board rendering tests (`board-view.test.tsx`, 3) via happy-dom +
  Testing Library (empty-state per column, cards land in the matching column, failure reason
  shown). *Settings-form and review-interaction tests follow once those flows settle.*
- ➕ Board refactored to a pure `BoardView` (prop-driven) behind the tRPC `Board`; `/board` and
  `/settings` cross-link. `make test` now runs the per-package script (picks up the happy-dom
  preload).

**Verified with:** `bun --bun run build` (✓ /board + /settings) → live `secret.set`/`secret.list`
(no value leak) → typecheck 6/6 → **110 tests pass** → Biome clean → `openapi:check` (18 paths).

**Still not started:** TASK-021 full (dnd + live WS), TASK-022 review workspace (needs WS client),
board create-Issue/Task actions, Phase 5 E2E (TASK-025/026), TASK-029 gitleaks/dep-audit.

Phase 4 interactive-board pass (eighth `/speckit-implement`) — **VERIFIED** (build + live loop):
- ◑ **TASK-021** — board is now **interactive**: create-Issue + create-Task forms (`board-toolbar.tsx`,
  selectors from issue/agent/executor/repo lists), and per-card lifecycle actions (Backlog→Ready
  via `task.move`, Launch via `task.launch`). Live-smoked the whole chain: create issue → create
  task (backlog) → move (ready) → launch (**running**). *Remaining for full TASK-021: dnd-kit drag
  + live WebSocket status.*
- ➕ **Orchestrator-client dev degradation**: `enqueueTaskRun`/`resumeReview` log-and-return under
  `GATECONTROL_DEV_OWNER=on` (so the SPA launch/review flow is demonstrable without the durable
  service) and still **throw** in non-dev (missing wiring never silent).
- ➕ **TASK-024**: added a board-actions rendering test (`renderActions` wired through
  BoardView→Column→TaskCard).

**Verified with:** `bun --bun run build` ✓ → live create-issue→create-task→move→**launch=running** →
typecheck 6/6 → **111 tests pass** → Biome clean → `openapi:check`.

**Still not started:** TASK-021 dnd + live WS, TASK-022 review workspace, Phase 5 E2E (TASK-025/026),
TASK-029 gitleaks/dep-audit. (Review + real-time need the WS client + a running orchestrator/agent.)

---

## Phase 1 — Foundation (unblocks everything)

### TASK-001 — [P] Declare feature flag `ff-core-program`
*File*: `apps/web/server/flags.ts` · *Phase/Crit*: P1 / Critical · Scope: Both
**What**:
- Register `ff-core-program` with `default: false`, per-Workspace granularity, kill switch.
**Acceptance criteria**:
- [ ] Flag key `ff-core-program` exists in the registry with `default: false` (grep-verifiable).
- [ ] Flag evaluates to `false` on a clean environment.
**Directives**: VI, VII.

### TASK-002 — [P] Validation contracts (Zod)
*File*: `packages/contracts/schemas/*.ts` · *Phase/Crit*: P1 / Critical · Scope: Both
**What**:
- Input/DTO schemas per plan §2 (Issue, Task, LaunchTask, MoveTask, RetryTask, AgentProfile,
  ExecutorProfile, Repository, ReviewDecision, SetSecret, TaskEvent).
- `*ErrorCode` const literals.
**Acceptance criteria**:
- [ ] Compiles under `tsc --noEmit`; no `z.any()`/`z.unknown()` without narrowing.
- [ ] `workspaceId` absent from every input schema.
- [ ] Exported from a barrel; consumable by web and orchestrator.
**Directives**: VI.

### TASK-003 — Drizzle schema (11 tables)
*File*: `packages/db/schema/*.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-002
**What**:
- Tables per plan §1; every table has `id`, `workspaceId` (non-null FK), `createdAt`/`updatedAt`,
  index `(workspaceId, createdAt desc)` plus the per-table indexes listed.
- Driver selection in `packages/db/index.ts` (SQLite local / Postgres hosted).
**Acceptance criteria**:
- [ ] Every table carries a non-null `workspaceId`.
- [ ] `secret.ciphertext` present; no plaintext secret column.
- [ ] Inferred row/insert types exported.
**Directives**: V, VII.

### TASK-004 — Generate and review migration
*File*: `packages/db/migrations/` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-003
**What**:
- Generate with drizzle-kit; review line-by-line.
**Acceptance criteria**:
- [ ] Generated only — no handwritten SQL.
- [ ] Applies cleanly on a fresh local SQLite DB.
- [ ] No `NOT NULL` without default on populated tables; no unplanned `DROP`.
**Directives**: VI.

### TASK-005 — [P] Seed data (two Workspaces)
*File*: `packages/db/seed.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-004
**What**:
- Two Workspaces with non-overlapping Issues/Tasks/Profiles (for isolation tests).
**Acceptance criteria**:
- [X] Idempotent (safe to re-run).
- [X] Realistic data — no `test1`/`foo`.
**Directives**: V.

### TASK-006 — [P] Encrypted secret store + validated env module
*File*: `packages/db/secret-store.ts`, `apps/web/env.ts`, `apps/orchestrator/env.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-003
**What**:
- Encrypt-at-rest for `secret.ciphertext`; write-only read mapper (never returns plaintext to a DTO).
- Validated env module; no bare `process.env`.
**Acceptance criteria**:
- [ ] A stored secret is never returned by any DTO/list mapper.
- [ ] Env accessed only through the validated module (grep: no bare `process.env` outside it).
**Directives**: IV.

---

## Phase 2 — Backend (web / API)

### TASK-007 — DAL modules
*File*: `apps/web/server/dal/*.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-003
**What**:
- `import 'server-only'` first line; methods per plan §4; `Result<T,E>` returns.
- Every read: session → Workspace-ownership → `workspaceId` filter in every `where`; explicit columns.
- `getSecretForAgentRun` (orchestrator-only) returns plaintext into the agent env path, never a DTO.
**Acceptance criteria**:
- [ ] `server-only` present in every DAL file.
- [ ] Every query filters by `workspaceId`; no `SELECT *`.
- [ ] Returns `Result<T,E>`, never `any`/raw row; secrets excluded from DTO mappers.
**Directives**: IV, V.

### TASK-008 — [P] DAL tests (cross-Workspace isolation)
*File*: `apps/web/server/dal/*.test.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-007, TASK-005
**Acceptance criteria**:
- [X] Real SQLite (ephemeral, `createTestDb`); Workspace A cannot read Workspace B data.
- [X] No session / wrong Workspace enforcement covered at the router boundary (TASK-012); the DAL
      layer returns `NOT_FOUND` for cross-Workspace ids (non-leaking).
- [X] Passes with the project test runner (`bun test`).
**Directives**: V, VI.

### TASK-009 — [P] Services (pure, Result)
*File*: `apps/web/server/services/*.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-002
**What**:
- `canTransitionTask`, `deriveIssueStatus`, `buildCreateTaskPayload`, `resolveAgentRunEnv`,
  `withinConcurrencyCap`, `classifyRunFailure` (per plan §5). Zero infrastructure imports.
**Acceptance criteria**:
- [ ] No db/auth/framework imports; `Result<T,E>`, no throw on business errors.
- [ ] `resolveAgentRunEnv`: subscription → injects `CLAUDE_CODE_OAUTH_TOKEN`, strips
      `ANTHROPIC_API_KEY`; api_key → injects the key only.
**Directives**: IV.

### TASK-010 — [P] Services tests (100% branch)
*File*: `apps/web/server/services/*.test.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-009
**Acceptance criteria**:
- [ ] 100% branch coverage; every `*ErrorCode` asserted; no mocks.
- [ ] Asserts the subscription env strips `ANTHROPIC_API_KEY` and the api-key env does not.
- [ ] Task state-machine: every illegal transition rejected.
**Directives**: IV, VI.

### TASK-011 — tRPC routers + HTTP handler + auth guard
*File*: `apps/web/server/routers/*.ts`, `apps/web/app/api/trpc/[trpc]/route.ts`, `apps/web/server/auth/*` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-007, TASK-009
**What**:
- Procedures per plan §3; each: Parse (Zod) → Authorize (session) → Ownership (`workspaceId`) → DTO.
- Flag guard `ff-core-program` on every procedure; rate-limit `secret.set` and `task.launch`.
- `task.launch` emits Inngest event `task.launch.requested`.
- BetterAuth session + Workspace guard.
**Acceptance criteria**:
- [ ] Every procedure parses input, checks auth + ownership, returns a DTO (no raw row).
- [ ] Every procedure short-circuits when the flag is OFF.
- [ ] `secret.set` never echoes the value.
**Directives**: I, IV, V, VI.

### TASK-012 — [P] tRPC integration tests
*File*: `apps/web/server/routers/*.test.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-011
**Acceptance criteria**:
- [X] Real DB; no session → `UNAUTHORIZED`; cross-Workspace read → `NOT_FOUND` (non-leaking, chosen
      over `FORBIDDEN` so existence is not revealed); cross-tenant `task.create` reference rejected.
- [X] Flag OFF → procedures unavailable; invalid input → validation error.
- [X] Rate-limit trips on `secret.set`. *Idempotent-create (2×→no duplicate) NOT implemented — the v1
      contracts carry no idempotency key; deferred (would require a client key + dedup).* 
**Directives**: V, VI.

### TASK-013 — [P] OpenAPI export artifact
*File*: `apps/web/scripts/gen-openapi.ts`, `openapi.json` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-011
**What**:
- Generate `openapi.json` from the tRPC routers; commit as a build artifact; wire into build.
**Acceptance criteria**:
- [X] `openapi.json` is produced at build and describes every HTTP procedure (17 paths).
- [X] Build fails if the export is stale/uncommitted (`openapi:check`, wired into `make build`).
**Directives**: VII (API-surface constraint, Decision 0011).

---

## Phase 3 — Orchestrator (durable, long-lived)

### TASK-014 — ACP agent runner (Claude Code)
*File*: `packages/acp/*`, `apps/orchestrator/agent/acp-runner.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-006, TASK-009
**What**:
- Spawn/drive Claude Code via ACP (`@agentclientprotocol/sdk`, `claude-agent-acp`) with `node-pty`.
- Stream stdout/status/tool-use/diff as `session_event`s; accept input/stop.
- Inject only the resolved credential into the agent process env; never mount the secret store.
**Acceptance criteria**:
- [ ] Agent process receives only the single credential from `resolveAgentRunEnv`.
- [ ] Events are appended in order and are replayable.
- [ ] Stopping the agent terminates its process cleanly.
**Directives**: IV, and the uniform-agent boundary (Decision 0003).

### TASK-015 — Worktree manager
*File*: `apps/orchestrator/worktree/manager.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-003
**What**:
- Provision an isolated git worktree per Task; Repository source = local clone path OR remote URL
  (clone then worktree). On approve: commit onto a new local branch (no push/PR). Cleanup on Done/reject.
**Acceptance criteria**:
- [ ] Concurrent Tasks get separate worktrees; neither reads the other's files (II).
- [ ] Invalid local path / unreachable remote URL → Task Failed before the agent starts.
- [ ] Approved changes land on a new local branch; no push/PR performed.
**Directives**: II.

### TASK-016 — Billing & credential guard
*File*: `apps/orchestrator/billing/guard.ts` · *Phase/Crit*: P2 / Critical · Scope: BE · *Depends*: TASK-009
**What**:
- Enforce per-Agent-Profile concurrency cap (default 3); shape run env via `resolveAgentRunEnv`;
  classify failures into fail / park (quota) / credential-expired.
**Acceptance criteria**:
- [ ] No more than the cap of a profile's agents run at once; excess queues.
- [ ] Subscription-mode run cannot cause metered billing (env strip verified).
- [ ] Quota exhaustion classified as Park (not Fail).
**Directives**: IV.

### TASK-017 — [P] Billing guard tests
*File*: `apps/orchestrator/billing/*.test.ts` · *Phase/Crit*: P2 / High · Scope: BE · *Depends*: TASK-016
**Acceptance criteria**:
- [ ] Subscription env contains no `ANTHROPIC_API_KEY`; api-key env contains the key.
- [ ] Concurrency cap enforced; over-cap queued and warned.
**Directives**: IV, VI.

### TASK-018 — WebSocket hub
*File*: `apps/orchestrator/ws/server.ts`, `apps/web/components/hooks/useTaskStream.ts` · *Phase/Crit*: P1 / High · Scope: Both · *Depends*: TASK-014
**What**:
- Channels per plan §3 realtime; authenticate connections; scope subscriptions to the client's Workspace.
- Reconnect replays from the `session_event` log (no lost terminal history).
**Acceptance criteria**:
- [ ] A client can subscribe only to its own Workspace's channels.
- [ ] On reconnect, missed events are replayed from the event log.
**Directives**: V, and real-time observability (Decision 0011).

### TASK-019 — Inngest `task-run` workflow
*File*: `apps/orchestrator/inngest/functions/task-run.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-014, TASK-015, TASK-016
**What**:
- Durable steps per plan §9: provision-worktree → start-agent → stream → **await-review
  (`waitForEvent`)** → integrate/commit → cleanup. Park via `sleepUntil`; request-changes loops
  back; failure → Failed (worktree preserved); retry via new session.
**Acceptance criteria**:
- [ ] No change integrated without a recorded human review (I).
- [ ] Restarting the orchestrator mid-run resumes from the last completed step (III).
- [ ] Quota exhaustion → Parked, resumes on window reset; failure → Failed with worktree preserved.
**Directives**: I, III.

### TASK-020 — [P] Orchestrator integration tests
*File*: `apps/orchestrator/inngest/*.test.ts` · *Phase/Crit*: P1 / High · Scope: BE · *Depends*: TASK-019
**What**:
- Fake ACP agent fixture; Inngest test harness.
**Acceptance criteria**:
- [X] Resume/step-idempotency verified via `runTaskLifecycle` driven by a controllable step + fake
      ACP agent (true Inngest step-memoization is provided by the engine; the lifecycle is factored
      to be resumable). Every round is a discrete step.
- [X] Park-on-quota→resume, request-changes loop, approve/reject, and concurrent-Task isolation
      (one Task's failure does not affect the other's state/worktree) verified.
**Directives**: II, III, VI.

---

## Phase 4 — Frontend (Next.js SPA-style)

### TASK-021 — Kanban board (client)
*File*: `apps/web/app/(app)/board/*`, `apps/web/components/features/board/*` · *Phase/Crit*: P2 / High · Scope: FE · *Depends*: TASK-011, TASK-018
**What**:
- Columns for the lifecycle states; dnd-kit drag; live status via `board:{workspaceId}` WS;
  create Issue/Task; transition guarded by allowed transitions; confirm on moving a Running Task back.
**Acceptance criteria**:
- [ ] Columns cover Backlog/Ready/Running/Review/Parked/Done/Failed.
- [ ] Live status updates in near real time; illegal drags are rejected with a reason.
- [ ] All user-facing strings via i18n; interactive elements native/ARIA; submit disabled while pending.
**Directives**: I (surfaces the review state), accessibility.

### TASK-022 — Review workspace (client)
*File*: `apps/web/app/(app)/task/[id]/*`, `apps/web/components/features/review/*` · *Phase/Crit*: P1 / Critical · Scope: FE · *Depends*: TASK-011, TASK-018
**What**:
- xterm terminal (live agent stream + input), diff viewer, conversation; approve / reject /
  request-changes actions calling `review.decide`.
**Acceptance criteria**:
- [ ] Terminal streams agent activity and accepts input/stop.
- [ ] Diff is reviewable; approve/reject/request each records a decision and advances the Task.
- [ ] Destructive actions (reject) require confirmation.
**Directives**: I.

### TASK-023 — Settings: profiles, repositories, secrets (client)
*File*: `apps/web/app/(app)/settings/*` · *Phase/Crit*: P2 / High · Scope: FE · *Depends*: TASK-011
**What**:
- Create Agent Profile (authMode + concurrency cap), Executor Profile (local), connect
  Repository (local path / remote URL), set Secret (write-only).
**Acceptance criteria**:
- [X] Agent Profile lets the Owner choose Subscription or API Key and set the cap (default 3).
- [X] A set Secret is never displayed after entry (write-only; only id/name/kind listed — verified
      live that the value never appears in `secret.list`).
- [ ] Queuing more parallel subscription Tasks than the cap warns the user — deferred to the launch
      flow (the cap is *enforced* server-side today via `withinConcurrencyCap`; the pre-launch UI
      warning lands with the board launch action).
**Directives**: IV.

### TASK-024 — [P] Client component tests
*File*: `apps/web/components/features/**/*.test.tsx` · *Phase/Crit*: P2 / Medium · Scope: FE · *Depends*: TASK-021, TASK-022, TASK-023
**Acceptance criteria**:
- [ ] Board renders empty state with a CTA; renders cards when data present.
- [ ] Review actions disabled while a decision is pending.
**Directives**: VI.

---

## Phase 5 — E2E + Quality Gates

### TASK-025 — [P] E2E happy path
*File*: `e2e/core-program/happy.spec.ts` · *Phase/Crit*: P2 / High · Scope: FE · *Depends*: TASK-019, TASK-021, TASK-022
**What**:
- Owner: create Issue → create Task → launch → see live stream → review diff → approve → Task Done
  with a new local branch. Uses a deterministic fake agent.
**Acceptance criteria**:
- [ ] The full loop passes; selector-based waits only (no `waitForTimeout`).
- [ ] Rejecting a diff discards the worktree changes.
**Directives**: I, VI.

### TASK-026 — ⚠️ @critical E2E isolation (BLOCKS MERGE)
*File*: `e2e/core-program/isolation.spec.ts` · *Phase/Crit*: P1 / **Critical — blocks merge** · Scope: Both · *Depends*: TASK-011, TASK-015
**What**:
- Worktree isolation: two concurrent Tasks never observe each other's files.
- Workspace isolation (owner-vs-other): user on another Workspace's Task URL → 404; API call with
  another Workspace's key → 403.
**Acceptance criteria**:
- [ ] Tagged `@critical`; the `@critical` run exits 0.
- [ ] Cross-Workspace read/URL/API all denied; concurrent worktrees provably isolated.
**Directives**: II, V.

### TASK-027 — Observability wiring
*File*: `packages/observability/*`, orchestrator + web integration · *Phase/Crit*: P2 / Medium · Scope: BE · *Depends*: TASK-011, TASK-019
**What**:
- Structured logs (workspace/task/session ids, state transitions, durationMs); `captureException`
  at boundaries; worktree-path↔task-id audit line; Inngest step telemetry.
**Acceptance criteria**:
- [X] Signals from plan §10 emitted: run-context ids, state transitions (`state.transition`),
      worktree→task audit (`worktree.bound`), `captureException`, timing helper.
- [X] No secret value appears in any log/span/event (credential-key redaction + test asserting the
      seeded token never appears in the lifecycle logs).
**Directives**: IV, auditability.

### TASK-028 — Retry a failed Task (Story 4)
*File*: `apps/web/server/routers/task.ts` (retry), `apps/orchestrator/inngest/functions/task-run.ts` · *Phase/Crit*: P3 / Medium · Scope: Both · *Depends*: TASK-019
**What**:
- `task.retry` starts a new session and moves the Task to Running; prior session/reason remain viewable.
**Acceptance criteria**:
- [X] Retrying a Failed Task starts a new session and preserves the prior session + reason
      (`task.retry`: new `createSession`, clears `failureReason` on the task, prior sessions retained).
**Directives**: III.

### TASK-029 — Quality gates (all exit 0)
*Phase/Crit*: P1 / Critical · Scope: Both · *Depends*: all above
**Acceptance criteria**:
- [ ] Lint, typecheck, generated-migration review, unit + integration tests, E2E happy path pass.
- [ ] `@critical` isolation (TASK-026) exits 0.
- [ ] Secret scan (`gitleaks`) and dependency audit at the project threshold pass.
- [ ] `openapi.json` is current and committed.
**Directives**: IV, V, VI.

---

## Phase Gate Summary

| ID | Title | Phase | Criticality | Status |
|---|---|---|---|---|
| TASK-001 | Feature flag | P1 | Critical | ✅ verified |
| TASK-002 | Validation contracts | P1 | Critical | ✅ verified |
| TASK-003 | Drizzle schema | P1 | Critical | ✅ verified |
| TASK-004 | Migration | P1 | Critical | ✅ verified |
| TASK-006 | Secret store + env | P1 | Critical | ✅ verified |
| TASK-007 | DAL | P1 | Critical | ✅ verified |
| TASK-009 | Services | P1 | High | ✅ verified |
| TASK-011 | tRPC routers + auth | P1 | Critical | ✅ verified |
| TASK-013 | OpenAPI export | P1 | High | ✅ verified |
| TASK-014 | ACP agent runner | P1 | Critical | ✅ verified |
| TASK-015 | Worktree manager | P1 | Critical | ✅ verified |
| TASK-018 | WebSocket hub | P1 | High | ✅ verified |
| TASK-019 | Inngest task-run | P1 | Critical | ✅ verified |
| TASK-022 | Review workspace | P1 | Critical | ◑ (IDE view: terminal/changes/conversation + review gate; live WS follow-up) |
| TASK-026 | @critical isolation | P1 | **Critical — blocks merge** | ☐ |
| TASK-029 | Quality gates | P1 | Critical | ☐ |
| TASK-016 | Billing guard | P2 | Critical | ✅ verified |
| TASK-021 | Kanban board | P2 | High | ◑ (live board + create/move/launch; dnd+WS follow-up) |
| TASK-023 | Settings (profiles/secrets) | P2 | High | ✅ verified |
| TASK-025 | E2E happy path | P2 | High | ☐ |
| TASK-027 | Observability | P2 | Medium | ✅ verified |
| TASK-028 | Retry a failed Task | P3 | Medium | ✅ verified |
| TASK-005 | Seed (two Workspaces) | P1 | High | ✅ verified |
| TASK-008/012/020 | DAL + tRPC + orchestrator test suites | P1 | High | ✅ verified |
| TASK-010/017/024 | Services + billing + client test suites | P1–P2 | High | ◑ (010/017 done; 024 board tests done, settings/review follow) |

---

## Parallel Execution Opportunities

```
After TASK-002/003 land:
  Group A (parallel): TASK-005 (seed), TASK-006 (secrets), TASK-009 (services)
  Group B (parallel after their deps): TASK-008, TASK-010, TASK-012, TASK-013, TASK-017, TASK-020, TASK-024

Critical sequential spine:
  TASK-002 → TASK-003 → TASK-004 → TASK-007 → TASK-011 → TASK-014/015 → TASK-019 → TASK-022 → TASK-026 → TASK-029
```

## Notes
- `[P]` = different files, no shared dependency — safe to parallelize.
- Each task is independently committable.
- TASK-026 (`@critical` isolation) gates the PR — no exceptions (Principle V).
- Do not open the PR until TASK-029 (all quality gates) passes; the flag must be OFF at merge.
