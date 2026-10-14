# Feature Comparison — SoloW (current build) vs. the category

**Status:** Reference · **Last reviewed:** 2026-10-09
**Baseline:** the capability surface comparable tools in this category ship or advertise —
the breadth [Decision 0001](../decisions/0001-scope-near-clone.md) committed SoloW to matching,
before [Decision 0031](../decisions/0031-focus-on-the-solo-power-user.md) narrowed 1.0 to the
solo power user.

This page compares **what SoloW actually ships today** (the main branch at version 0.21.0,
after roadmap Phases 0–4) against **that full capability surface**, drawn from the feature
inventories and roadmaps those tools publish.

It is a *state-of-the-code* comparison, not a spec comparison: every row's "SoloW today" was
checked against the code on 2026-10-09, not against the specifications. A wide table is not the
1.0 goal — 0031 judges 1.0 only by the path from an Issue to a reviewed pull request for one
person — so the rows also say which capabilities are deliberately **Later**.

## How to read the columns

| Column | What it holds |
|---|---|
| **Reference capability** | The capability as comparable tools ship or advertise it |
| **SoloW today** | What exists in this repository, with the code that backs the claim |
| **Status** | ✅ built · 🟡 partial · ❌ not built · ⏳ Later (moved after 1.0 by 0031; hidden or absent) · 🚫 won't do · ⭐ SoloW-only (as assessed on 2026-08-19; the other tools were not re-checked) |
| **Best implementation — and what it unlocks** | The design that is *correct*, not merely sufficient, and what it makes possible. For a built row, what is still missing |
| **UI shape & components** | The concrete surface (card, drawer, dialog, canvas…) and the components involved — `existing` for what is in `apps/web/src/components/`, **new** for what must be coded or pulled in |

### Component inventory this table assumes

**Already in the repo** (`apps/web/src/components/ui/`) — `Button`, `Input`, `Textarea`,
`Label`, `Form` (react-hook-form + zod), `Select`, `Checkbox`, `Dialog`, `AlertDialog`,
`Sheet`, `Popover`, `DropdownMenu`, `ContextMenu`, `Card`, `Badge`, `Tabs`, `Table`,
`ScrollArea`, `Separator`, `Skeleton`, `Progress`, `Toast`, `Tooltip`, `Avatar`, `Command`
(cmdk), plus the shell (`HeaderBar`, `Sidebar`, `StatusBar`, `CommandPalette`), the board and
`DiffView`. Libraries on hand: radix-ui, dnd-kit, cmdk, lucide-react, TanStack Query,
Tailwind 4, `@xyflow/react`, `@xterm/xterm`.

**Not in the repo** — `Switch`, `RadioGroup`, `Combobox`, `Accordion`/`Collapsible`, a shared
`Kbd`, TanStack Table, TanStack Virtual, `react-resizable-panels`, Monaco or CodeMirror,
Recharts.

---

