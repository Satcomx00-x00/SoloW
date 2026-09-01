# Feature Comparison — SoloW (current build) vs. the category

**Status:** Reference · **Last reviewed:** 2026-08-19
**Baseline:** the capability surface comparable tools in this category ship or advertise —
the breadth [Decision 0001](../decisions/0001-scope-near-clone.md) commits SoloW to matching.

This page compares **what SoloW actually ships today** (branch `001-core-program`,
all 29 tasks of the core slice verified) against **that full capability surface**, drawn
from the feature inventories and roadmaps those tools publish.

It is a *state-of-the-code* comparison, not a spec comparison. SoloW's F01–F18
specifications already describe most of that breadth; this table records which of
them have running code behind them.

## How to read the columns

| Column | What it holds |
|---|---|
| **Reference capability** | The capability as comparable tools ship or advertise it |
| **SoloW today** | What exists in this repository, with the code that backs the claim |
| **Status** | ✅ built · 🟡 partial · 📄 spec only · ❌ absent · ⭐ SoloW-only |
| **Best implementation — and what it unlocks** | The design that is *correct*, not merely sufficient, and the second-order effect: which other rows this feature makes possible, cheaper, or obsolete. Written adversarially — where the obvious implementation is a trap, the trap is named. |
| **UI shape & components** | The concrete surface (card, drawer, dialog, canvas…) and the components involved — `existing` for what is already in `apps/web/src/components/`, **new** for what must be coded or pulled in |

### Component inventory this table assumes

**Already in the repo** — `Button`, `Input`, `Textarea`, `Label`, `Form` (react-hook-form +
zod), `Select`, `Dialog`, `AlertDialog`/`ConfirmAction`, `Card`, `Badge`, `Tabs`,
`ScrollArea`, `Separator`, `Tooltip`, `Command` (cmdk), plus the shell (`ActivityBar`,
`HeaderBar`, `Navigator`, `StatusBar`, `CommandPalette`), the board (`DndBoard`, `Column`,
`TaskCard`, `TaskStateBadge`) and `DiffView`. Libraries on hand: radix-ui, dnd-kit, cmdk,
lucide-react, TanStack Query, Tailwind 4.

**Recurrently needed and not yet coded** — `Switch`, `Checkbox`, `RadioGroup`, `Popover`,
`DropdownMenu`, `ContextMenu`, `Combobox` (Popover + Command), `Accordion`/`Collapsible`,
`Sheet`/`Drawer`, `Toast`, `Skeleton`, `Progress`, `Table` (TanStack Table), `Kbd`,
`Avatar`. Heavier additions: `TanStack Virtual`, `react-resizable-panels`, `xterm.js`,
`@monaco-editor/react` or CodeMirror 6, `@xyflow/react`, `Recharts`, a virtualized tree.

---

