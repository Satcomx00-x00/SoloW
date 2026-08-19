# Implementation Plan: Core Program — End-to-End Task Loop

**Feature slug**: `core-program`
**Feature flag**: `ff-core-program` (default: OFF)
**Branch**: `001-core-program`
**Date**: 2026-08-17
**Spec**: [spec.md](./spec.md)
**RFC PR**: [link — must be merged before implementation PR is opened]
**Constitution ref**: `.specify/memory/constitution.md` (v1.3.0)

**Tenancy**: user-scoped — tenant key `workspaceId`. Every table, query, and cache key carries
it. v1 is local single-user (one Workspace), but the scoping is **not** waived (constitution
Principle V): the `@critical` isolation test runs as owner-vs-other-Workspace.

> **Architecture note (adapts the RSC-shaped plan template):** the web app is Next.js App
> Router used **SPA-style** — the interactive surfaces (board, review workspace) are **client
> components**; there is no reliance on RSC/SSR for data (Decision 0013). The API surface is
> **tRPC** (served via a Next.js Route Handler) with a generated `openapi.json`, **not** Server
> Actions. The live channel and all long-lived agent work run in a **separate always-on
> orchestrator service**. Sections below are filled for that reality; RSC-only template rows
> are marked N/A with a reason.

---

## Summary

Deliver the end-to-end core loop: create an Issue, create a Task under it on a Kanban board,
run one agent (Claude Code, via ACP) in an isolated git worktree inside the local Executor,
stream its activity live over WebSocket, review the proposed diff, and — on human approval —
commit the changes onto a new local branch. Orchestration (launch → stream → await review →
integrate → cleanup, plus Park-on-quota and retry) is a durable Inngest workflow in a separate
orchestrator service. Both Subscription and API-key billing modes are supported, with a default
subscription concurrency cap of 3.

---

## Stack Reference

> From the constitution (v1.3.0). Monorepo with pnpm workspaces.

| Layer | Technology | Package / Path |
|---|---|---|
| Runtime / package manager | Node + pnpm (workspaces) | monorepo root |
| Web (SPA-style) | Next.js (App Router), client components | `apps/web` |
| API surface | tRPC over HTTP via Next.js Route Handler; `openapi.json` exported | `apps/web/app/api/trpc`, `apps/web/server/routers` |
| Realtime | WebSocket server (bidirectional: agent I/O + status) | `apps/orchestrator/ws` |
| DB + ORM | Drizzle ORM — SQLite (local) / Postgres (hosted) | `packages/db` |
| Validation | Zod (single source for contracts + OpenAPI export) | `packages/contracts` |
| Auth | BetterAuth (local single-user Owner; Workspace scoping) | `apps/web/server/auth` |
| Durable orchestration | Inngest + AgentKit | `apps/orchestrator` |
| Agent connection | ACP (`@agentclientprotocol/sdk`, `claude-agent-acp`) + `node-pty` | `packages/acp`, `apps/orchestrator/agent` |
| Worktrees / repos | git worktrees on local disk (`simple-git` / raw git) | `apps/orchestrator/worktree` |
| Secrets | encrypted-at-rest store + validated env module | `packages/db` (secret table), `apps/*/env.ts` |
| Cache | none in v1 (local SQLite; realtime via WS) | — |
| Observability | structured logging (pino) + error capture | `packages/observability` |
| Deploy | local: one process supervises web + orchestrator; hosted later | — |

---

## File Map