## 1. Harness & task workflows

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 1 | Parallel task execution | Tasks run at once, each in its own worktree; the per-Profile cap is taken in the same write that moves a Task to Running (`claimTaskRunSlot`), so it holds under simultaneous starts. A start over the cap is refused, not queued | ✅ | Still missing: a real **admission queue** — pending launches ordered fair-share, with per-profile and per-repository locks — so a start over the cap waits instead of being refused | Queue depth in each column header; a **new** queue drawer (`existing` Sheet) listing pending launches and why each waits |
| 2 | Kanban drag-and-drop board | Seven lifecycle columns, or one column per Step when a Workflow is chosen (`board-columns.ts`); dnd-kit with keyboard and touch; a **New task** button and a one-field quick task | ✅ | Columns are now data. Missing: optimistic moves with rollback (the board refetches after the server answers) and virtualised long columns | `existing` DndBoard/Column/TaskCard; **new** TanStack Virtual |
| 3 | Live board status | WebSocket channel per Workspace with ticket auth, replay on reconnect; connection state on the status bar | ✅ | The board still invalidates and refetches on each event. Entity-level cache patches would remove refetch storms | No new surface |
| 4 | Guarded state transitions | One transition table in `packages/core/src/task.ts`; the board uses the same function to refuse an illegal or blocked drop, with a sentence, before any request | ✅ | Done by sharing the rule rather than publishing it as data; nothing further needed for 1.0 | `existing` Tooltip and ConfirmAction |
| 5 | Pipeline / DAG view | Each Task shows its Workflow Steps on an `@xyflow/react` canvas; Workflows are edited on a graph canvas. No board-wide graph of Tasks and their dependencies | 🟡 | A second projection of the Task query, keyed on Step and dependency edges, now that both exist | Read-only canvas of Tasks with dependency edges |
| 6 | Agentic workflows — a different harness per step | `workflow` + `workflow_step` tables: each Step names a Harness Profile, a prompt template, a gate (`human`, `auto`, `auto-unless-changes`, `agent-decides`), branches, MCP servers and Skills; the run moves Step by Step with a handoff (`advance.ts`). Behind `ff-workflows`, ON | ✅ | Built. Not yet proven on ten real Tasks (roadmap A3) | Workflow editor canvas and a Step canvas on the Task page |
| 7 | Workflow export/import as YAML | Export and import as a versioned **JSON** document that refers to things by name; import reports what does not exist in this Workspace (`workflow-transfer.tsx`) | ✅ | Import always creates a new Workflow; a diff against an existing one before overwriting is not built | `existing` Dialog |
| 8 | Per-column workflow automations | Steps advance on their own through their gate and branches. The per-Step `onEnter` automation is stored and validated, but nothing runs it | 🟡 | Run `onEnter` from the Step transition, inside 6 — not a separate rules engine | Inline in the Step editor |
| 9 | Sub-tasks resuming the parent session | `task.parentTaskId` with a hash-verified fork point; the child is briefed with the parent's transcript up to that point and gets its own worktree. A transcript replay, not a native harness-session fork | ✅ | Built | Indented cards on the board; a Subtasks panel on the Task page |
| 10 | Task dependencies / `blocked_by` | `task_dependency` table; a cycle is refused at write time with its path; every start path refuses a blocked Task | ✅ | Missing: starting a blocked Task automatically when its blockers finish | Blocked-by dialog, cycle dialog, lock and count on the card |
| 11 | Coordinator mode | — | ❌ | An emergent property of 9 + 10 + harness-facing MCP (75, 78), not a feature to build | — |
| 12 | Multi-repository tasks | `task_repository` join (up to 10 per Task), each with its own base ref, branch, worktree and pull request | ✅ | Built | Extra repositories in the create dialog; per-repository groups in Changes and review |
| 13 | Multi-branch tasks (several PRs) | The join is keyed on (task, repository, branch), so the API allows several branches of one repository; the UI creates one branch per repository, and delivery pushes only the branch SoloW made for the Task | 🟡 | A UI to add a branch, and delivery of a second, SoloW-owned branch | "Add branch" row in the repository group |
| 14 | Task documents with revision history | — (plans exist only as transcript widgets) | ❌ | `task_document` with append-only revisions; the substrate for 85 | A "Docs" tab |
| 15 | Task labels | Issues have labels (local or mirrored from the provider) and the Issues list filters by them; Tasks have none | ❌ | Workspace-scoped `task_label` with filtering in the same change | Label chips on cards; a filter bar |
| 16 | Public share links (redacted Gists) | — | ⏳ | Later (0031). Redaction must be a server-side allowlist plus the secret scrubber shared with 104 | Share dialog with a preview of exactly what leaves the machine |
| 17 | Issue management feeding the board | Create, edit and delete Issues, locally or on GitHub/GitLab; labels, comments, status derived from Tasks with a manual override; cursor pagination with filters in the address. Text search is a LIKE match | ✅ | Search beyond LIKE | `existing` Issues list and detail |
| 18 | Retry a failed task | Retry runs again in a new Session and keeps the old one; failure reasons in plain words; renewing an expired credential resumes the Tasks it blocked | ✅ | Missing: a Retry / Resume split and automatic retry with backoff for transient failures | `existing` Button; **new** split button |