## 1. Agent & task workflows

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 1 | Parallel task execution | Concurrent tasks in separate worktrees; proven by the `@critical` E2E | ✅ | Promote "isolation by worktree" into a real **admission controller**: a queue table ordered fair-share, with per-profile, per-executor and per-repository locks. Today's cap check at `task.launch` is a race under load. → makes 61 honest, is a precondition for 46–48, and gives 97 its queue-time metric | Queue depth meter in each column header; a **Sheet** "Queue" drawer listing pending launches with position and blocking reason. `existing` Column/Badge + **new** Sheet, Progress |
| 2 | Kanban drag-and-drop board | 7 columns, dnd-kit with a drag handle + `KeyboardSensor` | ✅ | Columns must become **data (workflow steps), not a hardcoded enum** — otherwise F03 forks the board into a second model. Add optimistic move with server reconciliation and rollback. → unlocks 6, 8, 15, 43 | `existing` DndBoard/Column/TaskCard; **new** TanStack Virtual for long columns, Toast for rollback, DropdownMenu on the card for quick actions |
| 3 | Live board status | WebSocket board channel with ticket auth | ✅ | One multiplexed subscription per workspace with topic filters and a resume cursor, feeding **entity-level cache patches** instead of `invalidate()`-and-refetch. → removes refetch storms and becomes the transport for 53, 98 and any dashboard | No new surface: a connection pill in `existing` StatusBar and a pulse on `existing` TaskStateBadge |
| 4 | Guarded state transitions | `packages/core/src/task.ts` state machine | ✅ | Publish the machine **as data** (`task.transitions` → allowed targets + refusal reason) so the client can grey out illegal drop targets *before* the drop instead of failing after it. → improves 2, 18, 82 and makes automations verifiable | Dimmed drop zones with a `existing` Tooltip carrying the reason; `existing` ConfirmAction for backward moves |
| 5 | Pipeline / DAG view | — | ❌ | Not a second data model — a **second projection** of the same task query, keyed on workflow step and dependency edges. Building it before 6 and 10 exist produces a graph with one node and no edges | Read-only **@xyflow/react** canvas, or a CSS-grid swimlane; view switch as a segmented control in `existing` HeaderBar |
| 6 | Agentic workflows — a different agent per step | `F03` spec only; no workflow tables, no ReactFlow | 📄 | **The keystone.** `workflow` + `workflow_step` tables where a step names an agent profile, a prompt template, a review-gate rule and an auto-advance condition; the Inngest `task-run` function becomes a loop over steps and reuses the durable machinery already built. → subsumes 8, feeds 9, 22, 40, 82; without it "multi-agent" is just "many single-agent tasks" | Two surfaces: an **editor** (reorderable step rows, each a `existing` Card with agent Select, prompt Textarea, gate control) and a read-only **monitor**. **new** Switch, DropdownMenu, dnd-kit reorder, @xyflow/react for the monitor |
| 7 | Workflow export/import as YAML | — | ❌ | Make the workflow Zod contract the serialization format with an explicit `version`; import must **dry-run and show a diff** before applying, never overwrite silently. → doubles as config backup (93) and team sharing | Settings row with Export / Import `existing` Buttons; a `existing` Dialog rendering the parsed diff in a `existing` ScrollArea before commit; **new** file input |
| 8 | Per-column workflow automations | — | ❌ | Do **not** build a separate rules engine. Express automation as a step property (`onEnter: run \| notify \| move`) inside 6, or you end up with two competing orchestrators and undefined precedence | Inline in the step editor Card: a `existing` Select plus conditional fields; no standalone surface |
| 9 | Sub-tasks resuming the parent session | No `parentTaskId`; tasks are flat under an Issue | ❌ | `task.parentTaskId` is the easy half. The real requirement is **session forking**: the child starts from a transcript reference, not a cold prompt — which means the event log must be append-only and addressable (29). → unlocks 11 and 78 | Indented cards or a fold affordance on the board; a "Subtasks" section in the workspace using **new** Collapsible + `existing` TaskCard; breadcrumb in the header |
| 10 | Task dependencies / `blocked_by` | — | ❌ | `task_dependency` edge table with **cycle detection at write time** (DFS over the workspace subgraph, reject with the offending path) and one hard rule: a blocked task is never auto-started by any path. → makes 1's queue correct, feeds 5, 11, 79 | "Blocked by" multi-select **new** Combobox on task detail; lock icon + count on the card; a `existing` Dialog naming the cycle path on rejection |
| 11 | Coordinator mode | — | ❌ | Not a feature to build — an **emergent property** of 9 + 10 + the task MCP (78). Building a bespoke coordinator first creates a second orchestration path that workflows will later contradict | A `existing` Switch on the agent profile plus a delegated-task tree in the workspace; no bespoke surface |
| 12 | Multi-repository tasks | 1 repo per task (`task.repositoryId`, non-null) | ❌ | Replace the column with a `task_repository` join carrying base ref, branch and position. The orchestrator change is mostly **plural iteration** — every worktree, diff and commit path already keys on a worktree row. Do it *before* 68, so PR creation is per-repo from day one | Repository multi-select in the create `existing` Dialog; Changes tab gains per-repo group headers with their own branch and status. **new** Accordion, Combobox; `existing` DiffView reused per group |
| 13 | Multi-branch tasks (several PRs) | 1 branch per task (`solow/task-<id>`) | ❌ | Falls out of 12 **for free** if the join key is `(repository, branch)` rather than repository. Choosing that key now, while still single-repo, is the cheapest future-proofing decision on this list | "Add branch" row inside the repo group: `existing` Input + Select for the base ref |
| 14 | Task documents with revision history | — | ❌ | `task_document` with **append-only revisions** (content hash + parent), so an agent rewriting a plan never silently destroys the previous one. → this is the substrate for 85, 86 and richer review context; small table, disproportionate leverage | A "Docs" tab: document list rail + editor pane. **new** CodeMirror 6 or Tiptap for markdown, revision picker `existing` Select with a diff toggle |
| 15 | Task labels | — | ❌ | Workspace-scoped `label` + `task_label`, but ship **filtering in the same change** — labels without a filter are decoration. Model saved views at the same time | Colour `existing` Badge chips on cards; label picker **new** Combobox on detail; a filter bar above the board with removable chips |
| 16 | Public share links (redacted Gists) | `F13` spec only | 📄 | Redaction must be a **server-side allowlist over event kinds plus a secret scrubber shared with 104**, and the preview must render the exact payload that will leave the machine. A client-side redactor here is a data-leak waiting to happen. Store a revocable share record | "Share" in a **new** DropdownMenu in the task header → `existing` Dialog with a scrollable preview, a "what was removed" summary, Publish / Revoke; live-share `existing` Badge on the card |
| 17 | Issue management feeding the board | Create / list / get / search, status derived from child tasks | ✅ | Today's `query` is a LIKE scan. Promote to a **server-driven table**: cursor pagination, status facets, saved filters. → the landing zone for imported issues (68) and the grouping key for 97 | **new** TanStack Table list view with faceted filter chips and Skeleton rows, alongside the existing detail page |
| 18 | Retry a failed task | New session started, prior session + reason preserved | ✅ | Split **retry-fresh** from **resume-from-last-step**, and expose the failure taxonomy (agent crash / tool error / repo error / quota) so transient classes can retry automatically with backoff. → feeds 62, 97, 98 | Split button: `existing` Button + **new** DropdownMenu ("Retry ▾ / Resume"); failure reason as an alert block above the terminal with the class as a `existing` Badge |

