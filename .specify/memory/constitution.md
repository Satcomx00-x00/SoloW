<!--
SYNC IMPACT REPORT
==================
Version change: (uninitialized template) → 1.0.0 → 1.1.0 → 1.2.0 → 1.3.0
Rationale: 1.0.0 was the first ratification of the GateControl constitution — all
template placeholders replaced with concrete, testable governance derived from the
product documentation in docs/ (arc42 architecture, feature specs F01–F18,
decision records 0001–0010). 1.1.0 (same-day MINOR amendment) adds the front↔back
communication-protocol constraint: tRPC over HTTP with a generated openapi.json plus a
bidirectional WebSocket realtime channel (Decision 0011). 1.2.0 (same-day MINOR
amendment) set the web-client build stack to a Vite + React SPA — SUPERSEDED. 1.3.0
(same-day MINOR amendment) sets the web framework to Next.js (App Router) delivering a
SPA-style client (core surfaces are client components; no reliance on SSR/RSC); tRPC +
openapi.json via Next.js Route Handlers, with the WebSocket channel and orchestration in
a separate always-on service (Decision 0013, superseding 0012).

Principles defined (7):
  I.   Review-First & Human-in-the-Loop (NON-NEGOTIABLE)
  II.  Safe Parallel Isolation
  III. Durable, Resumable Orchestration
  IV.  Credential Safety & Billing Integrity (NON-NEGOTIABLE)
  V.   Workspace-Scoped Multi-Tenancy
  VI.  Test-First Quality Discipline (NON-NEGOTIABLE)
  VII. One Product, Two Deployments; Own Your Data

Added sections:
  - Technology & Architecture Constraints (stack + patterns, tenant key, roles)
  - Development Workflow & Quality Gates
  - Governance

Removed sections: none (initial ratification).

Templates requiring updates:
  ✅ .specify/templates/spec-template.md — aligned; roles/tenant key now defined
     here (workspaceId; Owner/Member/Reviewer/Operator). No edit required — the
     template already defers to the constitution for its real role/tenant set.
  ✅ .specify/templates/tasks-template.md — aligned; tenant-isolation @critical
     gate and feature-flag discipline match Principles V and VI. No edit required.
  ⚠ .specify/templates/plan-template.md — RESOLVED BY DECISION (v1.2.0): the web
     client is a Vite + React SPA with no SSR and no React Server Components
     (Decision 0012), so the template's Server-Components-specific rows (page.tsx as
     an RSC, loading.tsx, server-side initial data) do not apply. /speckit-plan draws
     its Stack Reference from this constitution, so generated plans follow the SPA
     stack. The preset file itself is left unedited to avoid destabilizing it; its
     RSC rows are simply not used for this project.

Follow-up TODOs:
  - none outstanding (plan-template-spa resolved by Decision 0012 at v1.2.0).
-->

# GateControl Constitution

GateControl is an open-source, self-hostable control plane for orchestrating many AI
coding-agent CLIs in parallel under human review. This constitution defines the
non-negotiable principles and governance that every feature, plan, and change MUST honour.
It supersedes convenience and local preference. Where a principle and an expedient conflict,
the principle wins.

## Core Principles

### I. Review-First & Human-in-the-Loop (NON-NEGOTIABLE)

No agent-produced change is integrated without a recorded human approval. This applies
uniformly to Task Review, Workflow Gates, and agent tool-use approval.

- THE SYSTEM MUST require a recorded human decision before any agent change is merged or any
  gated tool action proceeds.
- Every review decision MUST be persisted with actor, timestamp, outcome, and any feedback,
  and MUST be reconstructable from that record.
- No code path may auto-integrate agent changes; a "skip review" mode is prohibited.

**Rationale**: The product's entire value proposition is trustworthy automation under human
control. Removing the human gate removes the reason the product exists.

### II. Safe Parallel Isolation

Parallelism is a structural guarantee, not a convention. Concurrent agent work MUST never
share mutable working state.

- Every Task MUST run in its own isolated Git working copy (Worktree) per Repository it
  touches.
- One Task's failure MUST NOT corrupt another Task's working copy or halt unrelated work.
- Isolation MUST hold identically across all Executor types (local, container, remote,
  cloud).

**Rationale**: Running many agents at once is the core capability; without hard isolation,
parallelism produces corruption instead of throughput.

### III. Durable, Resumable Orchestration