## 2. Harness interfaces

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 19 | 21+ harnesses (Codex, Copilot, Gemini, Cursor, Devin, Qwen…) | **Two come ready to use**: Claude Code and opencode, the two rows every Workspace's harness catalog starts with (`DEFAULT_HARNESS_CATALOG`). Any other harness is added by hand in Settings as a custom catalog row: an ACP harness needs nothing more, a plain CLI runs with no tools or permission channel | 🟡 | Ready-made, tested catalog rows for the next most-used harnesses (Later, [Roadmap](../ROADMAP.md)) | Settings → Harnesses, "Add a custom harness" |
| 20 | ACP as the uniform harness boundary | A full ACP client over stdio (`packages/acp`) drives opencode; Claude Code runs on its own stream-JSON; a plain-CLI runner covers the rest — all behind one runner interface (`runners.ts`) | ✅ | Built. Claude Code is not wrapped as an ACP adapter; it has no ACP mode to wrap | Permission requests surface in the Task's transcript |
| 21 | BYO TUI harnesses / CLI passthrough in a PTY | A real terminal per Task in its worktree (31), and a plain-CLI protocol for harnesses that speak neither ACP nor stream-JSON. A TUI-only harness cannot be the Task's run | 🟡 | Run a TUI harness *as* the Task's run on the PTY channel, with persisted scrollback | `existing` terminal pane |
| 22 | Utility harnesses (commit messages, PR titles, summaries) | Commit message is a fixed string; the pull request title is the Issue title | ❌ | One `runUtility(kind, context)` service over a designated Profile, cached per Session | Inline "generate" buttons |
| 23 | Custom reusable prompt library | — (reusable instructions live only in Workflow Step templates) | ❌ | A `prompt` table using the same template engine as Workflow Steps | `/` menu in the composer |
| 24 | Voice mode (plugin) | — | ❌ | Only as the first consumer of a plugin API (100) | — |
| 25 | Harness profiles | Harness, credential, billing mode, cap, permission mode, model and mode pins, and an attached Harness Configuration ([0028](../decisions/0028-harness-configs-in-the-app.md)) | ✅ | Missing: versioning, and a snapshot of the Profile on each Task | `existing` Settings → Harness profiles |
| 26 | Per-profile model / mode / permission | Permission mode per Profile (default `acceptEdits`); for ACP, models and modes are read from the harness at handshake and a pin it no longer offers is flagged. Claude Code's model pin is free text | ✅ | Built | `existing` Select |
| 27 | Update a managed harness runtime | A minimum version per catalog row; a run below it is refused with an install hint; opencode ships as a pinned dependency. No update action | 🟡 | An update command on the catalog row, run through the executor interface | Version badge and Update button on the harness |
| 28 | Send input to / stop a running harness | Send and stop through the harness registry; on ACP a message sent mid-turn is held for the end of the turn | ✅ | Built | `existing` composer |
| 29 | Session management and resume | Append-only event log with replay, compaction into summaries at turn boundaries, fork points, and conversation resume (`claude --resume`, ACP `session/load`) | ✅ | Missing: a virtualised event list | **new** TanStack Virtual |