## 2. Agent interfaces

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 19 | 21+ agents (Codex, Copilot, Gemini, Cursor, Devin, Qwen…) | `agent_catalog` row, Workspace-scoped, seeded per Workspace with `claude_code` (#10) | ✅ | Shipped: the enum is gone. Adding a supported agent is now a catalog row plus a Profile pointing at it — no schema change, no DAL change. Still only one agent seeded; each new one is a row plus a driver behind its `protocol` (`apps/orchestrator/src/agent/protocols.ts`) once 20/21 exist | Settings → Agents: a `existing` Select bound to `profile.agentCatalog.list`, rendered on the profile form (`new` full Card grid with install state deferred to 27) |
| 20 | ACP as the uniform agent boundary | ACP decided (ADR 0003) and an `AgentRunner` interface exists — but the one runner drives Claude Code's CLI `stream-json` | 🟡 | Write **one real ACP JSON-RPC client over stdio** (`initialize` → `session/new` → `session/prompt` → `session/update`, plus permission requests) and re-express the Claude runner as an adapter, making `stream-json` one transport among N. Row 19 is a promise the code cannot keep until this exists | No direct surface. It shows up as capability Badges on the agent card and as a permission-request `existing` AlertDialog in the workspace |
| 21 | BYO TUI agents / CLI passthrough in a PTY | — | ❌ | A **PTY channel alongside the ACP channel**, multiplexed on the existing WebSocket with a binary frame kind; resize and scrollback persisted in the session store. → makes 31 real, unlocks agents that will never speak ACP, and gives every other feature a debugging escape hatch | Replace the log `<pre>` with **new** xterm.js + fit/search/weblinks addons; a `existing` Tabs toggle between "Activity" and "Terminal" |
| 22 | Utility agents (commit messages, PR titles, summaries) | Fixed server-side commit string | ❌ | One `runUtility(kind, context)` service over a designated profile, `kind` a closed union, **results cached per session** so reopening a task does not re-spend tokens. → the cheapest visible quality win on this list; directly improves 41 and 16, and feeds 64 | An inline "generate" `existing` Button inside each field with a **new** Skeleton while running; per-action profile override `existing` Select in Settings |
| 23 | Custom reusable prompt library | — | ❌ | A `prompt` table with variable interpolation validated at save time — and it must use **the same template engine as workflow steps (6)**, or the product ends up with two prompt syntaxes | A `/`-triggered menu in the chat composer using `existing` Command (cmdk), plus a Settings CRUD list of `existing` Cards |
| 24 | Voice mode (plugin) | — | ❌ | Low intrinsic value; worth building only as **the first consumer of a plugin API (100)** — a browser Web Speech implementation is trivial, the point is proving the extension seam | Mic `existing` Button in the composer with a recording ring; **new** Popover for engine/language settings |
| 25 | Agent profiles | Name, kind, auth mode, secret, concurrency cap | ✅ | A profile should carry the **whole launch envelope** (model, permission mode, extra args, env allowlist, prepare hooks) and be **versioned**, with each task recording the profile snapshot it ran under. → makes runs reproducible and gives 97, 64 and any audit story a stable key | Grow the existing settings section into a `existing` Card with `existing` Tabs (Identity / Auth / Runtime / Limits); **new** Switch for permission behaviour |
| 26 | Per-profile model / mode / permission | `DEFAULT_PERMISSION_MODE = "acceptEdits"` constant | 🟡 | Read the model and mode list **from the agent at handshake** (ACP advertises them) and render the picker from live data, falling back to the catalog row. A hardcoded model list is guaranteed to rot | `existing` Select populated async with a **new** Skeleton, plus an alert when a stored model is no longer offered |
| 27 | Update a managed agent runtime | — | ❌ | A version probe and update command **on the catalog row (19), executed through the executor interface (44)** so it works on Docker and SSH too. Done right it also fixes "agent not installed" preflight failures | Version `existing` Badge + Update Button on the agent card; a `existing` Dialog streaming the update log; a restart-required alert |
| 28 | Send input to / stop a running agent | Bidirectional WS input/stop frames with acks via `AgentRegistry` | ✅ | Add **turn-boundary queueing** — a message accepted mid-turn and delivered at the next boundary — with an explicit ack state machine. That is exactly the semantics MCP task-messaging (83) needs, so build it once | Composer hint "will send at end of turn" + queued-count `existing` Badge; stop becomes a `existing` ConfirmAction when the worktree is dirty |
| 29 | Session management and resume | `session` + `session_event` tables, ordered replay after reconnect | ✅ | Append-only log with a monotonic `(session, seq)` cursor is already there; what is missing is **compaction with summary records and pagination**, without which a long run becomes unrenderable and unforkable. → prerequisite for 9, 16, 84 | Virtualized event list (**new** TanStack Virtual), a "jump to review" anchor, and **new** Collapsible groups for tool calls |

## 3. Integrated review workspace

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 30 | IDE-like unified view | Terminal / Changes / Conversation tabs + review gate | 🟡 | Move to a **resizable, persisted panel layout** (explorer / centre / activity) before adding any panel. Tabs do not scale to five surfaces, and retrofitting layout after 31–36 land means rewriting all of them | **new** react-resizable-panels (or dockview) as the shell; `existing` Tabs demoted to *inside* panels; layout persisted per user |
| 31 | Real terminal (xterm.js, PTY) | Read-only streamed log rendered as text | 🟡 | Same channel as 21 — "activity log" and "terminal" are **two consumers of one transport**, not two features. Building a second streaming path here is the trap | **new** xterm.js with fit/search addons; a small toolbar for clear / copy / scroll-lock |
| 32 | Code editor with LSP (Monaco) | — | ❌ | Ship **read-only Monaco first** (syntax, go-to-line, used by the diff and file viewer), then an LSP bridge over the executor channel for local executors only. Starting with the LSP proxy is the classic way to spend a month for no visible gain | **new** @monaco-editor/react in the centre panel; `existing` Tabs for open files |
| 33 | File tree | — | ❌ | Lazy server-side directory listing **scoped to the worktree with a hard root jail** — this is the highest path-traversal risk in the product, so one audited resolver, shared with the diff file list | A **new** virtualized tree (no primitive exists), **new** ContextMenu for open / copy path, a filter `existing` Input at the top |
| 34 | Embedded VS Code | — | ❌ | **Do not embed.** A `vscode://file/<path>:<line>` deep link gives 95% of the value at none of the maintenance cost; an optional openvscode-server iframe can sit behind a setting for remote executors | An "Open in editor" **new** DropdownMenu on file rows |
| 35 | Browser preview panel | — | ❌ | The iframe is trivial; the real feature is a **dev-server lifecycle owned by the executor profile** (start/stop, port detection, forwarding). Without that it only ever works for one hardcoded port | Panel with a URL `existing` Input, reload/back Buttons, device-width `existing` Select, sandboxed iframe |
| 36 | Git changes panel | Per-file status + line counts + unified patch, truncated at 256 KB | ✅ | **Per-file lazy patch fetch** instead of one truncated blob, plus a split/unified toggle and per-file "viewed" marks. → removes the truncation cliff and is a precondition for the per-repo grouping in 12/37 | `existing` DiffView per file inside a virtualized list; **new** Switch for split/unified, **new** Checkbox for "viewed" |
| 37 | Review dialog with per-repo grouping | Single-repo review gate | 🟡 | Falls out of 12: group by worktree and show each repo's branch and integration target **in the same confirm step**, so the operator sees every consequence before one click | **new** Accordion per repo inside the review `existing` Dialog, each with its own summary line |
| 38 | Chat with the agent | Free-text input + persisted conversation history | ✅ | Type the conversation properly — roles and tool calls as discriminated variants rather than loose event payloads — then render markdown and code. → this typing is what 84 (MCP read), 16 (share) and 29 (compaction) all depend on | Message list with role affordances, **new** Collapsible tool blocks, composer with the `/` command menu from 23 and drag-drop attachment |
| 39 | Approve / reject / request changes | All three recorded with actor, timestamp, feedback | ✅ | Replace the single feedback box with **line-anchored comments on the diff**, submitted as one review. A paragraph of prose is a much weaker instruction to an agent than "this line, this problem" — this is the highest-leverage change to agent success rate in the whole table | Hover "+" on the diff gutter → **new** Popover comment box; a pending-comments tray; submit through the review `existing` Dialog |
| 40 | Nothing ships without a human decision | Enforced in the durable workflow (`waitForEvent`) | ✅ ⭐ | Make the **gate configurable per workflow step** (auto-approve a lint step, mandatory human on integration) while keeping "no integration without a recorded decision" as an unconditional invariant. Once 6 lands, an unconfigurable gate will simply be bypassed | Gate-rule `existing` Select on the step editor; a lock icon on steps that may never auto-approve |
| 41 | Push the branch / open a PR on approval | Commits onto a **local branch only** | 🟡 | Integration becomes a **strategy resolved per repository** — local branch / push / open PR / merge — with a git credential from the secret store and the title and body written by the utility agent (22). Needs 68 for auth. This is the most-requested missing outcome in the product | Integration `existing` Select on the repository card; the approve `existing` Dialog states the concrete outcome ("push to origin, open PR against `main`") before confirming; the result becomes a PR `existing` Badge with a link on the card |
| 42 | Command palette / keyboard navigation | `cmdk` palette, activity bar, navigator, status bar | ✅ | Make it **registry-driven** — commands contributed by feature modules with `when` clauses — because that registry is precisely what a plugin API (100) extends, and retrofitting one later means touching every command | `existing` Command; add a **new** Kbd primitive, recency ordering, and nested groups |
| 43 | Mobile / phone orchestration UI | Responsive layout only | ❌ | The phone job is **triage and approve**, not authoring. Ship a dedicated route — single-column board, swipeable task sheet, review gate — rather than compressing the desktop grid, which is how "mobile support" usually ends up unusable | **new** Sheet/Drawer, a bottom action bar, segmented control in place of `existing` Tabs, dnd-kit `TouchSensor` |

## 4. Executors & runtime

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 44 | Local process executor | `executorKindSchema = ["local"]` | ✅ | Formalise a single **`Executor` interface — spawn, exec, filesystem, port-forward, metrics, dispose — and make local its first implementation** *before* adding a second kind. Skip this and Docker, SSH and cloud each grow bespoke code paths that 27, 33, 35 and 53 then have to special-case three times | No surface of its own; appears as the kind in the executor profile `existing` Select |
| 45 | Git worktree isolation | `worktree` table + provision/adopt/cleanup, and Claude Code's own `--worktree` for the run | ✅ | **Unify ownership on SoloW.** Isolation currently leans partly on the agent's own worktree flag, which means every new agent (19) must re-implement isolation or it silently regresses — the one guarantee with zero tolerance in the constitution | Worktree path and branch as a copyable row in the task header (`existing` Tooltip + copy Button) |
| 46 | Docker executor | `F07` spec only | 📄 | A driver over 44: image per profile, workspace mounted, agent baked into the image. → also delivers **reproducible agent environments**, which quietly fixes most "agent not installed / wrong version" preflight failures | Profile `existing` Card with image Input, mounts list, env key/value repeater, and a "Test connection" Button streaming into a `existing` Dialog |
| 47 | Remote SSH executor | `F07` spec only | 📄 | Same driver shape; the hard parts are **key management (goes in the secret store, 57)** and file access for the diff and file tree over the executor filesystem interface — not the transport | Host / user / port `existing` Inputs, key `existing` Select sourced from secrets, a health `existing` Badge refreshed on a timer |
| 48 | Cloud executor (sprites.dev) | `F07` spec only | 📄 | A remote executor **with a lifecycle** (provision / suspend / destroy) and a cost signal feeding 64. Worth building only after 46 and 47 have proven the interface holds | Same profile card plus a lifecycle-state `existing` Badge and a cost `existing` Tooltip |
| 49 | Kubernetes operator | — | ❌ | Out of scope until the executor interface is stable. When it arrives it is a driver plus a CRD — infrastructure, not a product feature | None beyond a profile card |
| 50 | Executor profile config (prepare scripts, env, credentials) | Typed `config` JSON per kind, discriminated union, credentials by reference (#73) | ✅ | Shipped: one table, N shapes, so 46–48 are each a union member plus a driver rather than a migration. The kind lives *inside* the config, `.strict()` members reject a pasted credential instead of silently dropping it, and the billing-guard variables cannot be named in a profile at all | A form **rendered dynamically from the selected kind**: `existing` Select → conditional `existing` Form fields, monospace prepare-script Textarea, env key/value repeater rows (`new`) |
| 51 | Repositories: local clone or remote URL | Both — `local_path` in place, `remote_url` cloned into a cache | ✅ | Add fetch/refresh, default-branch detection, and per-repository credential binding; the clone cache needs a **lock**, since two concurrent launches on a cold cache race today | Repository `existing` Card with a remote Badge, default-branch Select, "Fetch now" Button, last-sync timestamp |
| 52 | Copy ignored files (`.env`) into new worktrees | — | ❌ | A per-repository **glob allowlist** copied post-provision through the executor filesystem interface, never logged. Small feature, disproportionate effect: it is the difference between an agent that can run the test suite and one that cannot | A patterns repeater on the repository card with a standing warning alert about secret material |
| 53 | Resource monitor (CPU, memory, disk, temperature) | — | ❌ | A metrics probe **on the executor interface**, polled at low frequency and pushed over the existing WS topic (3) — not a new channel. → gives 1's scheduler real inputs and 64 a denominator | Status-bar segments with sparklines (**new** Recharts or hand-drawn SVG) expanding into a **new** Popover with per-metric detail |
| 54 | Customisable, reorderable status bar | Fixed status bar (task count, stream state, identity) | 🟡 | A **contribution registry** — items with id, priority and renderer, order persisted server-side. Same pattern as the command palette (42); build both registries once and 100 becomes tractable | `existing` StatusBar + dnd-kit reorder; a **new** Popover settings list with a **new** Switch per item |
| 55 | Desktop app (Tauri) | Web only | ❌ | Skip until installers (91) exist. A **PWA over the local server** satisfies the same "not a browser tab" need at a fraction of the build and signing cost | None |
| 56 | Durable orchestration across restarts | Inngest `task-run`, replayable steps, verified by tests | ✅ ⭐ | Keep Inngest, but place step boundaries **exactly at the points that must survive a restart** (provision, each agent turn, review wait, integrate) and record a resumable cursor per task. → this is the machinery 6, 9, 62 and 102's routines all reuse; getting the boundaries wrong makes workflows non-resumable later | A run-timeline strip in the workspace: one `existing` Badge per step with a `existing` Tooltip carrying timings |

## 5. Authentication, billing & security

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 57 | Named secrets store | AES-256-GCM, write-only after entry, never in a DTO or log | ✅ | **Envelope encryption with a rotatable data key**, plus a per-secret usage audit (which profile or task read it, when) and reference-by-id everywhere instead of value injection. → prerequisite for 47 (SSH keys), 41 and 68 (git/API tokens) | Existing write-only section plus a "Used by" list per secret and a Rotate Button behind a `existing` AlertDialog |
| 58 | Authentication for the deployment | **Shipping** — BetterAuth email + password, session guard on every procedure | ✅ ⭐ | Add session listing and revocation, optional OIDC, and **role assignment now, while the surface is small**. Retrofitting roles after multi-user exists means auditing every procedure a second time | Settings → Account: a sessions **new** Table with revoke, a provider Card row, and an invite `existing` Dialog |
| 59 | Multi-tenant workspace scoping | Non-null `workspaceId` on all 11 tables, filtered in every DAL read | ✅ ⭐ | Add a workspace switcher and a membership table before hosted mode — and **enforce the "every read is filtered" invariant mechanically** (a DAL-level guard or a lint rule), not by reviewer discipline, which is what erodes first under delivery pressure | Workspace **new** Combobox in `existing` HeaderBar; a members **new** Table in settings |
| 60 | Subscription vs API-key billing | `resolveAgentRunEnv` strips whichever variable the running Agent's catalog row names (#10) | ✅ ⭐ | Shipped: the strip rule reads `subscriptionEnvVar` / `meteredEnvVar` off the catalog row instead of a hardcoded pair — the guarantee now holds for whichever agent is actually running, proven by a test using a hypothetical second agent's variable names | Auth mode as a **new** RadioGroup on the profile with a per-mode explanation, and a warning `existing` Badge whenever a profile could bill metered |
| 61 | Concurrency cap per profile | Default 3, enforced at `task.launch` and in the guard | ✅ ⭐ | Promote to the real queue in row 1, with **visible position** and the pre-launch warning the spec already requires (AC-015) but the build defers | Cap `existing` Input with a live "N/M running" meter; a pre-launch `existing` AlertDialog when the launch would exceed the cap |
| 62 | Quota exhaustion handling | Task → **Parked**, work preserved, resumes on window reset | ✅ ⭐ | **Parse the reset time from the agent's own error** and schedule the resume rather than polling a window; surface the countdown. → makes 98 ("resumed") meaningful and stops Parked from looking like Stuck | Parked card with a countdown chip and a `existing` Tooltip naming where the reset time came from |
| 63 | Credential expiry / revocation | Classified in the guard; no distinct UI state | 🟡 | Give it a **distinct state (or a Parked sub-reason) with a one-click path from the card into the pre-filtered secret form**. The gap between "board is dead" and "two-click recovery" is entirely this row | Card alert variant + a Button opening the secret `existing` Dialog in place |
| 64 | Cost tracking, model usage, budgets | — | ❌ | Capture **per-turn usage into a `session_usage` table at write time**, from the agent's own usage events. Aggregation is then a query. This is the one row that is cheap today and impossible to backfill later — every day without it is permanently lost data | A cost `existing` Badge on the session; in analytics, a stacked bar by profile (**new** Recharts); budget threshold Input with an alert |
| 65 | Runtime feature toggles | `ff-core-program` registry, per-workspace overrides, CLI kill switch | ✅ | A typed registry with **per-workspace and per-user targeting plus an audit of who flipped what** — flags without attribution become permanent mysteries | Settings → System: a flags **new** Table with a **new** Switch per row and a restart-required alert |
| 66 | Rate limiting | `server/rate-limit.ts`, tripped by `secret.set` in tests | ✅ ⭐ | A shared **persisted token bucket keyed by (workspace, user, procedure class)** so it survives restarts, with remaining budget returned in headers | None, beyond a plain-language alert on trip |
| 67 | Secret scanning in the build | `gitleaks` wired into `make verify` | ✅ ⭐ | Also **scan the agent's diff before the review gate and block approval on a hit**. The repository is not the risk surface — what the agent writes is. Direct ripple into 39 and 41 | A blocking alert inside the review `existing` Dialog listing findings at `file:line`, with an override that requires typing a confirmation |

## 6. Integrations & MCP

> **Scope decision (2026-08-19):** the integration surface is limited to **GitHub and GitLab**. Jira, Linear, Sentry and Slack are closed as `wont-do`. Their rows are kept below rather than deleted, so the parity count against the category stays honest — declining a capability is not the same as having it.

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 68 | GitHub — import issues, link PRs, review activity | `integration` + `change_request` + `repository_branch` tables, `ChangeProvider` interface (#15) | ✅ | Shipped: idempotent import on `(integrationId, externalId)`, PAT-authenticated, contract-tested against a fixture server, no live API in CI. Change requests and branches sync on demand (v1: manual, not scheduled/webhook). `createChangeRequest`/write-back are explicitly not built — that's #71, gated on #7 | Settings → Integrations: a connect form + linked-repository list with a `new` Sync-now action; the Issues page's Import dialog (`new` Checkbox rows in a `existing` ScrollArea, not a full TanStack Table) |
| 69 | GitLab | `GitlabProvider` over the same `ChangeProvider` interface (#15) | ✅ | Shipped alongside 68 rather than after it — the interface held with no changes: GitLab's `opened`/`merged`/`locked` states and `iid` numbering map onto the same neutral shape a GitHub PR does, proving the abstraction rather than assuming it | Same connect form (provider `existing` Select), same linked-repository list; no bespoke surface |
| 70 | Jira | Closed as `wont-do` (#79) | 🚫 | Dropped with the scope decision. Jira was the driver that would have forced **status and field mapping** into the provider interface — every customer's Jira defines its own status model. With it gone that layer is unnecessary, and #15's interface stays narrower than originally planned | None |
| 71 | Linear | Closed as `wont-do` (#80) | 🚫 | Dropped with the scope decision. Linear was push-native and would have forced **webhook sync** into the interface. That requirement did not leave with it — it moved onto #15, since GitHub and GitLab both offer webhooks and polling leaves imported issues permanently stale | None |
| 72 | Sentry | Closed as `wont-do` (#98) | 🚫 | Dropped with the scope decision. Sentry was always a different shape — an **event source that creates tasks from errors**, not an issue source. If error-driven task creation is ever wanted it belongs on the notification dispatcher as a trigger direction, never on the issue importer | None |
| 73 | Slack | Closed as `wont-do` (#102) | 🚫 | Dropped with the scope decision, and it cost nothing — Slack was scoped as **a channel on the dispatcher, not an integration**. #92 keeps its registry and its in-app channel; there is simply one fewer channel to register. This is what correct scoping buys at the moment requirements change | None |
| 74 | External MCP server (streamable HTTP + SSE) | `/api/mcp`, 25 tools derived from the tRPC procedures, scoped `mcp_token` (#16) | ✅ ⭐ | Shipped as an adapter, not a parallel API: tool names, input schemas and read/write classification are all read off the same router that generates `openapi.json`, so adding a procedure adds a tool. Calls go through `appRouter.createCaller`, which means there is exactly **one** authorisation path — the flag guard, rate limit and Workspace scoping are the SPA's, not a second copy. Tokens are hashed at rest and shown once. `secret`, `stream` and `mcpToken` are deliberately withheld from the surface | Settings → MCP: endpoint URL with a copy Button, an issued-token list with revoke, and per-client config snippets in `existing` Tabs |
| 75 | Automatic task-scoped session MCP | — | ❌ | Inject a server whose **token binds the task id**, and scope the tool set by the task's own permissions — an agent must not be able to reach a sibling task it was not given | A "Tools" `existing` Badge on the running session, expanding to what the agent may call |
| 76 | Passthrough MCP for native-CLI agents | — | ❌ | Same endpoint, different injection point (env or config file for the CLI). Depends entirely on 21 | None |
| 77 | MCP: discover workspace context | — | ❌ | Ship **first** — every other tool is useless without it, and it is a read-only mapping of existing list procedures, so it is also the cheapest | Invisible; appears in the task timeline as an agent-invoked action |
| 78 | MCP: create tasks and subtasks, target sibling repos | — | ❌ | Needs 9 and 12. Creation from an agent must go through **the same service the UI uses** — a second creation path is how invariants (workflow assignment, tenancy, gates) get bypassed | Invisible; created subtasks appear on the board with an "agent-created" `existing` Badge |
| 79 | MCP: declare dependencies, cycle detection | — | ❌ | Needs 10. The agent-facing rule that matters: **a create declaring `blocked_by` must record its intent to start and fire once, when predecessors succeed** — otherwise chained creates all launch at once | Invisible; the dependency shows up in 10's UI |
| 80 | MCP: attach extra branches for multiple PRs | — | ❌ | Falls out of 12/13's `(repository, branch)` key. Without that key this tool is unimplementable | Invisible; new worktrees appear as repo groups in the Changes tab |
| 81 | MCP: adjust the diff base branch | `baseRef` fixed at creation, never adjusted | ❌ | Base ref must become **mutable state on the task-repository row**, with ahead/behind recomputed on change. Cheap, and it is what makes long-running tasks reviewable against a moving target | A base-branch `existing` Select on the repo group header with an ahead/behind `existing` Badge |
| 82 | MCP: move / archive / delete tasks, handoff prompts | `task.move` exists in the API but is not agent-facing; no archive or delete | 🟡 | Expose the existing transition service as a tool, gated by 4's published rules, and make the **handoff prompt a first-class argument** so a step change carries context. Add archive (soft) before delete (hard) | Invisible; archive surfaces as a board filter toggle and an "Archived" view |
| 83 | MCP: message another task's session | — | ❌ | Exactly 28's turn-boundary queue, addressed by task id: running → queue for the next turn, idle → deliver now, absent → start with it. **Build the queue once, expose it twice** | Invisible; inbound messages render in the target conversation with a source-task chip |
| 84 | MCP: read conversations, paginated and filtered | `session.get` serves the UI only | 🟡 | Needs 29's compaction and 38's typed messages, then it is the same query with a cursor and a type filter. Returning raw untyped events to an agent burns its context for nothing | Invisible |
| 85 | MCP: record structured task plans | — | ❌ | This *is* 14 (task documents) with a well-known document kind. Building a separate "plans" store would duplicate revision handling | Plan renders in the Docs tab; a plan-progress chip on the card |
| 86 | MCP: signal step completion with summary and blockers | — | ❌ | Needs 6. The completion signal is what lets a workflow **advance on the agent's judgement instead of on a heuristic**, and its blockers payload feeds 10 and 98 | Invisible; the summary lands on the run timeline (56) as the step's caption |
| 87 | MCP: see associated pull requests | — | ❌ | Falls out of 68 + 41: once integration is a strategy that records its outcome, "associated PRs" is a column, not a feature | PR `existing` Badge with state colour on the card and in task detail |
| 88 | Machine-readable API for external clients | OpenAPI 3 generated from tRPC (21 paths), staleness-checked in CI | ✅ ⭐ | Publish it as a **versioned artifact and generate a typed client from it**, so 74's MCP adapter, the SPA and any external tool share one source of truth rather than drifting | A docs route rendering the spec (Scalar or Redoc) behind the flag |

## 7. Platform, system management & delivery

| # | Reference capability | SoloW today | Status | Best implementation — and what it unlocks | UI shape & components |
|---|---|---|---|---|---|
| 89 | Self-hosted, open source, no telemetry | Apache-2.0, local-first, no external services required | ✅ | Make it a **test, not a promise**: assert that a default run opens no outbound connection. This property erodes silently, one convenient SDK at a time | None |
| 90 | Server-first — reachable from any device | Next.js + orchestrator processes | ✅ | Harden the bind and reverse-proxy story (auth on by default, no localhost-only assumptions, correct `secure` cookies behind TLS) **before** 43 makes remote access the normal case | None |
| 91 | Installers: Homebrew, Scoop, NPX, NPM | Source checkout + `make` / `bun run dev` only | ❌ | One **launcher that boots web + orchestrator + migrations in a single process** is worth more than three package managers. Until it exists, every non-developer is blocked, and no amount of feature breadth changes that | First-run CLI output printing the URL and the initial owner credentials |
| 92 | Stable / nightly channels, in-app updates | — | ❌ | Only after 91, and only with 93 as the safety net: version check, changelog fetch, one-command upgrade | Settings → System: an update `existing` Card with current/latest Badges, a changelog `existing` ScrollArea, and an Update Button behind a `existing` AlertDialog |
| 93 | Backups, snapshots, restore | — | ❌ | Snapshot the SQLite file plus a **reference** to the secrets key — never the key itself. The **automatic pre-migration snapshot is the valuable half**; manual backup is the garnish | A snapshots **new** Table (size, date, create / restore / delete) with a typed-confirmation restore `existing` AlertDialog |
| 94 | Disk usage inspection | — | ❌ | Derive from the worktree / repository / session tables plus a cheap executor-side `du`, and ship it **with a retention policy** (auto-prune worktrees of Done tasks after N days). A number with no action attached is just anxiety | A breakdown bar plus a **new** Table by category with a per-row Prune Button |
| 95 | System views: logs, DB status, about, licenses | — | ❌ | Expose the structured logger's ring buffer as a **filterable live stream**, not a file dump — it is the first thing a self-hoster reaches for when an agent fails, and today there is nothing | A virtualized log **new** Table with level and source facets and a live-tail **new** Switch |
| 96 | Feature-toggle settings page | Flags enforced, but CLI-managed | 🟡 | Same surface as 65 — one page, one table, one audit trail | The flags Table from 65 |
| 97 | Stats — completed tasks, agent turns, productivity | `F14` spec only | 📄 | Build on 64's per-run facts. The metrics that matter are **cycle time by state, approval rate, retry rate and cost per accepted change** — not task counts, which measure activity rather than value. Requires no new capture if 64 lands early | A dashboard route: KPI tile row, state-duration stacked bar, approval-rate trend line (**new** Recharts), and a filterable runs **new** Table |
| 98 | Notifications | `F15` spec only | 📄 | **One dispatcher over the existing event stream** with per-event-type rules and pluggable channels (in-app first, then web push, Slack, email). Per-feature notification code is how this ends up inconsistent | A bell **new** Popover with grouped unread items, a preferences **new** Table of type × channel Switches, and **new** Toast for live events |
| 99 | Guided first-run onboarding | `F18` spec only; Settings implies the order | 📄 | A **checklist derived from real state** (has a secret? a profile? a repository? a completed run?), not a scripted tour — derived state stays correct as features are added; a tour rots on contact | A dismissible `existing` Card on the board with a **new** Progress bar and deep links; the existing empty states become its CTAs |
| 100 | Plugin system | — | ❌ | Define the **seams first** — command registry (42), status-bar contributions (54), notification channels (98), agent catalog (19). A plugin API is those four registries plus a manifest and a permission prompt; without them it is a rewrite | Settings → Plugins: list with an enable **new** Switch and a permissions `existing` Dialog on install |
| 101 | Internationalisation | Explicitly deferred (TASK-021) | ❌ | Adopt the **message-catalog boundary now** while keeping a single locale. Wrapping strings across 200 components later costs an order of magnitude more than wrapping them as they are written | A language `existing` Select in account settings |
| 102 | Office mode — agent teams, roles, skills, memory, approvals, routines, budgets | — (unreleased in comparable tools too) | ❌ | Deliberately **last, and assembled rather than built**: agent instances (19 + 25), delegation (9 + 10 + 78), approvals (39 + 40), routines (a scheduler on 56), cost (64), memory (14). Every part has independent value; the mode is the composition | A separate route: agent roster **new** Table, an inbox list, dashboards — no new primitives |
| 103 | Hosted, multi-user deployment | `F16` spec only; SQLite local-first, Postgres mirror is a documented follow-up | 📄 | The **Postgres dialect switch is the blocker**, and the column specs are already shared — then RBAC (58 + 59) and per-workspace resource limits. Do not add hosted-only features before the store is portable | Admin route: workspaces **new** Table, member management, quota `existing` Inputs |
| 104 | Structured observability | Run context, state transitions, timings, exception capture, credential redaction | ✅ ⭐ | Emit **OpenTelemetry spans carrying the run context as attributes** so a self-hoster can point it at their own collector, and share the redaction scrubber with 16 — two scrubbers means one of them is wrong | None in-app beyond 95 |
| 105 | Test and quality gates | Biome, 7/7 typecheck, 149+ unit, Playwright with a merge-blocking `@critical` isolation suite, gitleaks, OpenAPI freshness | ✅ ⭐ | Keep the `@critical` gate untouchable and add **per-PR budgets** (bundle size, query count, migration drift) plus 67's diff-secret-scan case. The isolation suite is the one gate that must never be marked flaky | None |

---

## Scorecard

| | Count | Share |
|---|---|---|
| ✅ Built | 37 | 35% |
| 🟡 Partial | 11 | 10% |
| 📄 Specified only (no code) | 9 | 9% |
| ❌ Absent | 44 | 42% |
| 🚫 Out of scope | 4 | 4% |

Of the **101 rows still in scope**, SoloW covers **48%** at some level (built or
partial) — no longer concentrated entirely in the core review-first loop, now that GitHub
and GitLab import stand alongside it and the product is drivable from outside itself. The
four out-of-scope
rows are counted separately rather than dropped: a capability declined is not a
capability held, and a parity table that quietly deletes what it decided against
flatters itself.

## Reading the result

**Where SoloW is at parity or better.** The single-task loop is complete and tested
end to end: issue → task → isolated worktree → live agent → diff → human decision → commit.
Twelve rows carry ⭐ — capabilities comparable tools do not have today — grouping into six themes:
review gating enforced inside a *durable* workflow, subscription-vs-API-key billing
integrity with a verified environment strip, per-profile concurrency caps with
park-on-quota, real authentication with workspace tenancy and rate limiting, a generated
OpenAPI surface, and an observability plus quality-gate layer anchored by a merge-blocking
isolation test.

**Where the gap is widest.** Breadth. Everything that makes those tools a platform rather than
a loop is missing: 20 of their ~21 agents, three of their four executors, both in-scope integrations, the
entire MCP surface in both directions, workflows and sub-tasks, multi-repo and multi-branch
tasks, and the whole system-management layer.

## What the "best implementation" column adds up to

Read down that column and the 105 rows collapse into **eight foundations**. Almost every
absent row is blocked on one of them, and each one is cheap now and expensive later.

| Foundation | Rows it unblocks | Why it is urgent rather than important |
|---|---|---|
| **Agent catalog replaces the agent enum** (19) ✅ shipped (#10) | 20, 21, 26, 27, 60 | Was: every agent added before the catalog exists is a hardcoded special case — including the billing strip, which is the product's headline differentiator. Now: both are catalog-row data; 20/21/26/27 are unblocked, pending their own drivers |
| **A real ACP client** (20) | 19, 26, 76 | ADR 0003 is accepted but unimplemented; "multi-provider" is currently a claim the code cannot honour |
| **`Executor` interface before the second executor** (44) | 46, 47, 48, 27, 33, 35, 52, 53 | The moment Docker lands without it, three subsystems grow three filesystem implementations |
| **`(repository, branch)` join key on tasks** (12, 13) | 37, 41, 68, 80, 81, 87 | A column-to-join migration is painful; choosing the composite key *today*, while still single-repo, costs nothing |
| **`workflow` + `workflow_step` tables** (6) | 2, 5, 8, 9, 40, 82, 86, 102 | Board columns are a hardcoded enum. Every day that stays true, more code binds to the enum instead of to steps |
| **Session log: typed messages, compaction, cursor** (29, 38) | 9, 16, 84, 85 | Sub-task forking and agent-facing conversation reads are both unimplementable over loosely-typed events |
| **Per-turn usage capture** (64) | 97, 102, 48 | The only row in the table whose data **cannot be backfilled** — every run executed without it is permanently unmeasurable |
| **Contribution registries: commands, status items, channels** (42, 54, 98) | 24, 73, 100 | A plugin API is these registries plus a manifest; retrofitting them means touching every command and every notification site |

Three ordering conclusions follow directly:

1. **The MCP surface (74–87) is the highest-leverage remaining work** — the tRPC procedures
   and Zod contracts already exist, so it is an adapter rather than new domain logic, and it
   makes every other feature scriptable, including by the agents themselves. Rows 11, 78, 79
   and 85 together *are* coordinator mode; none of them needs a coordinator to be built.
2. **The executor matrix (46–48) is the widest capability gap with the smallest design
   risk** — the specs are written, and `executorKindSchema` is a one-value enum waiting to
   grow behind a typed config union (50).
3. **The cheapest UX win is line-anchored review comments (39)**, not a new panel. A
   paragraph of prose is a far weaker instruction to an agent than "this line, this problem",
   and it needs no new subsystem — only a Popover on the diff gutter.

And two explicit anti-recommendations, because the obvious build order is wrong in both
cases: do not embed VS Code (34) when a `vscode://` deep link delivers the same value, and
do not start Monaco with the LSP bridge (32) — read-only syntax highlighting is 80% of the
benefit for 20% of the work.

## Tracking

Every row in this document is a GitHub issue, titled with its row number in brackets
(`[42] Command palette and keyboard navigation`). The 32 ✅ rows are **closed** with their
shipped evidence and a recorded follow-up; the other 73 are open, carry `Blocked by #n`
dependencies, and are labelled by priority, kind, area, effort and status.

- **[Roadmap index — issue #109](https://github.com/Satcomx00-x00/SoloW/issues/109)** — row → issue map, the eight foundations, and the suggested delivery order
- Three foundations have no row of their own: [#1](https://github.com/Satcomx00-x00/SoloW/issues/1) executor interface, [#2](https://github.com/Satcomx00-x00/SoloW/issues/2) session log, [#3](https://github.com/Satcomx00-x00/SoloW/issues/3) contribution registries
- [`scripts/labels.sh`](../../scripts/labels.sh) applies the label taxonomy's colours and descriptions

## Related

- [Decision 0001 — Build a near-clone rather than a narrower product](../decisions/0001-scope-near-clone.md)
- [Decision 0003 — Integrate agents via ACP](../decisions/0003-agent-connection-protocol.md)
- [Feature index F01–F18](../features/README.md)
- [Core Program spec](../../specs/001-core-program/spec.md) — the slice this build implements