Long-running work survives interruption and resumes rather than restarts.

- In-flight Workflow Runs and Tasks MUST resume from their last completed step after an
  orchestrator restart, never restart from the beginning.
- Every significant state change to a Task, Session, or Run MUST be durably recorded.
- Human Gates MUST be modelled as first-class durable waits, not busy loops or timeouts that
  discard progress.

**Rationale**: Agent work is expensive in time and quota; losing progress to a restart is
both wasteful and untrustworthy.

### IV. Credential Safety & Billing Integrity (NON-NEGOTIABLE)

Secrets are protected absolutely, and billing mode is honoured exactly.

- All secrets (subscription tokens, API keys, integration credentials) MUST be stored
  encrypted at rest and MUST NOT be displayed after entry.
- Agent-run code MUST NOT have access to any raw credential, in any Executor type.
- A Subscription-mode agent MUST NOT be run in a way that causes metered API billing; any
  conflicting credential MUST be removed from that agent's run environment.
- When a subscription quota is exhausted, work MUST move to a Parked state that preserves it;
  it MUST NOT fail, and MUST NOT silently switch to metered billing.
- No log, notification, report, or export may contain a secret in readable form.

**Rationale**: The product handles users' money and credentials directly; a single breach of
this boundary destroys trust irrecoverably.

### V. Workspace-Scoped Multi-Tenancy

The Workspace is the boundary of ownership, tenancy, and access. The tenant key is
`workspaceId`.

- Every persisted domain entity MUST carry a non-nullable `workspaceId` and MUST be filtered
  by it in every read.
- Access control MUST be enforced on every server action, not only in the interface, and a
  user MUST only see and act on Workspaces they are granted.
- Local single-user deployment is a single-Workspace case of the same model; the
  `workspaceId` scoping MUST NOT be waived for local mode.
- Cross-Workspace isolation MUST be verified by a mandatory `@critical` test before any PR is
  opened.

**Rationale**: One product must serve both a solo local user and a hosted team safely;
uniform Workspace scoping is what makes local and hosted the same code without leaking data.

### VI. Test-First Quality Discipline (NON-NEGOTIABLE)

Correctness is established by tests written before implementation.

- Acceptance criteria and functional requirements MUST be expressed in EARS syntax and be
  binary-verifiable.
- Tests MUST be written and MUST fail before the implementation that satisfies them is
  written (Red-Green-Refactor).
- The `@critical` Workspace-isolation E2E test MUST pass before a PR is opened; a failing
  `@critical` test blocks merge with no exception.
- Validation contracts MUST be typed and explicit; business logic MUST be pure and return a
  `Result` type rather than throwing on business errors; database migrations MUST be
  generated, never hand-written unless this constitution explicitly permits it.

**Rationale**: An orchestration platform that ships regressions cannot be trusted to run
unattended agents; test-first discipline is the floor, not a preference.

### VII. One Product, Two Deployments; Own Your Data

The same product runs locally for one user and hosted for a team, and users own their compute
and data.

- Every feature MUST behave identically in local and hosted deployment, differing only in
  configuration; only inherently multi-user capabilities (members, access control) may be
  hosted-only.
- The product MUST function with no required external service and MUST send no telemetry by
  default.
- The same conceptual data model MUST back both an embedded local store and a shared hosted
  store; two divergent models are prohibited.
- Source-host, tracker, and chat Integrations MUST be optional and MUST degrade gracefully
  when unavailable; no core capability may depend on one.

**Rationale**: Vendor lock-in and forced-cloud dependence are exactly what the product exists
to avoid; portability and data ownership are load-bearing promises.

## Technology & Architecture Constraints

The following stack and patterns are the project's committed baseline. Plans MUST draw their
Stack Reference from here and MUST NOT introduce a technology the project does not use without
an accepted decision record.

- **Language & web**: TypeScript (strict). **Next.js (App Router)** is the web framework,
  delivering an authenticated **SPA-style** experience: the core interactive surfaces are
  **client components** and the product does not rely on server-side rendering or React Server
  Components for those screens (Decisions 0010, 0013).
- **Backend shape**: tRPC queries/mutations and the `openapi.json` export are served through
  **Next.js Route Handlers**; the **WebSocket** realtime channel and the **long-lived
  orchestration component** run in a **separate always-on service**, preserving the
  application/orchestrator split (Decisions 0002, 0011, 0013).