## 3. Integrated review workspace

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 30 | IDE-like unified view | Task page: a left pane, Board / Brief / Changes tabs, a right rail with the review gate, and a resizable terminal pane (its width saved per browser) | 🟡 | A persisted, resizable panel layout before adding more panels | **new** react-resizable-panels |
| 31 | Real terminal (xterm.js, PTY) | `@xterm/xterm` on a real PTY in the worktree; resumes the Task's Claude Code conversation or opens a shell. Runs where the Task runs: on the host for the local executor, and for the Docker one in a terminal container of its own with the run's image and mounts (`docker exec -it`), never falling back to the host (F07, roadmap B4) | ✅ | Built | `existing` terminal pane |
| 32 | Code editor with LSP (Monaco) | — (the diff viewer is read-only) | ❌ | Read-only Monaco first, an LSP bridge later | **new** Monaco |
| 33 | File tree | A tree of the changed files in the Changes tab; no browser of the whole worktree | 🟡 | A lazy listing of the worktree through the executor's jailed filesystem, which exists | **new** virtualised tree |
| 34 | Embedded VS Code | — | ❌ | A `vscode://` deep link, not an embed | "Open in editor" menu |
| 35 | Browser preview panel | — (`Executor.forward` exists; nothing uses it) | ❌ | A dev-server lifecycle owned by the executor profile | Preview panel with a sandboxed iframe |
| 36 | Git changes panel | A **read-only** changes panel built from the diff captured at the end of the harness's turn: per-file status, split/inline diff, per-file "viewed" marks. Stage, unstage and discard are not wired (the orchestrator has the git operations, nothing calls them), and approval commits every change in the worktree except copied setup files. The patch is capped at 256 KB, generated files folded first | 🟡 | Wire the live worktree status and the stage/discard operations ([0017](../decisions/0017-worktree-git-rpc.md)), then per-file lazy patch fetch | `existing` DiffView and source-control panel |
| 37 | Review dialog with per-repo grouping | One decision across repositories, grouped by repository and branch, each consequence shown before confirming | ✅ | Built | `existing` review gate |
| 38 | Chat with the harness | Composer plus a typed transcript (text and tool rows) rendered as Markdown with code highlighting | ✅ | Missing: a `/` command menu and attachments | `existing` composer |
| 39 | Approve / reject / request changes | All three recorded with actor and time; line-anchored notes on the diff, sent to the harness as `path:line` feedback | ✅ | Notes are flattened into the feedback text, not stored as structured data on the review | `existing` diff gutter notes |
| 40 | Nothing ships without a human decision | The review gate is a database state, and a decision starts the next run ([0030](../decisions/0030-review-gate-is-a-database-state.md)); each Workflow Step sets its own gate, and the last Step needs a recorded human approval | ✅ ⭐ | Built | Gate control on the Step editor |
| 41 | Push the branch / open a PR on approval | Approving commits, pushes the Task's own branch, and opens or updates the pull request on GitHub, GitLab or Gitea; a repository with no remote keeps a local commit, labelled so. A failed delivery offers **Ship again** or **Keep local** (`delivery.ts`) | ✅ | Missing: a per-repository strategy (push only, merge), and a title and body written by a utility harness (22) | Pull request link on the Task |
| 42 | Command palette / keyboard navigation | cmdk palette fed by a contribution registry with `when` clauses; recent Tasks and Issues; one labelled sidebar | ✅ | Built | `existing` Command |
| 43 | Mobile / phone orchestration UI | Responsive only: drawer sidebar, touch drag on the board, full-screen terminal on small screens. No phone-specific triage route | 🟡 | A dedicated triage-and-approve route | **new** bottom action bar |

## 4. Executors & runtime

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 44 | Local process executor | One `Executor` interface (spawn, exec, filesystem, forward, metrics, dispose, optional terminal) with a local and a Docker driver; an audit script keeps host access in one file. The local executor is documented and shown as "for trusted agents only" | ✅ | Built | Kind in the executor profile |
| 45 | Git worktree isolation | SoloW provisions and cleans up worktrees; Claude Code's first run still creates its own with `--worktree` | ✅ | Unify ownership on SoloW for every harness | Worktree path and branch on the Task |
| 46 | Docker executor | One container per Task over the `docker` CLI ([0023](../decisions/0023-docker-executor-cli.md)): image, guarded mounts, network, CPU and memory limits; a container holds one credential and none of the control plane's state. A new Executor Profile starts as Docker when Docker answers. The image must contain the harness | ✅ | A "Test connection" action for Executor Profiles | `existing` executor profile form |
| 47 | Remote SSH executor | The profile shape exists but has **no driver**; a Task on it fails before a harness starts. Hidden behind `ff-remote-environments`, OFF | ⏳ | Later (0031). A driver over 44; the hard parts are key management and remote file access | Hidden |
| 48 | Cloud executor (sprites.dev) | A generic cloud profile shape with **no driver**, lifecycle or cost signal. Hidden behind `ff-remote-environments`, OFF | ⏳ | Later (0031), after 47 | Hidden |
| 49 | Kubernetes operator | — | ❌ | Out of scope until the executor interface has more drivers | — |
| 50 | Executor profile config (prepare scripts, env, credentials) | Typed discriminated union per kind, `.strict()` members, credentials by secret reference, billing-guard variables refused | ✅ | Built | Form rendered per kind |
| 51 | Repositories: local clone or remote URL | Both — a local path in place, or a remote URL cloned into a cache | ✅ | Missing: a lock on the clone cache and default-branch detection | `existing` repository settings |
| 52 | Copy ignored files (`.env`) into new worktrees | A per-repository allowlist of globs copied into each new worktree; only counts are logged; the copies are kept out of the review diff | ✅ | Built | Pattern rows on the repository |
| 53 | Resource monitor (CPU, memory, disk, temperature) | — (the executors can measure CPU, memory and disk, but nothing displays it) | ❌ | Push the existing probe over the WebSocket to the status bar | Status-bar segment |
| 54 | Customisable, reorderable status bar | A contribution registry of eight items (Workspace, identity, running and in-review Tasks, failed and stuck runs, service health, Task count, mirror sync); each user shows, hides and reorders them in Settings | ✅ | Drag to reorder (today: move up/down) | `existing` StatusBar and Settings section |
| 55 | Desktop app (Tauri) | — (web only; installed through an npm launcher, 91) | ❌ | A PWA over the local server first | — |
| 56 | Durable orchestration across restarts | Inngest runs as the self-hosted, signed `inngest start` ([0004](../decisions/0004-durable-orchestration-engine.md) amendment); each service restarts on its own under a supervisor | ✅ ⭐ | Built | Step strip on the Task page |

