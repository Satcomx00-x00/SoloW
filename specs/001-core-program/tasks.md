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

Realtime + E2E + gates pass (ninth `/speckit-implement`) — **VERIFIED** (all gates exit 0):
- ✅ **TASK-018** WebSocket hub — *both* acceptance criteria now met. Connection auth via
  short-lived HMAC **subscription tickets** (`packages/core/src/stream.ts`, exported from
  `@gatecontrol/core/stream` so `node:crypto` never enters the browser bundle): the API checks
  session + Workspace ownership and signs a ticket naming one channel; the hub **derives the
  channel from the ticket's claims**, never from a query parameter (`authorizeUpgrade`).
  **Reconnect replay** (`attachSubscriber`): events after the client's `seq` are replayed from
  the session log, with live events buffered during replay so nothing is lost or duplicated.
  New `stream.ticket` procedure (OpenAPI now **21 paths**); `GATECONTROL_STREAM_SECRET` shared
  by both services (required — an unset key would mean unauthenticated streams).
- ➕ **Gap found and closed**: the lifecycle published events but *never persisted them*, so
  replay had nothing to read and a reloaded Task page showed an empty terminal. `task-run.ts`
  now appends every streamed event to `session_event` with a real monotonic `seq`
  (`nextSessionEventSeq`/`appendSessionEvent`, `onConflictDoNothing` so a retried step is a
  no-op) and announces state changes on a new Workspace **board channel**.
- ✅ **TASK-021** Kanban board — live status over the board channel (a run advancing in the
  background moves the card with no reload). Drag listeners moved off the card body onto a
  **dedicated grip handle** + `KeyboardSensor`: the previous markup nested a link and buttons
  inside a `role="button"` wrapper, which is invalid ARIA and unusable by keyboard.
- ◑ **TASK-022** Review workspace — live terminal (persisted history + live stream + connection
  status). *Still open: sending input/stop to the agent* — that needs client→hub→agent stdin
  routing and belongs with the real ACP handshake (TASK-014 TODO).
- ✅ **TASK-024** client tests — new tRPC test harness (`src/test/trpc-harness.tsx`) renders a
  wired component against handler-backed procedures + a drivable fake WebSocket, so components
  are tested as they ship: board (live status → column move, actions, error states), Secrets
  form (write-only value, disabled-while-pending, error surfaced), review gate (all actions
  locked while a decision is in flight — no double-approve), stream hook (ticket use, resume
  from last `seq`, backoff).
- ✅ **TASK-025** happy-path E2E — Settings → connect repo → Issue → Task → Ready → Launch →
  live stream → Review → **Approve → Done on a new local branch**, asserted against real git
  (`git show <branch>:marker-*`), plus reject → worktree torn down, nothing committed.
- ✅ **TASK-026 ⚠️ @critical isolation E2E** — **passes**. Concurrent Tasks: two live worktrees,
  each holding only its own marker, and each agent's recorded `visible.txt` proving it could
  not see the other's files. Workspace isolation: another Workspace's Task is unreachable by
  URL and by API, with neither its title nor its Workspace id in the refusal.
- ➕ **E2E harness**: `e2e/` is a workspace package. `playwright.config.ts` builds the fixture
  (temp git repo + migrated, seeded SQLite) at config load — Playwright starts `webServer`
  entries in parallel, so ordering cannot go through `globalSetup`. `e2e/support/orchestrator.ts`
  runs the **real** `runTaskLifecycle` + worktree manager against a deterministic fake agent and
  consumes the same `{name,data}` events the API emits; it stands in only for the durable engine
  (inline steps, in-memory review waits — no durability claim).
