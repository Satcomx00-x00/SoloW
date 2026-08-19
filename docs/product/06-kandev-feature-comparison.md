# Feature Comparison — GateControl (current build) vs. kandev

**Status:** Reference · **Last reviewed:** 2026-08-19
**Reference product:** [`kdlbs/kandev`](https://github.com/kdlbs/kandev) — the product
[Decision 0001](../decisions/0001-scope-near-clone-of-kandev.md) commits GateControl to
near-clone in breadth.

This page compares **what GateControl actually ships today** (branch `001-core-program`,
all 29 tasks of the core slice verified) against **the full capability surface kandev
advertises** — its README feature list, [`docs/features.md`](https://github.com/kdlbs/kandev/blob/main/docs/features.md)
inventory, and [`docs/roadmap.md`](https://github.com/kdlbs/kandev/blob/main/docs/roadmap.md).

It is a *state-of-the-code* comparison, not a spec comparison. GateControl's F01–F18
specifications already describe most of kandev's breadth; this table records which of
them have running code behind them.

## Legend

| Mark | Meaning |
|------|---------|
| ✅ | **Built** — implemented and verified in this repository |
| 🟡 | **Partial** — a reduced or single-variant version exists |
| 📄 | **Specified only** — a feature spec exists under `docs/features/`, no code |
| ❌ | **Absent** — no code and no spec coverage |
| ⭐ | **GateControl differentiator** — not present in kandev today |

---

## 1. Agent & task workflows

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 1 | Parallel task execution across many agents | Concurrent tasks run in separate worktrees; isolation proven by the `@critical` E2E (`e2e/core-program/isolation.spec.ts`) | ✅ |
| 2 | Kanban board, drag-and-drop, columns | 7 columns (Backlog/Ready/Running/Review/Parked/Done/Failed), dnd-kit drag handle + `KeyboardSensor` (`components/features/board/`) | ✅ |
| 3 | Live board status in real time | WebSocket board channel with ticket auth (`apps/orchestrator/src/ws/hub.ts`) | ✅ |
| 4 | Guarded state transitions | `packages/core/src/task.ts` state machine; illegal moves rejected, running-task backward move confirmed + interrupts the agent | ✅ |
| 5 | Pipeline view (alternative to kanban) | — | ❌ |
| 6 | Agentic workflows — multi-step pipelines mixing a different agent per step | `F03 Visual Workflow Designer & Monitor` spec only; no workflow tables, no ReactFlow dependency | 📄 |
| 7 | Workflow import/export as portable YAML | — | ❌ |
| 8 | Workflow automations per column/step | — | ❌ |
| 9 | Sub-tasks that resume from the parent session | No `parentTaskId`; task is flat under an Issue | ❌ |
| 10 | Task dependencies / `blocked_by` chains | — | ❌ |
| 11 | Coordinator mode (an agent orchestrating sub-tasks) | — | ❌ |
| 12 | Multi-repository tasks (worktree, branch and PR per repo) | One repository per task by explicit v1 non-goal (`task.repositoryId` is single, non-null) | ❌ |
| 13 | Multi-branch tasks (several PRs from one task) | One branch per task (`gatecontrol/task-<id>`) | ❌ |
| 14 | Task documents — markdown docs with revision history | — | ❌ |
| 15 | Task labels — reusable, filterable, on cards | — | ❌ |
| 16 | Public share links (redacted Gist snapshots, preview + revoke) | `F13 Collaboration & Sharing` spec only | 📄 |
| 17 | Issue management feeding the board | Create / list / get / text-search Issues, status derived from child tasks (`routers/issue.ts`, `packages/core/src/issue.ts`) | ✅ |
| 18 | Retry a failed task | `task.retry` starts a new session, prior session + failure reason preserved | ✅ |

## 2. Agent interfaces

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 19 | 21+ agents (Claude Code, Codex, Copilot, Gemini, Amp, Auggie, OpenCode, Cursor, Devin, Qwen, Droid, iFlow, Kilocode, Pi, Kimi, Kiro, Qoder, Trae, Oh My Pi, Grok, Hermes) | `agentKindSchema = ["claude_code"]` — one agent | 🟡 |
| 20 | ACP (Agent Client Protocol) as the uniform agent boundary | [Decision 0003](../decisions/0003-agent-connection-protocol.md) adopts ACP, and the code is behind an `AgentRunner` interface — but the one runner drives the **Claude Code CLI's `stream-json`** protocol directly (`packages/claude-code/src/session.ts`), not an ACP JSON-RPC adapter | 🟡 |
| 21 | Bring-your-own TUI agents / CLI passthrough in a PTY | — | ❌ |
| 22 | Utility agents (branch names, commit messages, PR titles/descriptions, session summaries) | Commit message is a fixed server-side string | ❌ |
| 23 | Custom reusable prompt library invoked from chat | — | ❌ |
| 24 | Voice mode (plugin) | — | ❌ |
| 25 | Agent profiles — reusable agent configuration | Agent Profile with name, kind, auth mode, secret, concurrency cap (`agent_profile` table, Settings UI) | ✅ |
| 26 | Per-profile launch settings, model/mode selection, unattended permission behaviour | Permission mode is a single constant (`DEFAULT_PERMISSION_MODE = "acceptEdits"`); no model or mode picker | 🟡 |
| 27 | Update a managed agent runtime from Settings | — | ❌ |
| 28 | Send input to / stop a running agent | Bidirectional WebSocket: `{kind:"input"\|"stop"}` with acks, via `AgentRegistry` | ✅ |
| 29 | Session management — resume and review agent conversations | `session` + `session_event` tables, ordered replay after reconnect, session list + detail API | ✅ |

## 3. Integrated review workspace

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 30 | IDE-like workspace in one view | Task workspace with Terminal / Changes / Conversation tabs plus the review gate (`task-workspace.tsx`) | 🟡 |
| 31 | Built-in terminal (xterm.js, real PTY) | A read-only streamed agent log rendered as text — no PTY, no xterm | 🟡 |
| 32 | Code editor with LSP (Monaco) | — | ❌ |
| 33 | File tree | — | ❌ |
| 34 | Embedded VS Code | — | ❌ |
| 35 | Browser preview panel | — | ❌ |
| 36 | Git changes panel | Changes tab: per-file status (added/modified/deleted/renamed) + line counts + unified patch, truncated past 256 KB (`diffWorktree`, `diff-view.tsx`) | ✅ |
| 37 | Review dialog with per-repo grouping | Single-repo review gate; no grouping needed yet | 🟡 |
| 38 | Chat with the agent | Free-text input to the live agent + persisted conversation history | ✅ |
| 39 | Review decisions: approve / reject / request changes | All three recorded with actor, timestamp, feedback (`review` table, `review.decide`) | ✅ |
| 40 | Nothing ships without a human decision | Enforced in the durable workflow (`inngest/functions/task-run.ts` waits on `review.decided`) — Principle I | ✅ ⭐ |
| 41 | Open a PR / push the branch on approval | Approval commits onto a **new local branch only** — no push, no PR (explicit v1 non-goal) | 🟡 |
| 42 | Command palette / keyboard navigation | `cmdk` command palette, VS Code-style activity bar, navigator and status bar | ✅ |
| 43 | Mobile / phone-optimised orchestration UI | Responsive layout only; no phone Status drawer or mobile view | ❌ |

## 4. Executors & runtime

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 44 | Local process executor | `executorKindSchema = ["local"]` | ✅ |
| 45 | Git worktree isolation | `worktree` table + `provisionWorktree` / `adoptWorktree` / `cleanupWorktree`; Claude Code's own `--worktree` used per task | ✅ |
| 46 | Docker container executor | `F07 Execution Environments` spec only | 📄 |
| 47 | Remote SSH executor | `F07` spec only | 📄 |
| 48 | Sprites cloud executor | `F07` spec only | 📄 |
| 49 | Kubernetes operator (kandev roadmap) | — | ❌ |
| 50 | Executor profiles — prepare scripts, env vars, credentials, per-runtime settings | Executor Profile exists as a record (name + kind) with no configuration payload | 🟡 |
| 51 | Repositories from local clone **or** remote URL | Both: `local_path` used in place, `remote_url` cloned into a cache once | ✅ |
| 52 | Per-task repo setup — copy ignored files (e.g. `.env`) into new worktrees | — | ❌ |
| 53 | Resource monitor (CPU, memory, disk, temperature, load) | — | ❌ |
| 54 | Customisable, reorderable status bar with plugin contributions | Fixed status bar (task count, stream state, signed-in identity) | 🟡 |
| 55 | Desktop app (Tauri) | Web app only (Next.js on port 5000) | ❌ |
| 56 | Durable, resumable orchestration across process restarts | Inngest `task-run` workflow; every round is a replayable step, verified by `task-run.test.ts` | ✅ ⭐ |

## 5. Authentication, billing & security

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 57 | Secrets stored once and reused by profiles/integrations | AES-256-GCM `secret` table, write-only after entry, never in a DTO or log | ✅ |
| 58 | Authentication / access control for the deployment | **Shipping** — BetterAuth email + password, session guard on every procedure (kandev has this on its *roadmap*) | ✅ ⭐ |
| 59 | Multi-tenant workspace scoping | Non-null `workspaceId` on all 11 domain tables, filtered in every DAL read, cross-workspace denial proven by the `@critical` E2E | ✅ ⭐ |
| 60 | Subscription vs. API-key billing mode per agent profile | `authMode: subscription \| api_key`; subscription runs strip `ANTHROPIC_API_KEY` from the child env so metered billing cannot occur (`billing/guard.ts`) | ✅ ⭐ |
| 61 | Concurrency cap per agent profile | Default 3, enforced at `task.launch` and in the guard | ✅ ⭐ |
| 62 | Quota exhaustion handling | Task moves to **Parked**, work preserved, resumes on window reset — classified as park, not fail | ✅ ⭐ |
| 63 | Credential expiry / revocation handling | Specified (AC-013); classification exists in the guard, no distinct UI state | 🟡 |
| 64 | Cost tracking, model usage, budgets | kandev has this in Office mode / plugins; GateControl has none | ❌ |
| 65 | Feature flags with runtime override | `ff-core-program` registry + per-workspace overrides persisted + `bun run flag` kill switch | ✅ |
| 66 | Rate limiting on sensitive procedures | `server/rate-limit.ts`, tripped by `secret.set` in tests | ✅ ⭐ |
| 67 | Secret scanning in the build | `gitleaks` wired into `make verify` | ✅ ⭐ |

## 6. Integrations & MCP

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 68 | GitHub integration — import issues, link PRs, surface review activity | `F12 External Integrations` spec only | 📄 |
| 69 | GitLab integration | `F12` spec only | 📄 |
| 70 | Jira integration | `F12` spec only | 📄 |
| 71 | Linear integration | `F12` spec only | 📄 |
| 72 | Sentry integration | `F12` spec only | 📄 |
| 73 | Slack (plugin) | — | ❌ |
| 74 | External MCP server (streamable HTTP + SSE) so other agents drive the platform | — | ❌ |
| 75 | Automatic task-scoped session MCP for every launched agent | — | ❌ |
| 76 | Passthrough MCP for native-CLI agents | — | ❌ |
| 77 | MCP tools: discover workspace context (workspaces, workflows, repos, agents, executors, tasks) | — | ❌ |
| 78 | MCP tools: create tasks & subtasks, target sibling repos | — | ❌ |
| 79 | MCP tools: declare/inspect dependencies, cycle detection | — | ❌ |
| 80 | MCP tools: attach extra branches for multiple PRs | — | ❌ |
| 81 | MCP tools: adjust diff base branch | Base ref is set at task creation and never adjusted | ❌ |
| 82 | MCP tools: move / archive / delete tasks, handoff prompts | `task.move` exists in the API but not as an agent-facing tool; no archive/delete | 🟡 |
| 83 | MCP tools: message another task's session | — | ❌ |
| 84 | MCP tools: read conversations with pagination and filters | `session.get` returns events to the UI; not exposed to agents | 🟡 |
| 85 | MCP tools: record structured task plans | — | ❌ |
| 86 | MCP tools: signal workflow-step completion with summary/blockers | — | ❌ |
| 87 | MCP tools: see associated pull requests | — | ❌ |
| 88 | Machine-readable API surface for external clients | OpenAPI 3 document generated from the tRPC router (21 paths), staleness-checked in CI | ✅ ⭐ |

## 7. Platform, system management & delivery

| # | kandev capability | GateControl today | Status |
|---|---|---|---|
| 89 | Self-hostable, open source, no telemetry | AGPL-3.0, local-first, no telemetry, no external services required | ✅ |
| 90 | Server-first — reachable from any device on your network/VPN | Next.js server + orchestrator process; nothing device-specific | ✅ |
| 91 | Installers: Homebrew, Scoop, NPX, NPM global | Source checkout + `make` / `bun run dev` only | ❌ |
| 92 | Stable / nightly release channels and in-app updates | — | ❌ |
| 93 | Backups, snapshots, restore, download | — | ❌ |
| 94 | Disk-usage inspection (worktrees, repos, sessions, backups) | — | ❌ |
| 95 | System settings: logs, database status, about, licenses | — | ❌ |
| 96 | Feature-toggle settings page | Flags exist and are enforced, but are managed by CLI, not a Settings page | 🟡 |
| 97 | Stats — completed tasks, agent turns, productivity | `F14 Analytics & Reporting` spec only | 📄 |
| 98 | Notifications | `F15 Notifications` spec only | 📄 |
| 99 | Guided first-run onboarding / setup workflow | `F18` spec only; Settings gives an ordered secret → agent → executor → repository path | 📄 |
| 100 | Plugin system with installable extensions | — | ❌ |
| 101 | Internationalisation (i18n) | Deferred explicitly in TASK-021 | ❌ |
| 102 | Office mode — persistent agent teams, roles, permissions, skills, memory, dashboards, inbox/approvals, routines, delegation, budgets, config sync | — (kandev's own is feature-flagged and unreleased) | ❌ |
| 103 | Hosted, multi-user deployment | `F16` spec only; SQLite store is local-first, the Postgres mirror is a documented follow-up | 📄 |
| 104 | Structured observability — run context, state transitions, timings, redaction | `packages/observability`: run-context ids, `state.transition`, worktree binding, exception capture, credential redaction with a test asserting it | ✅ ⭐ |
| 105 | Test & quality gates | Biome lint, 7/7 typecheck, 149+ unit tests, migration drift check, Playwright E2E incl. a merge-blocking `@critical` isolation suite, `gitleaks`, OpenAPI freshness — all in `make verify` | ✅ ⭐ |

---

## Scorecard

| Bucket | Count | Share of the 105 rows |
|---|---|---|
| ✅ Built | 32 | 30% |
| 🟡 Partial | 13 | 12% |
| 📄 Specified only (no code) | 14 | 13% |
| ❌ Absent | 46 | 44% |

Counting only rows where kandev has a shipping capability, GateControl covers roughly
**43%** of it at some level (built or partial) — concentrated entirely in the core
review-first loop.

## Reading the result

**Where GateControl is at parity or better.** The single-task loop is complete and
tested end to end: issue → task → isolated worktree → live agent → diff → human decision
→ commit. On top of that, twelve rows are marked ⭐ — capabilities kandev does not have today — grouping into six themes: enforced
review gating in a *durable* workflow, subscription-vs-API-key billing integrity with a
verified environment strip, per-profile concurrency caps with park-on-quota, real
authentication with workspace tenancy plus rate limiting, a generated OpenAPI surface, and
an observability + quality-gate layer anchored by a merge-blocking isolation test.

**Where the gap is widest.** Breadth. Everything that makes kandev a platform rather than
a loop is missing: 20 of its 21 agents, three of its four executors, all six integrations,
the entire MCP surface (both directions), workflows and sub-tasks, multi-repo and
multi-branch tasks, and the whole system-management layer (backups, updates, disk usage,
installers, plugins).

**The largest single lever** is the MCP surface (rows 74–87) — it is what lets agents
coordinate work themselves, and nothing in GateControl approaches it. The second is the
executor matrix (rows 46–48): the specs are written, and `executorKindSchema` is a
one-value enum waiting to grow.

## Related

- [Decision 0001 — Build a near-clone of kandev](../decisions/0001-scope-near-clone-of-kandev.md)
- [Feature index F01–F18](../features/README.md)
- [Core Program spec](../../specs/001-core-program/spec.md) — the slice this build implements