```text
packages/db/
├── schema/
│   ├── workspace.ts        ← workspace (tenant root)
│   ├── issue.ts            ← issue
│   ├── task.ts             ← task (belongs to issue)
│   ├── agent-profile.ts    ← agent profile (authMode, concurrency cap)
│   ├── executor-profile.ts ← executor profile (local)
│   ├── repository.ts       ← repository (local path | remote url)
│   ├── worktree.ts         ← per-task isolated working copy
│   ├── session.ts          ← agent run (conversation + events + proposed diff ref)
│   ├── session-event.ts    ← streamed agent activity (append-only)
│   ├── review.ts           ← human decision (approve/reject/request-changes)
│   └── secret.ts           ← encrypted credential (subscription token / api key)
├── migrations/             ← generated (drizzle-kit)
└── index.ts                ← driver selection (SQLite local / Postgres hosted)

packages/contracts/schemas/
├── issue.ts · task.ts · agent-profile.ts · executor-profile.ts
├── repository.ts · session.ts · review.ts · secret.ts
└── errors.ts               ← *ErrorCode const literals

packages/acp/                ← ACP client wrapper (spawn/drive Claude Code via ACP)
packages/observability/      ← logger + captureException

apps/web/
├── app/api/trpc/[trpc]/route.ts     ← tRPC HTTP handler
├── app/(app)/board/…                ← SPA client: board, columns, cards
├── app/(app)/task/[id]/…            ← SPA client: review workspace (terminal, diff, conversation)
├── app/(app)/settings/…             ← SPA client: profiles, repositories, secrets
├── components/features/…            ← client components (dnd-kit board, xterm terminal, diff viewer)
├── server/
│   ├── routers/{issue,task,profile,repository,review,secret}.ts  ← tRPC routers
│   ├── dal/{issue,task,profile,repository,session,review,secret}.ts ← server-only
│   ├── services/{task,review,billing,repository}.ts             ← pure, Result<T,E>
│   ├── auth/…                       ← BetterAuth + workspace guard
│   └── flags.ts                     ← ff-core-program registry
└── scripts/gen-openapi.ts           ← emit openapi.json from tRPC routers (build artifact)

apps/orchestrator/
├── inngest/functions/task-run.ts    ← durable Task lifecycle workflow
├── agent/acp-runner.ts              ← ACP + node-pty agent process management
├── worktree/manager.ts              ← git worktree provision/cleanup; repo from path|url
├── billing/guard.ts                 ← authMode env shaping, concurrency cap, park-on-quota
└── ws/server.ts                     ← WebSocket hub (agent events out; input/steering in)

e2e/core-program/
├── happy.spec.ts                    ← Issue→Task→run→review→approve
└── isolation.spec.ts                ← @critical: worktree + Workspace isolation
```

---

## Service Interaction Map

| Service | Touched? | Interaction | Changes needed | If down/slow |
|---|---|---|---|---|
| Frontend (SPA) | yes | render board/review; mutate via tRPC; subscribe via WS | board, task-detail, settings client components | degraded: stale board until WS reconnects; tRPC errors shown inline |
| API surface (tRPC) | yes | queries/mutations for issue/task/profile/repo/review/secret | routers, dal, services | typed error envelope to client |
| Database (Drizzle) | yes | read/write all entities; generated migrations | schema, migrations | mutations fail with typed error; no partial writes |
| Cache | no | N/A — local SQLite is the store; realtime via WS, not a cache | — | — |
| Background jobs (Inngest orchestrator) | yes | durable Task lifecycle: launch→stream→await review→integrate; park; retry | `task-run` function | run resumes from last completed step on restart (NFR-1) |
| External API — agent model calls (via ACP → Claude Code → model provider) | yes | agent runs, calls model on Subscription token or API key | acp-runner, billing guard | **timeout**: per-run wall-clock cap → Task Failed; **retry**: user-initiated only (no auto-retry per spec); **fallback**: none (single agent v1); **cost**: charged to user's subscription/API key, bounded by concurrency cap 3 |
| Auth / session (BetterAuth) | yes | Owner session; Workspace scoping on every call | auth, workspace guard | unauth → UNAUTHORIZED; wrong Workspace → FORBIDDEN/404 |
| Realtime (WebSocket) | yes | emit agent stdout/status + board updates; receive terminal input/steering | ws server, client hooks | reconnect + replay from session-event log; no lost terminal history |
| Analytics / events | no | deferred (F14) | — | — |
| File / object storage | yes | git worktrees on local disk (one per Task) | worktree manager | provision failure → Task Failed before agent starts; cleanup failure surfaced, non-blocking |

