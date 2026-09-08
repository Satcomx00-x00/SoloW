# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary: the solo developer, working locally.** One person running several AI coding
harnesses in parallel on their own machine, usually on a personal Claude Pro/Max subscription
(confirmed by the user, 2026-09-07). They value speed, low cost, staying in control, and
keeping code and credentials on their own hardware. The running build is single-Owner: the
first visit creates the one Owner account, and a second account is refused.

Other audiences (team lead, reviewer, operator of a hosted instance) are described in
`docs/product/02-personas-and-jobs.md` as later goals. They are not a design driver today;
hosted multi-user is a future deployment mode, not a current surface.

Situation and job: work arrives as issues (native or mirrored from GitHub/GitLab). The user
breaks an issue into tasks, points a harness at each task, watches the runs, reviews the
proposed diff, and approves or sends it back. Nothing merges without that approval.

## Product Purpose

SoloW ("Solo Workflow") is an open-source, self-hostable control plane for orchestrating AI
coding-harness CLIs (Claude Code today; others via the Agent Client Protocol) in parallel
under human review. It exists because individual harness CLIs are capable but have no
surrounding infrastructure: they collide on files and branches, hide what changed, cannot
repeat a multi-step process, and lose their place when interrupted.

Success, per `docs/product/01-vision-and-scope.md`: in one place, a user can create or import an
Issue, break it into Tasks on a board, run harnesses against those Tasks in parallel on their
chosen billing mode, review the proposed changes, and ship, repeatably, with no change landing
that a human did not approve. The primary success metric is the reviewed-and-accepted Task
completion rate.

## Positioning

The mechanism a neighbouring product could not truthfully copy, from the vision document:

- **Review gate on every run.** A run pauses at a human gate; the harness resumes from where
  it stopped, not from a cold prompt.
- **First-class subscription billing.** Harnesses run on a personal Claude plan, with a
  concurrency cap and a "Parked" state so parallel work never silently exhausts a quota, and
  a Subscription-mode harness can never be run in a way that causes metered billing.
- **Durable orchestration.** Queued events and in-flight runs are persisted; a run parked at
  the review gate survives a restart.
- **Own compute and data.** Everything runs on the user's machine: local SQLite, encrypted
  credentials at rest, no telemetry, no required external service. Install is a single
  `npx` command with nothing downloaded at start.
- **One codebase, local and hosted.** The same product is intended to run as a hosted
  multi-user service later, differing only in configuration.

## Operating Context

- **Install and run:** `npx @satcomx00-x00/solow` brings up the stack at `localhost:5000` and
  opens a browser. State lives under `~/.solow` (SQLite database, encryption keys, worktrees,
  cloned repos).
- **Three processes:** the web app (port 5000), an always-on orchestrator that supervises
  long-running harness processes and serves the WebSocket live channel (port 5001), and the
  Inngest workflow engine (port 8288).
- **Primary navigation flow:** Issues → Board (Tasks under an Issue) → Task Detail (review)
  → back to Board. Workflows are designed separately and attached to Tasks.