- **Data**: A single data model via Drizzle ORM, backed by **SQLite** locally and
  **PostgreSQL** hosted (Decision 0008). Migrations are generated, reviewed line-by-line, and
  applied cleanly before merge.
- **Validation**: Zod schemas for all input/output contracts; no untyped escape hatches in
  contracts.
- **API surface**: **tRPC over HTTP** for queries and mutations (type-safe client, Zod
  contracts reused), with a generated **`openapi.json`** describing the HTTP API exported from
  the tRPC routers and published as a committed build artifact (Decision 0011).
- **Auth & tenancy**: BetterAuth for authentication; the tenant key is `workspaceId`; roles
  are **Owner**, **Member**, **Reviewer**, and (platform) **Operator**.
- **Durable orchestration**: Inngest with AgentKit for durable, resumable Workflows and
  human-in-the-loop gates (Decision 0004).
- **Agent connection**: The Agent Client Protocol (ACP) is the single boundary to agent CLIs;
  adding an agent is configuration, not engineering (Decision 0003).
- **Source integrations**: GitHub via the `gh` CLI and GitLab via the `glab` CLI, for auth,
  Issue sync, and pull/merge request creation (Decision 0009).
- **Realtime**: A **WebSocket** channel streams live agent activity and state changes to the
  SPA with low latency and carries client input back (terminal I/O, steering). The realtime
  channel is bidirectional and is not covered by `openapi.json` (Decision 0011).
- **Feature flags**: Every user-facing feature ships behind a flag named `ff-[feature-name]`,
  default OFF, with a kill switch.
- **Secrets**: Accessed only through a validated environment module; never via bare
  environment access; secret scanning runs in CI.
- **Documentation**: Docs-as-Code. Architecture follows arc42 + C4; significant choices are
  recorded as ADRs. Product and feature behaviour live in `docs/`.

## Development Workflow & Quality Gates

- **Specify before building**: Each feature has a specification (EARS acceptance criteria,
  non-goals, edge cases, Workspace/RBAC scoping, success metrics) and an implementation plan
  whose Stack Reference and Service Interaction Map are complete. An RFC PR MUST be merged
  before the implementation PR is opened.
- **Decision records**: Any choice with meaningful trade-offs MUST be captured as an ADR in
  `docs/decisions/` (one decision per record) and linked from the affected feature.
- **Review verifies compliance**: Code review MUST confirm adherence to every applicable
  principle — isolation, review gates, credential safety, Workspace scoping, and test-first
  discipline — not only code style.
- **Quality gates (all MUST exit 0 before merge)**: lint, typecheck, generated-migration
  review, unit and integration tests, E2E happy path, the `@critical` Workspace-isolation
  test, secret scan, and dependency audit at the project's severity threshold.
- **Documentation moves with the code**: A change to product behaviour and its documentation
  in `docs/` belong in the same change set.
- **Complexity is justified or rejected**: A deviation from these constraints MUST be recorded
  with its reason and the simpler alternative that was rejected, or it MUST NOT ship.

## Governance

This constitution supersedes all other practices. When any plan, spec, task list, or review
conflicts with it, the constitution governs and the conflicting artifact MUST be corrected.

- **Amendment procedure**: Amendments are proposed as a change to this file with a written
  rationale, reviewed and approved through the same process as code, and accompanied by the
  propagation of any consequent changes to dependent templates and documentation.
- **Versioning policy** (semantic versioning of this document):
  - **MAJOR**: a backward-incompatible governance change — removing or redefining a principle.
  - **MINOR**: a new principle or section, or materially expanded guidance.
  - **PATCH**: clarifications, wording, and non-semantic refinements.
- **Compliance review**: Every PR and review MUST verify compliance with the applicable
  principles. The four NON-NEGOTIABLE guarantees (Principles I, IV, and VI, and the isolation
  test of Principle V) are release-blocking.
- **Review cadence**: This constitution and each significant decision record are revisited
  roughly one month after acceptance to compare expected against actual consequences, and
  amended if reality diverges.
- **Runtime guidance**: Day-to-day product and feature guidance lives in `docs/`
  (see `docs/README.md`); architecture guidance follows the arc42 sections in
  `docs/architecture/`.

**Version**: 1.3.0 | **Ratified**: 2026-08-17 | **Last Amended**: 2026-08-17