---

## 1. Data Schema

**Location**: `packages/db/schema/*.ts`. Every table: `id` pk, `workspaceId` (FK, non-null),
`createdAt`/`updatedAt` (tz), index `(workspaceId, createdAt desc)`.

| Table | Key columns | Indexes | Relations |
|---|---|---|---|
| `workspace` | `id pk`, `name`, `ownerUserId` | `(ownerUserId)` | root of tenancy |
| `issue` | `id`, `workspaceId`, `title`, `description`, `status` (open/in_progress/resolved/closed) | `(workspaceId, status)` | has many `task` |
| `task` | `id`, `workspaceId`, `issueId`, `title`, `state` (backlog/ready/running/review/parked/failed/done), `agentProfileId`, `executorProfileId`, `repositoryId`, `baseRef`, `resultBranch?`, `failureReason?` | `(workspaceId, state)`, `(issueId)` | belongs to `issue`; has many `session`; has one active `worktree` |
| `agent_profile` | `id`, `workspaceId`, `name`, `agentKind` (`claude_code`), `authMode` (`subscription`/`api_key`), `secretId`, `concurrencyCap` (default 3) | `(workspaceId)` | refs `secret` |
| `executor_profile` | `id`, `workspaceId`, `name`, `kind` (`local`) | `(workspaceId)` | — |
| `repository` | `id`, `workspaceId`, `name`, `source` (`local_path`/`remote_url`), `location` | `(workspaceId)` | — |
| `worktree` | `id`, `workspaceId`, `taskId`, `repositoryId`, `path`, `branch`, `status` (active/removed) | `(taskId)` | belongs to `task` |
| `session` | `id`, `workspaceId`, `taskId`, `state` (active/awaiting_review/resumable/closed), `diffRef?`, `startedAt`, `endedAt?` | `(taskId, startedAt desc)` | belongs to `task`; has many `session_event` |
| `session_event` | `id`, `workspaceId`, `sessionId`, `seq`, `kind` (stdout/status/tool_use/diff), `payload`, `at` | `(sessionId, seq)` | append-only |
| `review` | `id`, `workspaceId`, `sessionId`, `decision` (approve/reject/request_changes), `feedback?`, `actorUserId`, `at` | `(sessionId)` | belongs to `session` |
| `secret` | `id`, `workspaceId`, `name`, `kind` (`subscription_token`/`api_key`), `ciphertext`, `createdAt` | `(workspaceId, name)` unique | write-only after entry |

**Migration notes**: generated by drizzle-kit only; reviewed line-by-line; forward-compatible
(add-only); rollback = flag OFF → surfaces hidden. Secret `ciphertext` never returned by any
read mapper.

---

## 2. Validation Contracts

**Location**: `packages/contracts/schemas/*.ts` (Zod). These feed runtime validation, the tRPC
IO types, and the `openapi.json` export.

| Schema | Kind | Used by |
|---|---|---|
| `CreateIssueInput` / `IssueDto` / `IssueListDto` | in/out | issue.create/list/get |
| `CreateTaskInput` / `TaskDto` / `TaskListDto` | in/out | task.create/list/get |
| `LaunchTaskInput` / `MoveTaskInput` / `RetryTaskInput` | in | task.launch/move/retry |
| `CreateAgentProfileInput` / `AgentProfileDto` | in/out | profile.agent.* |
| `CreateExecutorProfileInput` / `ExecutorProfileDto` | in/out | profile.executor.* |
| `ConnectRepositoryInput` / `RepositoryDto` | in/out | repository.* |
| `ReviewDecisionInput` / `ReviewDto` | in/out | review.decide |
| `SetSecretInput` (write-only) | in | secret.set |
| `TaskEvent` (WS payload union) | out | WebSocket stream |
| `*ErrorCode` | const literal | routers + services |