- **Current top-level areas** (from `apps/web/src/lib/navigation.ts`): Projects ("everything
  starts here"), Unassigned issues, Workflows (marked work-in-progress), Settings. Inside a
  project: Planning table, Board, Issues. Settings groups: Workspace, Connections
  (Integrations, Repositories, provider logins), Harnesses (Secrets, Harness profiles,
  Executor profiles), Extensions (MCP, API tokens), Interface (Status bar, Feature flags).
- **Review workspace:** the Task Detail page holds the live harness activity, a source-control
  panel, and the diff. A command palette (⌘K / Ctrl+K) is the one global shortcut.
- **External systems in the loop:** GitHub and GitLab (issues and projects are mirrored, never
  created there), the Claude Code CLI on the user's PATH, git worktrees on disk, and an MCP
  endpoint at `/api/mcp` so outside agents and scripts can drive SoloW.
- **Development:** `make dev` or `scripts/dev.sh` boots all three services with a synthetic
  local owner so sign-in is skipped; `apps/web` alone runs with `bun run dev` on port 5000.

## Capabilities and Constraints

Confirmed functionality (running code, per `docs/product/06-feature-comparison.md`):
issue create/list/search; a seven-column Kanban board with drag-and-drop and keyboard
sensors; guarded task state transitions; live board status over WebSocket; concurrent tasks in
isolated git worktrees; harness profiles (kind, auth mode, secret, concurrency cap); executor
profiles; sessions with ordered event replay; send input to and stop a running harness; retry a
failed task; the review-and-approve gate with commit onto a local branch; GitHub/GitLab
mirroring via their REST APIs; secrets encrypted at rest; a harness-catalog table seeded with
Claude Code.

Partial or specification-only (do not present as shipped): a true ACP client (the one runner
drives Claude Code's stream-json), the visual workflow designer and monitor, multi-repository
and multi-branch tasks, task dependencies, labels, public share links, analytics, notifications,
Docker/SSH/cloud executors beyond local, and any hosted multi-user features.

Durable product constraints (from `docs/architecture/02-constraints.md`):

- **C-1 Review-first.** No harness change is integrated without a recorded human approval.
- **C-2 Own compute and data.** Runs entirely on the user's machine; no telemetry.
- **C-3 Two deployment modes** from one codebase, differing only in configuration.
- **C-4 Billing integrity.** Subscription mode must never cause metered billing.
- **C-5 Credential isolation.** Harness-run code never sees raw credentials.
- **Quality priority order:** reliability, then security and privacy, then cost
  trustworthiness, then usability, portability, performance.
- **Usability bar (Q-Usability-1):** a user can tell the state of any Task or Run from the
  Board or Workflow monitor without reading raw logs.

Terminology is governed by `docs/glossary.md` and must be used exactly: Workspace,
Repository, Issue, Task, Board, Worktree, Executor, Executor Profile, Harness, Harness Profile,
Authentication Mode (Subscription / API Key), Session, Conversation, Workflow, Workflow Step,
Gate, Run, Diff, Review, Snapshot, Integration, Change Request (never "pull request" alone in
the domain), MCP Token. Task lifecycle states: Backlog, Ready, Running, Review, Parked, Done,
Failed. "Harness" is the product word for a coding-agent CLI; "agent" appears in older copy and
the CLI README.

Technical facts that bound UI work: Next.js 15 App Router used SPA-style (interactive surfaces
are client components; tRPC over a route handler, not Server Actions); Bun runtime; SQLite
via Drizzle; English only, `lang="en"` hardcoded, no i18n framework; auth is email and password
only, no OAuth; the sign-in page doubles as one-time Owner setup.

Explicitly undecided product facts:

- The hosted, multi-user deployment has no members, roles, or access model in code yet.
- Which harnesses beyond Claude Code ship first is not decided; the catalog is a table, not a
  promise.
- Pricing, licensing tiers, and any commercial cloud are out of scope and undefined.

## Brand Commitments

- **Name: "SoloW", expanded "Solo Workflow".** Binding (confirmed by the user, 2026-09-07).
  Title-cased exactly `SoloW` in UI and metadata; page titles follow `"<Page> · SoloW"`.
- **Not binding, present in code:** the gate mark in `apps/web/src/app/icon.svg` (dark rounded
  square, two posts, a lifted green bar) and its inline copies in the sign-in page and activity
  bar; the tagline "Orchestrate AI coding agents in parallel under human review." in
  `apps/web/src/app/layout.tsx`. The user declined to make either binding; later work may
  refine or replace them. The repository folder name "GateControl" is not a product name.
- **Voice, as evidenced by existing docs and UI copy:** plain, direct, second person, defined
  terms used consistently, no marketing superlatives. Nav descriptions are short declaratives
  ("Everything starts here", "Harness runs, by state"). The CLI README states limits and caveats
  openly (licensing of the bundled Inngest binary, key files to back up).
- **Licence:** Apache-2.0, open source, GitHub `Satcomx00-x00/SoloW`.

## Evidence on Hand

- Product and feature documentation under `docs/` (vision, personas and jobs, requirements,
  domain model, information architecture, 24 feature specs, arc42 architecture, 24 ADRs, a
  glossary). Feature comparison `docs/product/06-feature-comparison.md` records what is built
  versus specified, row by row.
- The CLI README `packages/cli/README.md` is the only user-facing prose about the product and
  is truthful about the current build.
- A working end-to-end core loop proven by an `@critical` Playwright test (`e2e/`).
- Logo: one 32x32 SVG mark (`apps/web/src/app/icon.svg`). No PNG, no wordmark, no `public/`
  directory, no other brand assets.
- **Absent, must not be fabricated:** testimonials, named customers, case studies, press,
  benchmarks, usage numbers, pricing, a comparison naming specific competitor products (docs
  deliberately say "comparable tools"), screenshots or demo recordings.

## Product Principles

1. **The human decision is the product.** Every surface makes the review gate obvious,
   reachable, and safe; automation accelerates work and never removes the approval.
2. **State at a glance, never from logs.** Task and Run state must be legible on the Board
   and monitor without reading raw output; the same lifecycle vocabulary appears everywhere.
3. **Honest about what is built.** Copy and surfaces reflect the current build; specification-
   only features are not implied as shipped.
4. **Cost and credentials are never surprising.** Billing mode, concurrency caps, and the
   Parked state are visible where they apply; nothing hints that secrets leave the machine.
5. **One local developer first.** Design for the single Owner on one machine; keep hosted
   multi-user as a future configuration, not a present affordance.

## Accessibility & Inclusion

**Required standard: WCAG 2.2 Level AA** for every surface (confirmed by the user,
2026-09-07). Existing practice to preserve: full keyboard operation including the board's
keyboard drag sensor and the ⌘K palette, `prefers-reduced-motion` respected, every task state
carried by an icon as well as a colour (WCAG 1.4.1), and aria-labelled navigation landmarks.
No automated accessibility test exists yet; component tests query by role and accessible name.