## 5. Authentication, billing & security

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 57 | Named secrets store | AES-256-GCM, write-only after entry, never in a DTO or log; a "Used by" list; replacing a value rotates it | ✅ | Missing: envelope encryption with a rotatable data key, and an audit of reads | `existing` Settings → Secrets |
| 58 | Authentication for the deployment | Sign-in on by default in every launcher; **exactly one Owner account** per installation, held in the database (`0050_single_owner`); email and password with a brute-force limit | ✅ ⭐ | Session listing and revocation. Invitations, roles and OIDC are Later, with hosting | `existing` sign-in page |
| 59 | Multi-tenant workspace scoping | Every table carries a non-null `workspaceId` and every read filters on it; an installation has one Owner and one Workspace — no members, no switcher | ✅ | A membership table and a mechanical "every read is filtered" guard come with hosting (Later) | — |
| 60 | Subscription vs API-key billing | `resolveHarnessRunEnv` gives each run only the credential variable its billing mode names, read off the catalog row, and strips the other | ✅ ⭐ | Built | Auth mode on the Profile |
| 61 | Concurrency cap per profile | Default 3 (1–20) per Harness Profile, held by one atomic claim for every move into Running, including a Parked run waking; a start over the cap is refused | ✅ ⭐ | A queue with a visible position (row 1) and a warning before the attempt | "N of M running" in Settings |
| 62 | Quota exhaustion handling | A harness that stops with words that read as an exhausted quota or rate limit parks its Task; the run sleeps a **fixed five hours**, then takes a slot and runs again in the same worktree. **No quota is detected**, the reset time is not read, and there is no countdown ([F06](../features/F06-authentication-billing.md)) | 🟡 ⭐ | Real quota detection (Later): parse the reset time from the provider's answer and wake then | Parked card ("Paused on quota") |
| 63 | Credential expiry / revocation | A distinct "Credential expired" reason with a lock and a one-click **Renew** that opens the pre-filled secret form; saving the secret resumes the Tasks it blocked | ✅ | Built | Card alert and Renew |
| 64 | Cost tracking, model usage, budgets | Token usage recorded per turn (`session_usage`); the Outcomes page shows tokens and metered cost by Task, Profile and billing mode. **No budget or spending limit** | 🟡 | Budgets with a threshold alert (Later) | `existing` Outcomes page |
| 65 | Runtime feature toggles | Nine Workspace-level flags, a Settings section and a CLI; every flag ships ON except `ff-remote-environments` | ✅ | Missing: per-user targeting and an audit of who flipped what | `existing` Settings → Feature flags |
| 66 | Rate limiting | In-memory limits on secret writes, MCP token issue, launches, resets and retention changes, plus a sign-in limit | ✅ ⭐ | A persisted bucket that survives restarts | Plain-language alert on trip |
| 67 | Secret scanning in the build | `gitleaks` in `make verify`, in CI over the full history, and as a pre-commit hook | ✅ ⭐ | Scan the harness's diff before the review gate | Blocking alert in the review |