Rules: `workspaceId` absent from all input schemas (derived from session). No `z.any()`.

---

## 3. API Surface

> tRPC procedures (served via `app/api/trpc/[trpc]/route.ts`). Discipline per procedure:
> **Parse (Zod) → Authorize (session) → Ownership (workspaceId match) → DTO** — the tRPC
> equivalent of the template's Server-Action rule (constitution Principle V/VI). Every procedure
> is flag-guarded by `ff-core-program`.

| Procedure | Type | Input | Output | Min role | Flag guard |
|---|---|---|---|---|---|
| `issue.create` | mutation | `CreateIssueInput` | `IssueDto` | Owner | yes |
| `issue.list` / `issue.get` | query | list/get input | `IssueListDto`/`IssueDto` | Owner | yes |
| `task.create` | mutation | `CreateTaskInput` | `TaskDto` | Owner | yes |
| `task.launch` | mutation | `LaunchTaskInput` | `TaskDto` (Running) | Owner | yes |
| `task.move` | mutation | `MoveTaskInput` | `TaskDto` | Owner | yes |
| `task.retry` | mutation | `RetryTaskInput` | `TaskDto` | Owner | yes |
| `task.list` / `task.get` | query | list/get input | `TaskListDto`/`TaskDto` | Owner | yes |
| `profile.agent.create` / `.list` | mut/query | agent profile IO | `AgentProfileDto` | Owner | yes |
| `profile.executor.create` / `.list` | mut/query | executor profile IO | `ExecutorProfileDto` | Owner | yes |
| `repository.connect` / `.list` | mut/query | repository IO | `RepositoryDto` | Owner | yes |
| `review.decide` | mutation | `ReviewDecisionInput` | `ReviewDto` + `TaskDto` | Owner | yes |
| `secret.set` | mutation | `SetSecretInput` | `{ id }` (no value echoed) | Owner | yes |

**Realtime (WebSocket, orchestrator)** — not OpenAPI-described (Decision 0011):
| Channel | Direction | Payload |
|---|---|---|
| `task:{taskId}` | server→client | `TaskEvent` (stdout, status, tool_use, diff) |
| `task:{taskId}:input` | client→server | terminal input / stop / steer |
| `board:{workspaceId}` | server→client | Task state changes |

Tenant key (`workspaceId`) comes from the session, never client input.

`openapi.json` is generated from the tRPC routers at build (`scripts/gen-openapi.ts`) and
committed as an artifact.

---

## 4. DAL

**Location**: `apps/web/server/dal/*.ts` — each begins `import 'server-only'`. Every read:
session check → Workspace-ownership check → `workspaceId` filter in every `where`. Explicit
column selection (secret `ciphertext` never selected into a DTO). Typed `Result<T, E>` returns.

| Method (representative) | Return | Notes |
|---|---|---|
| `getTaskById`, `listTasks`, `createTaskRecord`, `updateTaskState` | `Result<TaskDto…>` | `workspaceId` required on writes |
| `getIssueById`, `listIssues`, `createIssueRecord`, `setIssueStatus` | `Result<IssueDto…>` | derived status recompute |
| `createSession`, `appendSessionEvent`, `getSessionWithEvents` | `Result<…>` | append-only events |
| `recordReview` | `Result<ReviewDto>` | actor + timestamp |
| `createAgentProfile`, `createExecutorProfile`, `connectRepository` | `Result<…Dto>` | — |
| `setSecret`, `getSecretForAgentRun` | `Result<…>` | `getSecretForAgent…` is orchestrator-only, returns plaintext into the agent's env, never into a DTO/log |

---

## 5. Services

**Location**: `apps/web/server/services/*.ts` (and `apps/orchestrator/*` mirrors for run-time).
Zero infrastructure imports; `Result<T,E>`; no throw on business errors.