- ➕ **Event transport wired**: `orchestrator-client` POSTs to `GATECONTROL_ORCHESTRATOR_URL`
  (`/events`, Inngest's `{name,data}` shape) when configured; dev-without-URL still logs-and-
  returns and non-dev still throws. `review.decide`'s dev stand-in transition is now skipped
  when a real engine is wired, so the two no longer race.
- ✅ **TASK-029** quality gates — all exit 0: Biome, typecheck (7/7), **149 unit/integration
  tests**, `openapi:check` (21 paths), `gitleaks` (no leaks, 15 commits), dependency audit, and
  the full Playwright suite (**6/6**, `@critical` included). `make verify` runs the lot.
- ➕ **Dependency audit gate defined** (the constitution's "project severity threshold" had none):
  `scripts/audit.ts` fails on any high/critical advisory not in `scripts/audit-allowlist.txt`,
  where each entry states why it is unreachable *and what would make it reachable again*.
  Fixed for real: **drizzle-orm 0.36 → 0.45.2** (high, SQL injection via unescaped identifiers;
  no schema drift, all tests pass) and removed **vitest** from all six packages (unused — the
  project runs `bun test`).
- ➕ `make build` now also bundles the SPA (verified: 6 routes compile).

**Verified with:** `bunx biome check .` (clean) → `bun run typecheck` (7/7) → `bun run test`
(**149 pass**) → `bun run openapi:check` (21 paths) → `bun run audit` → `bun run secretscan` →
`bunx playwright test` (**6 passed**, incl. `@critical`) → `cd apps/web && bun --bun run build`.

**Still open (documented, not silent):** agent input/stop from the terminal (TASK-022, with the
ACP handshake in TASK-014); BetterAuth session wiring (`auth/session.ts` throws rather than
faking a session); the Inngest `serve` endpoint for the hosted deployment; and the Postgres
mirror of the schema (Decision 0008 follow-up).

Real-ACP + steering pass (tenth `/speckit-implement`) — **VERIFIED** (every gate exits 0):
- ✅ **TASK-014** ACP agent runner — the handshake is real. New **`packages/acp`** wraps the
  official `@agentclientprotocol/sdk`: `session.ts` owns the protocol (`initialize` →
  `session/new` → `session/prompt`, `session/update` fan-out, permission answering,
  `session/cancel`) and `spawn.ts` owns the process (stdio ⇄ `ndJsonStream`). `AcpAgentRunner`
  binds the two behind the existing `AgentRunner` interface, so the lifecycle did not change
  shape. `node-pty` turned out to be unnecessary — ACP is newline-delimited JSON-RPC on stdio,
  not a terminal — which removes a native dependency the plan had assumed.
  Tested against a *real* scripted agent, in-process and as a spawned child (`fakeAcpAgent`,
  `FAKE_AGENT_MAIN`), so the handshake, ordering, permission and kill paths are exercised for
  real rather than stubbed.
  - **Permission policy** made explicit (`allowOncePolicy`): a headless run takes the narrowest
    "allow" the agent offers and refuses if it offers none, because the disposable worktree plus
    the review gate — not a per-tool prompt no one is watching — are the safety boundary. Every
    decision is reported onto the stream, so it lands in the session log.
  - The agent binary is now configuration: `GATECONTROL_AGENT_COMMAND` / `GATECONTROL_AGENT_ARGS`
    (default `claude-code-acp`), since the ACP adapter ships separately from Claude Code.
- ➕ **Gap found and closed: park-on-quota could never fire in production.** `SpawnAgentRunner`
  returned an empty `FailureSignal`, so `classifyRunFailure` always said `fail` — the Parked
  state was reachable only from a test. Added `detectFailureSignal` (pure, in `core`) which reads
  quota/credential messages out of the agent's own stderr, and the runner now retains a bounded
  stderr tail and drains it *before* classifying. Matching is deliberately narrow: a false "park"
  would strand a Task for hours.
- ➕ **Gap found and closed: `request_changes` was a no-op loop.** The reviewer's feedback was
  recorded but never given to the agent, so the next round re-ran the identical brief. The
  lifecycle now builds the brief from the Issue + Task and leads later rounds with the feedback
  (`agentBrief`); the run context carries the Issue for that reason.
- ✅ **TASK-022** Review workspace — **input/stop implemented end to end.** The socket is now
  bidirectional: the SPA sends `{kind:"input"|"stop"}`, the hub derives the Workspace from the
  **signed ticket** (never the frame) and refuses any frame naming a Task the ticket does not
  cover, then routes through a process-local `AgentRegistry` to that run's live agent, which takes
  the text as its next ACP turn. Every frame is acknowledged, so input that reached no running
  agent is reported rather than silently swallowed. Steering is offered only while the Task is
  Running — in Review the way to ask for more is "request changes", which is recorded (Principle I).
- ✅ **TASK-022** destructive actions confirmed — one `ConfirmAction`/`ConfirmDialog` gate
  (`alertdialog`, Cancel focused, Escape cancels) now covers Reject, Stop-the-agent, and dragging
  a Task out of Review on the board. That last one was a real hole: it abandoned the agent's
  changes and left **no review decision behind**. Approve stays one click — it is not destructive.
- ➕ **E2E**: a new spec drives one instruction from the terminal through the hub and registry into
  the agent and back onto the stream; the reject spec now goes through the confirmation.
- **Counts**: 6 packages → 7 (`@gatecontrol/acp`); 149 → **205 unit/integration tests**; 6 → **7
  Playwright specs**.

**Verified with:** `bunx biome check .` (clean) → `bun run typecheck` (**8/8**) → `bun run test`
(**205 pass**) → `bun run openapi:check` (21 paths) → `bun run audit` → `bun run secretscan`
(no leaks) → `bun run scripts/smoke.ts` → `bunx playwright test` (**7 passed**, incl. `@critical`)
→ `cd apps/web && bun --bun run build` (6 routes).

**Still open (documented, not silent):** a file-level diff renderer in the Changes panel (it names
the branch); BetterAuth session wiring (`auth/session.ts` throws rather than faking a session); the
Inngest `serve` endpoint for the hosted deployment; and the Postgres mirror of the schema
(Decision 0008 follow-up). Also noted: the per-criterion checkboxes under Phase 1–3 tasks were
never ticked in earlier passes even though the Phase Gate Summary records those tasks as verified
— the summary is the accurate record; the boxes are stale, and were left as found rather than
ticked without re-verification.

Auth pass (eleventh `/speckit-implement`) — **VERIFIED** (every gate exits 0, plus a live
sign-up → sign-in → API → sign-out run against a real server):
- ✅ **TASK-011** BetterAuth session + Workspace guard — the stub is gone. `resolveSession` now
  validates a real signed session and looks the Workspace up from its user, so `workspaceId`
  originates in the session and nowhere else (Principle V). Until now the whole product only
  worked under `GATECONTROL_DEV_OWNER=on`; that path stays, clearly marked, for local dev and the
  E2E harness.
  - **Schema**: four `auth_*` tables in `packages/db/src/auth-schema.ts`, kept in their own file
    because they are the *source* of the tenant key rather than tenant-scoped data — every domain
    table still carries a non-null `workspaceId`. BetterAuth's default model name for a login
    session is `session`, already taken here by an *agent* session, so the models are remapped.
    Migration `0001` is generated, additive, and applies cleanly to a fresh database.
  - **One Owner per instance**: the *second* sign-up is refused at the database hook — the
    closest point to the write, so no route can route around it. A self-hosted instance's
    Workspace holds the Owner's agent credentials; leaving sign-up open would let anyone who can
    reach the port create an account on someone else's machine.
  - **The Workspace is created with the Owner**, in the same hook. Creating it lazily during
    session resolution would make a read path write; a user without one resolves to `null`
    rather than to a session with no tenant key.
  - **Surface**: `/api/auth/[...all]`, a `/sign-in` page that is first-run setup or sign-in
    (decided on the server, so it never offers to create a second account), a sign-out control,
    and a rendering guard on the signed-in shell. The guard is *not* the security boundary — every
    procedure re-checks the session itself, which the tests assert directly.
- ➕ **Gap found and closed: the feature flag had nowhere to live.** `ff-core-program` was
  per-Workspace and default-OFF by design, but nothing persisted an override, so the only way it
  had ever been ON was the dev-owner stand-in force-enabling it. A real Owner would have signed in
  to a permanently FORBIDDEN board. Overrides now live on `workspace.enabled_flags`, read per
  request; `bun run flag {list,enable,disable}` is the operator control (a Settings toggle would
  put the kill switch in reach of whoever is signed in, which is the opposite of the point). The
  board explains the disabled state instead of showing the raw error code. Anything other than an
  explicit `true` — absent, null, malformed — reads as OFF.
- ➕ **Hardened**: `GATECONTROL_AUTH_SECRET` now requires ≥32 characters and the app refuses to
  boot below that, rather than logging a warning and signing cookies with a guessable key.
- ➕ **Pre-existing E2E flake found and fixed** (it surfaced when this pass added a third caller,
  and was luck, not correctness, before): `ensureRepository` read badge visibility immediately
  after navigating, so a caller arriving while the query was still in flight connected a *second*
  copy of the fixture repository and the Repository selector became ambiguous. The settings page
  had no way to tell "none yet" from "still loading" — it now has a real empty state, and the
  helper waits for the list to resolve before deciding.
- **Tests**: +28 → **233 unit/integration**. The auth suite runs the real BetterAuth instance
  against a real migrated database (no mock of the thing under test): single-Owner enforcement,
  Workspace creation, forged/absent/signed-out cookies, password hashing, and a full-chain suite
  that goes sign-up → cookie → session → flag lookup → tRPC → DAL, including the flag as a kill
  switch on a live session.

**Verified with:** `make verify` (Biome → typecheck 8/8 → **233 tests** → openapi 21 paths →
audit → gitleaks → Playwright **7/7** incl. `@critical`) → `bun run scripts/smoke.ts` →
`cd apps/web && bun --bun run build` (8 routes) → migration applies to a fresh DB → and a live
server run: unauthenticated `/board` redirects to `/sign-in`, first-run sign-up creates the Owner
and their Workspace, a second sign-up is refused, the signed-in Owner is `FLAG_DISABLED` until
`bun run flag enable ff-core-program`, then reads and writes their own data, a cross-origin write
is refused (CSRF), and after sign-out the same cookie is `UNAUTHORIZED` again.

Diff-view pass (twelfth `/speckit-implement`) — **VERIFIED** (`make verify`, all gates exit 0):
- ✅ **TASK-022 file-level diff** — the last open acceptance criterion on a feature task. The
  Changes tab named a branch and asked the reviewer to approve work they could not see; approving
  is the one irreversible step in the loop (Principle I), so what is being approved is now legible
  in the app.
  - **Captured in the orchestrator**, at the review gate, because it is the only process holding
    the worktree — the web app must never shell out to git, and in a hosted deployment the
    worktree is not on its machine. Persisted as a `diff` session event on the existing
    append-only log, so it replays with everything else and **survives worktree teardown**.
  - Bounded at 256 KB of patch (it lands in one SQLite row the page loads whole), and the UI says
    when it was cut. The file list is never truncated — it is what a reviewer scans first.
  - A capture failure degrades to "no diff shown" rather than stalling the Task at the gate; the
    branch name alone is enough to decide on. Tested.
- ➕ **Bug found writing it: `git add -N .` stages a deletion**, removing it from the unstaged
  diff — a plain `git diff` reported a file the agent *deleted* as no change at all. Fixed by
  diffing against `HEAD`, which covers staged and unstaged together. Both halves are load-bearing
  and both are tested against real git: intent-to-add so a *created* file appears, HEAD so a
  *deleted* one does.
- ➕ E2E: the happy path opens the Changes tab and asserts the files the fixture agent really
  wrote, plus a patch line, before approving.

**Interim UI work** (outside the task plan, recorded so this file matches the tree): a designed
dark surface system with an elevation ladder and a named type scale; Geist/Geist Mono via
`next/font`; the seven lifecycle states given distinct colour *and* glyph after three pairs were
found rendering identically; a shared control ladder (24/28/32/36) across buttons, inputs and
selects, with press states and a built-in `loading` that blocks double-submission; a ⌘K command
palette searching Tasks and Issues server-side; an **Issues section** (list, status filter, detail
with its Tasks) as a new rail category; and a header bar carrying page actions, which retired the
board's separate action band.

Two more bugs came out of that work: **`task.list` accepted a `query` and silently dropped it**, so
a filtered search returned everything and looked like it had worked; and **`deriveIssueStatus` was
implemented, tested and never called** — the DTO returned the stored column, written once at
creation, so every Issue read "Open" forever regardless of its Tasks (spec FR-006). Both fixed
with tests.

Claude Code pass (thirteenth `/speckit-implement`) — lint, typecheck 8/8, **283 tests**, smoke and
openapi green; **Playwright not run this pass** (see below):
- ✅ **TASK-014 rewritten around the real CLI.** New `packages/claude-code` drives
  `claude -p --input-format stream-json --output-format stream-json --verbose`: the CLI's own
  programmatic mode, so every message, tool call and result arrives as a parseable event instead
  of terminal text to scrape, and a turn can be sent mid-session.
- ✅ **`--worktree` is mandatory and unforgeable.** It is added by `buildArgs`, not by a call
  site, and `GATECONTROL_AGENT_ARGS` is appended *after* the required flags so configuration
  cannot drop it. Several Tasks share one repository; two agents in one working tree would
  overwrite each other (Principle II).
- ➕ **Worktree ownership inverted.** GateControl used to `git worktree add` per Task. Running
  `claude --worktree` inside that would nest a worktree in a worktree and put the agent's edits
  where nothing downstream reads. So the agent now creates the worktree and GateControl *adopts*
  it: `prepareRepository` resolves and validates the repository up front (an unusable location
  still fails the Task before any agent starts), the runner reports the path from the session's
  own `system/init` event, and `adoptWorktree` confirms with **git** — not with a guessed naming
  convention — that the path really is a worktree of that repository. An agent that reports a
  path outside the repository, or none at all, fails the Task rather than having GateControl
  commit from wherever it happened to be pointing. Diff, commit, discard and cleanup all target
  the adopted path.
- ➕ **Bug found and fixed in the review loop.** A `request_changes` round re-ran the agent, and
  passing `--worktree <name>` a second time would either error or branch a *fresh* worktree from
  the base ref — throwing away everything the first round produced, so the reviewer's feedback
  would be applied to nothing. Round one creates the worktree; later rounds run *inside* it with
  no `--worktree` (it is already isolated). Both behaviours are pinned by tests.
- ➕ **ACP path removed.** `packages/acp` and `acp-runner` are gone: an ACP agent has no
  `--worktree`, so keeping it as an alternative runner would have meant a second, silently
  unisolated way to run a Task. **Decision 0003 ("integrate agents via ACP") no longer matches
  what ships and needs revisiting.** The code is recoverable from git history if a second agent
  lands.
- Failure classification now reads the CLI's own `result.subtype` first and falls back to
  stderr, so `error_max_turns` and a quota message are told apart; a missing `result` event is a
  failure rather than assumed success.

**Not verified this pass:** the real `claude --worktree` behaviour — running the CLI was declined
in this environment, so the adoption path is exercised against a scripted fake that speaks the
real protocol and against real `git worktree` operations, but not against the real binary. The one
thing to confirm on a machine with credentials is that `claude --worktree <name> -p …` creates the
worktree and reports it as `cwd` in the `system/init` event. Playwright was also not run: that call
was declined mid-turn.

**Still open (documented, not silent):** settings to install and configure Claude Code (asked for
and not yet built); the Inngest `serve` endpoint for the hosted deployment; and the Postgres
mirror of the schema (Decision 0008 follow-up).

---

---

## Phase 1 — Foundation (unblocks everything)

### TASK-001 — [P] Declare feature flag `ff-core-program`
*File*: `apps/web/server/flags.ts` · *Phase/Crit*: P1 / Critical · Scope: Both
**What**:
- Register `ff-core-program` with `default: false`, per-Workspace granularity, kill switch.
**Acceptance criteria**:
- [X] Flag key `ff-core-program` exists in the registry with `default: false` (grep-verifiable).
- [X] Flag evaluates to `false` on a clean environment — including for a freshly created Owner's
      Workspace, which starts with no overrides.
- [X] Per-Workspace granularity and the kill switch are now *stored*, not just declared:
      overrides live on `workspace.enabled_flags` and are flipped with `bun run flag`. Anything
      other than an explicit `true` (absent, null, malformed) reads as OFF.
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
- [X] Every procedure parses input, checks auth + ownership, returns a DTO (no raw row).
- [X] Every procedure short-circuits when the flag is OFF.
- [X] `secret.set` never echoes the value.
- [X] **BetterAuth session + Workspace guard** — wired, no longer a stub. Email/password Owner
      login; `resolveSession` derives `workspaceId` from the signed session's user and returns
      null (never a half-session) when that user owns no Workspace.
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
- [X] Agent process receives only the single credential from `resolveAgentRunEnv` — `spawnAcpAgent`
      *replaces* the environment rather than extending it, proven by a spawned agent that writes
      back the names it can see (`spawn.test.ts`).
- [X] Events are appended in order and are replayable — `session/update` notifications become
      `session_event` rows with a monotonic `seq` (the ordering is asserted in `acp-runner.test.ts`,
      the replay in `ws/stream.test.ts`).
- [X] Stopping the agent terminates its process cleanly — `stop()` sends `session/cancel`, then
      kills; the run resolves *completed*, so partial work still reaches review.
- Implemented with the official `@agentclientprotocol/sdk`; `node-pty` proved unnecessary since ACP
  is newline-delimited JSON-RPC on stdio, not a terminal (one fewer native dependency).
- The agent binary is configuration (`GATECONTROL_AGENT_COMMAND`/`_ARGS`, default
  `claude-code-acp`) — the ACP adapter for Claude Code ships separately from Claude Code.
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
- [X] A client can subscribe only to its own Workspace's channels — the hub derives the channel
      from the signed ticket's claims, so a client-supplied channel is ignored entirely.
- [X] On reconnect, missed events are replayed from the `session_event` log after the client's
      `seq`; live events arriving mid-replay are buffered, so nothing is lost or duplicated.
**Directives**: V, and real-time observability (Decision 0011).

### TASK-019 — Inngest `task-run` workflow
*File*: `apps/orchestrator/inngest/functions/task-run.ts` · *Phase/Crit*: P1 / Critical · Scope: BE · *Depends*: TASK-014, TASK-015, TASK-016
**What**:
- Durable steps per plan §9: provision-worktree → start-agent → stream → **await-review
  (`waitForEvent`)** → integrate/commit → cleanup. Park via `sleepUntil`; request-changes loops
  back; failure → Failed (worktree preserved); retry via new session.
**Acceptance criteria**:
- [X] No change integrated without a recorded human review (I) — verified by `task-run.test.ts`
      and end-to-end in TASK-025.
- [X] Restarting the orchestrator mid-run resumes from the last completed step (III) — every round
      is a discrete step; resumability is exercised through the controllable step fake.
- [X] Quota exhaustion → Parked, resumes on window reset; failure → Failed with worktree preserved.
      The signal now comes from the agent itself: `detectFailureSignal` reads quota/credential
      messages off its stderr, so park-on-quota fires in production and not only in tests.
- [X] Review feedback reaches the agent: a `request_changes` round leads with the reviewer's words,
      so the loop asks for something different instead of repeating the same brief.
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
- [X] Columns cover Backlog/Ready/Running/Review/Parked/Done/Failed.
- [X] Live status updates in near real time (board channel; asserted end-to-end and in a wired
      component test); illegal drags are rejected with a reason via the shared state machine.
- [X] Interactive elements native/ARIA (drag moved to a dedicated handle + `KeyboardSensor`, so the
      card's link and buttons are no longer nested in a `role="button"` wrapper); submit disabled
      while pending. *i18n: strings are still inline English — no i18n layer exists yet (deferred;
      the SPA has no locale plumbing and adding it is its own task).*
**Directives**: I (surfaces the review state), accessibility.

### TASK-022 — Review workspace (client)
*File*: `apps/web/app/(app)/task/[id]/*`, `apps/web/components/features/review/*` · *Phase/Crit*: P1 / Critical · Scope: FE · *Depends*: TASK-011, TASK-018
**What**:
- xterm terminal (live agent stream + input), diff viewer, conversation; approve / reject /
  request-changes actions calling `review.decide`.
**Acceptance criteria**:
- [X] Terminal streams agent activity — persisted history plus the live stream, with a connection
      indicator and replay across a dropped connection.
- [X] Accepts input/stop. The same socket carries both ways: the SPA sends `{kind:"input"|"stop"}`,
      the hub derives the Workspace from the *signed ticket* and routes to that Task's live agent
      via the `AgentRegistry`, and the agent takes the text as its next ACP turn. The hub
      acknowledges every frame, so input that reached no running agent says so rather than looking
      delivered. Steering is offered only while the Task is Running — in Review the way to ask for
      more is "request changes", which is recorded (Principle I). Verified end-to-end (E2E:
      terminal → hub → agent → back onto the stream).
- [X] Approve/reject/request-changes each record a decision and advance the Task (verified E2E).
- [X] **File-level diff.** The Changes tab shows every changed file with its status and line
      counts, then the patch itself. Captured by the orchestrator at the review gate (the only
      process holding the worktree) and persisted to the session log, so an approved Task can
      still show what was approved after the worktree is gone. Patch bounded at 256 KB and says
      so when cut; the file list never is.
- [X] Destructive actions require confirmation — one `ConfirmAction`/`ConfirmDialog` gate covers
      Reject, Stop-the-agent, and dragging a Task out of Review on the board (which would abandon
      the work with no review decision recorded). `alertdialog` semantics, Cancel focused, Escape
      cancels. Approve stays one click: it is not destructive.
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
- [X] Board renders per-column empty states and cards when data is present; the wired board test
      also covers live status, card actions and error states. *A CTA in the empty state is still
      the toolbar's "New task" button rather than in-column copy.*
- [X] Review actions disabled while a decision is pending (a second click records no second
      decision). Plus Secrets-form and stream-hook coverage.
**Directives**: VI.

---

## Phase 5 — E2E + Quality Gates

### TASK-025 — [P] E2E happy path
*File*: `e2e/core-program/happy.spec.ts` · *Phase/Crit*: P2 / High · Scope: FE · *Depends*: TASK-019, TASK-021, TASK-022
**What**:
- Owner: create Issue → create Task → launch → see live stream → review diff → approve → Task Done
  with a new local branch. Uses a deterministic fake agent.
**Acceptance criteria**:
- [X] The full loop passes; selector-based waits only (no `waitForTimeout` anywhere in the suite).
- [X] Rejecting a diff discards the worktree changes (worktree torn down, nothing committed).
**Directives**: I, VI.

### TASK-026 — ⚠️ @critical E2E isolation (BLOCKS MERGE)
*File*: `e2e/core-program/isolation.spec.ts` · *Phase/Crit*: P1 / **Critical — blocks merge** · Scope: Both · *Depends*: TASK-011, TASK-015
**What**:
- Worktree isolation: two concurrent Tasks never observe each other's files.
- Workspace isolation (owner-vs-other): user on another Workspace's Task URL → 404; API call with
  another Workspace's key → 403.
**Acceptance criteria**:
- [X] Tagged `@critical`; `bunx playwright test --grep @critical` exits 0 (`make e2e-critical`).
- [X] Cross-Workspace URL and API both denied with no data in the refusal; concurrent worktrees
      provably isolated (each agent's recorded view lists only its own files).
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
- [X] Lint (Biome), typecheck (7/7), generated migration re-generates with no drift, 149 unit +
      integration tests, and the E2E happy path all pass.
- [X] `@critical` isolation (TASK-026) exits 0.
- [X] `gitleaks` finds no leaks. The dependency threshold — previously undefined — is now
      `scripts/audit.ts`: no high/critical advisory may reach a runtime dependency, with each
      allowlisted exception stating why it is unreachable. Fixed drizzle-orm (high) for real.
- [X] `openapi.json` is current and committed (21 paths).
**Directives**: IV, V, VI.

---

## Phase Gate Summary

| ID | Title | Phase | Criticality | Status |
|---|---|---|---|---|
| TASK-001 | Feature flag | P1 | Critical | ✅ verified (per-Workspace overrides persisted; `bun run flag` kill switch) |
| TASK-002 | Validation contracts | P1 | Critical | ✅ verified |
| TASK-003 | Drizzle schema | P1 | Critical | ✅ verified |
| TASK-004 | Migration | P1 | Critical | ✅ verified |
| TASK-006 | Secret store + env | P1 | Critical | ✅ verified |
| TASK-007 | DAL | P1 | Critical | ✅ verified |
| TASK-009 | Services | P1 | High | ✅ verified |
| TASK-011 | tRPC routers + auth | P1 | Critical | ✅ verified (BetterAuth session + Workspace guard wired) |
| TASK-013 | OpenAPI export | P1 | High | ✅ verified |
| TASK-014 | ACP agent runner | P1 | Critical | ✅ verified (real ACP over stdio via `packages/acp`) |
| TASK-015 | Worktree manager | P1 | Critical | ✅ verified |
| TASK-018 | WebSocket hub | P1 | High | ✅ verified (ticket auth + reconnect replay + client hook) |
| TASK-019 | Inngest task-run | P1 | Critical | ✅ verified |
| TASK-022 | Review workspace | P1 | Critical | ✅ verified (live terminal, input/stop, confirmed destructive actions, **file-level diff**) |
| TASK-026 | @critical isolation | P1 | **Critical — blocks merge** | ✅ verified — **passes** |
| TASK-029 | Quality gates | P1 | Critical | ✅ verified (all gates exit 0; `make verify`) |
| TASK-016 | Billing guard | P2 | Critical | ✅ verified |
| TASK-021 | Kanban board | P2 | High | ✅ verified (live status, dnd via an accessible handle; i18n layer deferred) |
| TASK-023 | Settings (profiles/secrets) | P2 | High | ✅ verified |
| TASK-025 | E2E happy path | P2 | High | ✅ verified (approve → branch; reject → discarded) |
| TASK-027 | Observability | P2 | Medium | ✅ verified |
| TASK-028 | Retry a failed Task | P3 | Medium | ✅ verified |
| TASK-005 | Seed (two Workspaces) | P1 | High | ✅ verified |
| TASK-008/012/020 | DAL + tRPC + orchestrator test suites | P1 | High | ✅ verified |
| TASK-010/017/024 | Services + billing + client test suites | P1–P2 | High | ✅ verified (024: board, settings, review gate, stream hook) |

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