## 6. Integrations & MCP

> **Scope decision (2026-08-19):** the integration surface is limited to source hosts —
> **GitHub, GitLab and, since, Gitea**. Jira, Linear, Sentry and Slack are closed as
> `wont-do`. Their rows are kept below rather than deleted, so the parity count stays honest —
> declining a capability is not the same as having it.

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 68 | GitHub — import issues, link PRs, review activity | Issues imported on a schedule and on demand (polling, no webhooks); Issues created, edited and commented on at GitHub; Projects fields mirrored; approving a Task opens or updates its pull request | ✅ | Built | Settings → Integrations; Issues import |
| 69 | GitLab | The same capabilities as GitHub through the same provider registry, plus GitLab's own issue fields; merge requests opened or updated on approval. **Gitea** is a third provider (issues, repositories, pull requests) | ✅ | Built | Same connect form |
| 70 | Jira | Closed as `wont-do` (#79) | 🚫 | — | — |
| 71 | Linear | Closed as `wont-do` (#80) | 🚫 | — (the sync that remained chose polling over webhooks) | — |
| 72 | Sentry | Closed as `wont-do` (#98) | 🚫 | — | — |
| 73 | Slack | Closed as `wont-do` (#102) | 🚫 | — | — |
| 74 | External MCP server (streamable HTTP + SSE) | `/api/mcp`, its tools derived from the tRPC router (about 130 by a static count), scoped read or read-write tokens hashed at rest; whole areas withheld — secrets, streams, tokens, preferences, reviews, history, outcomes — and single procedures such as Ship again and Keep local | ✅ ⭐ | Built | Settings → MCP |
| 75 | Automatic task-scoped session MCP | — (harnesses get only the MCP servers in the Harness Library; tokens are per Workspace) | ❌ | A server whose token binds the Task id | — |
| 76 | Passthrough MCP for native-CLI harnesses | Library MCP servers are handed to Claude Code (`--mcp-config`) and ACP harnesses (`session/new`); SoloW's own MCP is not injected | 🟡 | Inject SoloW's own endpoint once 75 exists | — |
| 77 | MCP: discover workspace context | Workspace, repository, project, Issue and Task listings are readable over the external MCP; a running harness is not given them | 🟡 | Needs 75 | — |
| 78 | MCP: create tasks and subtasks, target sibling repos | An external agent with a read-write token can create Tasks and sub-tasks and attach repositories, through the same procedures as the UI | 🟡 | A harness-scoped path (75) and a "harness-created" marker | — |
| 79 | MCP: declare dependencies, cycle detection | Dependencies with cycle refusal are exposed; a blocked Task refuses to start; nothing starts it when its blockers finish | 🟡 | Record the intent to start and fire once when predecessors succeed | — |
| 80 | MCP: attach extra branches for multiple PRs | Several repository attachments per Task, each opening its own pull request; only SoloW's own branch is pushed, and attachments are fixed once the Task starts | 🟡 | Ship a second SoloW-owned branch per repository | — |
| 81 | MCP: adjust the diff base branch | Base ref per attachment, changeable only before the Task starts | 🟡 | Mutable after launch, with ahead/behind recomputed | — |
| 82 | MCP: move / archive / delete tasks, handoff prompts | Move, delete (into History) and restore are exposed; no handoff argument on a move | 🟡 | A handoff prompt as a first-class argument | — |
| 83 | MCP: message another task's session | — | ❌ | The turn-boundary queue of 28, addressed by Task id | — |
| 84 | MCP: read conversations, paginated and filtered | Session reads with a hash-verified cursor and event ranges are exposed; no filter by event type | 🟡 | A type filter | — |
| 85 | MCP: record structured task plans | — (the harness's todo list is captured from its transcript) | ❌ | 14 with a well-known document kind | — |
| 86 | MCP: signal step completion with summary and blockers | Built another way: the harness reports done or blocked with a summary in a `task_complete` widget, and Workflows branch on it. Not an MCP tool | 🟡 | Expose the same signal as a tool | — |
| 87 | MCP: see associated pull requests | `task.get` (also over MCP) returns each attachment's pull request URL and number; its state is not on the Task | 🟡 | Join the synced change-request state | — |
| 88 | Machine-readable API for external clients | OpenAPI 3 generated from tRPC (176 paths), checked for staleness in CI | ✅ ⭐ | A versioned artifact and a generated typed client | — |

## 7. Platform, system management & delivery

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 89 | Self-hosted, open source, no telemetry | Apache-2.0, local-first; the launcher fetches nothing unless asked. No test asserts that a run opens no outbound connection | ✅ | Make it a test, not a promise | — |
| 90 | Server-first — reachable from any device | Every service binds to the local machine by default; reaching it from the network is an explicit setting with a warning, refused together with the development "every visitor is the Owner" mode | ✅ | Secure cookies follow the build mode, not whether TLS is in front | — |
| 91 | Installers: Homebrew, Scoop, NPX, NPM | `npx @satcomx00-x00/solow` runs one launcher that migrates, bootstraps and supervises the three services; a systemd unit is provided. No Homebrew or Scoop | 🟡 | Package-manager wrappers around the same launcher | Launcher prints the URL |
| 92 | Stable / nightly channels, in-app updates | Releases go to npm after the checks pass; no channel choice and no update check | ❌ | Only with 93 as the safety net | — |
| 93 | Backups, snapshots, restore | `solow backup` and `solow restore`: a consistent, verified copy of the database, its keys and the engine's state; a copy before every migration, five kept; restore refused while running ([Backup and Restore](../operations/backup-and-restore.md)) | ✅ | A snapshots table in the UI. Note the copies include the keys | — |
| 94 | Disk usage inspection | A history retention window in Settings (7, 30, 90, 365 days or forever) with a preview of what would be pruned; an hourly sweep removes finished Tasks' transcripts and worktrees ([0032](../decisions/0032-transcript-retention.md)). No disk-usage view | 🟡 | Bytes by category with a per-row prune | — |
| 95 | System views: logs, DB status, about, licenses | Service health (orchestrator and run engine) and failed or stuck runs on the status bar. No log viewer, database status, about or licences page | 🟡 | A filterable live log stream | — |
| 96 | Feature-toggle settings page | Settings → Feature flags, with confirmation before the self-lockout flag | ✅ | An audit of changes | `existing` Settings section |
| 97 | Stats — completed tasks, harness turns, productivity | The Outcomes page: Tasks shipped per week (as pull request or local commit), run-to-approval rate, approval within two attempts, attempts per Task, spend by Task, Profile and billing mode ([F14](../features/F14-analytics-reporting.md)). Behind `ff-outcomes`, ON | ✅ | Cycle time by state and retry rate. Further analytics are Later | `existing` Outcomes page |
| 98 | Notifications | An in-app notice when a run fails or gets stuck, linking to the Task. Nothing else: no list, no preferences, no other channel | ⏳ | Later (0031): one dispatcher over the event stream with pluggable channels; the channel registry exists | — |
| 99 | Guided first-run onboarding | A setup checklist on the Projects page derived from real state (harnesses, credential, Harness Profile, executor, repository), with links into Settings | ✅ | A guided flow ending in a test run (roadmap E1) | `existing` setup card |
| 100 | Plugin system | — (the in-app registries for commands, status items and channels exist; no plugin API) | ❌ | Those registries plus a manifest and a permission prompt | — |
| 101 | Internationalisation | — (English only) | ❌ | A message-catalog boundary | — |
| 102 | Office mode — harness teams, roles, skills, memory, approvals, routines, budgets | — | ❌ | Assembled last from parts that each have their own value | — |
| 103 | Hosted, multi-user deployment | — One account per installation, SQLite only; the Postgres driver is not wired | ⏳ | Later (0031): Postgres, then members and roles (58 + 59), then per-Workspace limits | — |
| 104 | Structured observability | pino logs with run context, state transitions, timings, exception capture and credential redaction. No OpenTelemetry | ✅ ⭐ | OpenTelemetry spans for the user's own collector | — |
| 105 | Test and quality gates | In CI on every change: Biome, typecheck of every package, about 320 unit test files, lifecycle and live Docker smoke tests, OpenAPI freshness, migration drift, dependency and executor-boundary audits, gitleaks, Playwright in three shards with the `@critical` isolation suite; on every push to main the two control checks, and a release waits for all of it | ✅ ⭐ | Keep the `@critical` gate untouchable | — |

---

## Scorecard

| | Count | Share |
|---|---|---|
| ✅ Built | 52 | 50% |
| 🟡 Partial | 25 | 24% |
| ❌ Not built | 19 | 18% |
| ⏳ Later (0031) | 5 | 5% |
| 🚫 Won't do | 4 | 4% |

Of the **101 rows not declined**, SoloW covers **76%** at some level (built or partial), up from
48% on 2026-08-19. The four declined rows are counted separately rather than dropped: a
capability declined is not a capability held.

## Reading the result

**Where SoloW is at parity or better.** The loop is complete and tested end to end: issue →
task → isolated worktree → live harness → diff → human decision → commit → pushed branch and
pull request. Twelve rows carry ⭐ (as assessed on 2026-08-19): review gating held as a recorded
state, subscription-vs-API-key billing integrity, a per-profile concurrency cap that holds
under simultaneous starts, Parked work instead of failed work, sign-in on by default, rate
limiting, durable runs, a generated OpenAPI and MCP surface, and an observability plus
quality-gate layer.

**Where the gap is widest.** Harness breadth (two ready, against twenty or more), the
environments beyond one machine (remote and cloud are Later), harness-facing MCP (75–87 are
mostly partial), the editing surfaces of an IDE (32–35), and everything for teams. 0031 keeps
most of that after 1.0 on purpose.

## The eight foundations

On 2026-08-19 this page found that almost every absent row was blocked on one of eight
foundations. All eight are now in place:

| Foundation | State on 2026-10-09 |
|---|---|
| Harness catalog replaces the harness enum (19) | ✅ catalog rows; two seeded |
| A real ACP client (20) | ✅ `packages/acp`, driving opencode |
| `Executor` interface before the second executor (44) | ✅ local and Docker drivers |
| `(repository, branch)` join key on tasks (12, 13) | ✅ `task_repository` |
| `workflow` + `workflow_step` tables (6) | ✅ |
| Session log: typed messages, compaction, cursor (29, 38) | ✅ (no list virtualisation) |
| Per-turn usage capture (64) | ✅ `session_usage` |
| Contribution registries: commands, status items, channels (42, 54, 98) | ✅ (no plugin API on top) |

What follows from that is no longer "build the next foundation". Under 0031 the order is the
[Roadmap](../ROADMAP.md)'s: make the core loop safe, measured and easy to start for one person,
and add breadth only when real use asks for it.

## Tracking

Every row was filed as a GitHub issue titled with its row number in brackets
(`[42] Command palette and keyboard navigation`). The issues' open or closed state was not
re-checked on 2026-10-09; this page, not the issue tracker, is what was verified against the
code.

- **[Roadmap index — issue #109](https://github.com/Satcomx00-x00/SoloW/issues/109)** — row → issue map, the eight foundations, and the delivery order of 2026-08
- Three foundations have no row of their own: [#1](https://github.com/Satcomx00-x00/SoloW/issues/1) executor interface, [#2](https://github.com/Satcomx00-x00/SoloW/issues/2) session log, [#3](https://github.com/Satcomx00-x00/SoloW/issues/3) contribution registries
- [`scripts/labels.sh`](../../scripts/labels.sh) applies the label taxonomy's colours and descriptions

## Related

- [Decision 0031 — Focus on the solo power user](../decisions/0031-focus-on-the-solo-power-user.md)
- [Decision 0001 — Build a near-clone rather than a narrower product](../decisions/0001-scope-near-clone.md)
- [Decision 0003 — Integrate harnesses via ACP](../decisions/0003-agent-connection-protocol.md)
- [Feature index](../features/README.md)
- [Core Program spec](../../specs/001-core-program/spec.md) — the first slice this build implemented