| Function | Returns | Purpose |
|---|---|---|
| `buildCreateTaskPayload` | `Result<DBPayload>` | validate + transform |
| `canTransitionTask(from,to)` | `Result<void>` | state-machine guard (spec lifecycle) |
| `deriveIssueStatus(tasks)` | `IssueStatus` | pure derivation (FR-006) |
| `resolveAgentRunEnv(profile, secret)` | `Result<Env>` | **billing integrity**: subscription → inject `CLAUDE_CODE_OAUTH_TOKEN`, strip `ANTHROPIC_API_KEY`; api_key → inject key (Principle IV) |
| `withinConcurrencyCap(profile, running)` | `boolean` | enforce cap (default 3) |
| `classifyRunFailure(err)` | `FailureReason` | fail vs park (quota) vs credential-expired |

---

## 6. Feature Flag

| Property | Value |
|---|---|
| Name | `ff-core-program` (default OFF) |
| Registered in | `apps/web/server/flags.ts` |
| Granularity | per-Workspace (v1: single Workspace → effectively global-local) |
| Kill switch | immediate — flag read on every tRPC entry + orchestrator run start |
| Guard locations | every tRPC procedure; orchestrator refuses to launch a Task when OFF |
| Planned removal | after core loop is GA and stable |

---

## 7. Authorization Matrix

> v1 role set exercised: **Owner** only (user-scoped, one Workspace). Access is
> owner-vs-other-Workspace, enforced by `workspaceId` on every query.

| Action | Owner | Other user (future/hosted) | Unauthenticated |
|---|---|---|---|
| read issues/tasks/sessions | ✓ (own Workspace) | ✗ | ✗ |
| create/launch/move/retry task | ✓ | ✗ | ✗ |
| review.decide (approve/reject/request) | ✓ | ✗ | ✗ |
| manage profiles/repos/secrets | ✓ | ✗ | ✗ |

---

## 8. Cache Strategy

N/A for v1 — the local SQLite store is authoritative and single-user; realtime freshness is
delivered by the WebSocket channel, not a cache layer. No `unstable_cache`/Redis in this
feature. (Revisit when hosted multi-user lands.)

---

## 9. Background Jobs

**Tool**: Inngest (in `apps/orchestrator`). The core loop is one durable, resumable workflow.

| Effect | Function | Idempotent ID | Trigger |
|---|---|---|---|
| Run a Task end-to-end | `task-run` | `task-run-{taskId}-{sessionId}` | event `task.launch.requested` (from `task.launch`) |

`task-run` steps (each a durable Inngest step; resumes from last completed on restart — NFR-1):
1. `provision-worktree` — worktree manager creates isolated worktree (repo from path or clone
   from URL); on failure → Task **Failed** before agent starts.
2. `start-agent` — billing guard shapes env (`resolveAgentRunEnv`); ACP runner spawns Claude
   Code via `node-pty`; concurrency cap enforced (queue if saturated).
3. `stream` — agent events appended to `session_event` and pushed to WS `task:{id}`.
4. `await-review` — on agent-proposed diff, Task → **Review**; `step.waitForEvent('review.decided')`
   (human-in-the-loop gate; durable wait, no polling).
5. `integrate` — on **approve**: commit changes onto a **new local branch** (no push/PR),
   Task → **Done**, record review. On **reject**: discard worktree changes. On
   **request-changes**: resume agent session with feedback (loop back to step 3).
6. `cleanup` — remove worktree on Done/reject.

**Parked path**: if `classifyRunFailure` returns quota-exhausted → Task **Parked**,
`step.sleepUntil(quotaWindowReset)`, then resume within the cap (FR-016). **Credential-expired**
→ distinct paused state awaiting secret renewal (AC-013). **Other failure** → Task **Failed**,
worktree **preserved**, retry available (AC-008, FR-018).

---

## 10. Observability Plan

> Verifiable after implement (`/speckit-verify`).

| Signal | Attribute / name | Tool |
|---|---|---|
| Span / timing | `workspace.id`, `task.id`, `session.id`, step name | pino + span ids |
| Structured log | workspace id, task id, correlation id, durationMs, state transition | pino (`packages/observability`) |
| Run telemetry | Inngest step timings + resume events | Inngest dashboard |
| Error capture | `captureException` at error boundaries + orchestrator run failures | `packages/observability` |
| Isolation assertion | log every worktree path bound to a task id (audit isolation) | pino |

No secret value ever appears in a log/span/event (Principle IV, NFR-1 security).

---

## 11. Testing Plan

| Type | File | Tool | Critical |
|---|---|---|---|
| Unit (services) | `apps/web/server/services/*.test.ts` | vitest | — (100% branch on state-machine + `resolveAgentRunEnv`) |
| Unit (contracts) | `packages/contracts/*.test.ts` | vitest | error-code coverage |
| Integration (DAL) | `apps/web/server/dal/*.test.ts` | vitest + real SQLite | cross-Workspace isolation |
| Integration (tRPC) | `apps/web/server/routers/*.test.ts` | vitest + real DB | authz, flag guard, ownership |
| Integration (orchestrator) | `apps/orchestrator/inngest/*.test.ts` | vitest + Inngest test + fake ACP agent | resume-after-restart, park, retry |
| Billing integrity | `apps/orchestrator/billing/*.test.ts` | vitest | subscription env strips `ANTHROPIC_API_KEY` |
| E2E happy path | `e2e/core-program/happy.spec.ts` | Playwright | Issue→Task→run→review→approve |
| E2E @critical | `e2e/core-program/isolation.spec.ts` | Playwright | **blocks merge** — worktree + Workspace isolation |

---

## 12. Security Checklist

- [ ] `workspaceId` from the session, never client input; every DAL query filters by it.
- [ ] Authorization re-checked inside every tRPC mutation (not only at the router boundary).
- [ ] Secrets encrypted at rest; `ciphertext` never selected into a DTO, log, span, or WS event.
- [ ] **Billing integrity**: subscription-mode runs strip `ANTHROPIC_API_KEY`; api-key runs
      inject only the key (Principle IV) — covered by a dedicated test.
- [ ] **Credential isolation**: the orchestrator injects only the single credential the agent
      process needs into that process's env; the secret store is never mounted into
      agent-run code. *(Nuance for tracking — see Open Question 1.)*
- [ ] Secrets accessed only via the validated env module — no bare `process.env`.
- [ ] Rate limit on `secret.set` and `task.launch` per Owner.
- [ ] Generated migrations only — no handwritten SQL.
- [ ] WebSocket connections authenticated + Workspace-scoped; a client can only subscribe to its
      own Workspace's channels.

---

## 13. Open Questions

1. **Agent credential exposure nuance.** Claude Code needs its token in its process env to
   authenticate, and the agent's own `bash` could read that env var — a partial tension with
   "agent-run code never accesses raw credentials." Decision needed: accept as an inherent,
   documented limitation of driving an external agent CLI (scope the credential to that one
   process, nothing else), or add a proxy/egress-injection layer later. **Proposed:** accept +
   document for v1; revisit for hosted.
2. **Worktree base for a freshly cloned remote URL.** For `remote_url` repositories, confirm
   the default `baseRef` when none is given (proposed: the remote's default branch).

*(Resolve before the implementation PR is opened.)*

---

## 14. Complexity Justification

| Violation | Why needed | Simpler alternative rejected because |
|---|---|---|
| Separate always-on orchestrator service (beyond the Next.js app) | Agents are long-lived processes and the WebSocket channel needs a persistent server; serverless-style Next.js cannot hold them (Decision 0002/0013, constraint C-7) | An all-in-Next.js approach cannot supervise minutes-long agent processes or host a durable WS channel |
| Durable engine (Inngest) in a local-first tool | Resumable runs + human-in-the-loop gates are required (Principle III, NFR-1) | Hand-rolled orchestration reimplements exactly the hard durability/resume/gate logic |
