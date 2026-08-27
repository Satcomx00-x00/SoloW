<!--
SYNC IMPACT REPORT
==================
Version change: 1.3.0 → 1.4.0 (MINOR)
Rationale: three decision records accepted after v1.3.0 (0014, 0015, 0016) changed
committed architecture without being reflected here, and one of them made a standing
constraint factually wrong. 0014 supersedes 0009 for GitHub and GitLab: integrations are
direct REST API clients authenticated by an encrypted Secret, not `gh`/`glab` shell-outs.
0016 extends that into a capability registry — providers register and declare what they
can do, rather than being enumerated in a closed union. 0015 adds a default-deny rendering
constraint for agent output, which is untrusted input in an authenticated session. The
amendment also records the runtime and lint toolchain (Bun, Biome), names the external MCP
server as a third API surface, and replaces the approximate quality-gate list with the
`make verify` chain the repository actually enforces. MINOR: new guidance and constraints,
no principle removed or redefined.

Version history: (uninitialized template) → 1.0.0 first ratification, principles derived
from docs/ (arc42, F01–F18, decisions 0001–0010) → 1.1.0 front↔back protocol: tRPC over
HTTP + generated openapi.json + bidirectional WebSocket (0011) → 1.2.0 Vite + React SPA
build stack (0012) — SUPERSEDED → 1.3.0 Next.js App Router delivering a SPA-style client,
tRPC/openapi via Route Handlers, WebSocket and orchestration in a separate always-on
service (0013, superseding 0012) → 1.4.0 (this amendment).

Principles defined (7) — unchanged by this amendment:
  I.   Review-First & Human-in-the-Loop (NON-NEGOTIABLE)
  II.  Safe Parallel Isolation
  III. Durable, Resumable Orchestration
  IV.  Credential Safety & Billing Integrity (NON-NEGOTIABLE)
  V.   Workspace-Scoped Multi-Tenancy
  VI.  Test-First Quality Discipline (NON-NEGOTIABLE)
  VII. One Product, Two Deployments; Own Your Data

Modified sections (v1.4.0):
  - Technology & Architecture Constraints
      · Source integrations — REWRITTEN. `gh`/`glab` shell-out replaced by direct REST
        clients authenticated by an encrypted Secret (0014, superseding 0009 for GitHub
        and GitLab only; 0009's CLI pattern still governs agents).
      · API surface — the external MCP server named as a third surface (F12).
      · Runtime & tooling — ADDED (Bun, Biome).
      · Extension contributions — ADDED (F19, 0016): capability registration, and the
        forward-compatibility rule for persisted provider identifiers.
      · Untrusted agent output — ADDED (0015): fail safe by default, not by configuration.
  - Development Workflow & Quality Gates
      · Quality gates — REWRITTEN to the enforced `make verify` chain, adding the
        openapi.json staleness check and the Executor-boundary audit, and separating
        `make e2e-critical` as the merge blocker.

Added sections: none (no new principle or top-level section).
Removed sections: none.

Templates requiring updates:
  ✅ .specify/templates/spec-template.md — aligned; defers to this constitution for the
     role set and tenant key (workspaceId; Owner/Member/Reviewer/Operator).
  ⚠ .specify/templates/plan-template.md — PENDING. Lines 58-59 and 185 assume React
     Server Components (`page.tsx` as an RSC, `loading.tsx`, guards on RSC pages), which
     Decisions 0010 and 0013 do not apply to this project: core surfaces are client
     components and nothing relies on SSR/RSC. /speckit-plan draws its Stack Reference
     from this constitution, so generated plans follow the SPA stack regardless; the
     preset rows are simply unused. Left unedited, as at v1.2.0, to avoid destabilizing
     the preset.
  ⚠ .specify/templates/tasks-template.md — PENDING, same conflict, newly identified:
     lines 45, 168, 170-171 and 244 categorize an RSC page task and a `loading.tsx`
     skeleton. Otherwise aligned — its tenant-isolation @critical gate and feature-flag
     discipline match Principles V and VI.
  ⚠ .specify/templates/agent-context.md — PENDING, newly identified and the most
     load-bearing of the three, because it is fed to agents as working context: lines 16,
     28-29, 31 and 97 instruct "default to Server Components", co-located Server Component
     fetches, `loading.tsx`/`error.tsx` per segment, and HTML streaming.
  n/a .specify/templates/commands/ — no such directory in this project.

Runtime guidance checked: README.md, docs/README.md, docs/architecture/*.md and CLAUDE.md
carry no stale `gh`/`glab` integration references; docs/decisions/0009 is correctly marked
superseded by 0014.

Follow-up TODOs:
  - TODO(RSC_TEMPLATE_ALIGNMENT): decide whether to edit the three preset templates above
    or to record the divergence as an accepted deviation. Three amendments have now
    deferred it.
  - TODO(MCP_DECISION_RECORD): the external MCP server is built and constrained here, but
    has no decision record of its own — only feature spec F12. Record one, or state in
    F12 that no ADR is owed.
-->

# SoloW Constitution

SoloW is an open-source, self-hostable control plane for orchestrating many AI
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
- **Runtime & tooling**: **Bun** is the runtime, package manager, and test runner, and
  **Biome** is the single linter and formatter. A second toolchain for either role MUST NOT be
  introduced without an accepted decision record.
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
  the tRPC routers and published as a committed build artifact (Decision 0011). An external
  **MCP server** exposes the same procedures to agents and third-party clients as a third
  surface, authenticated by hashed, revocable, Workspace-scoped tokens (F12); it MUST adapt the
  existing procedures and Zod contracts rather than re-implement domain logic.
- **Auth & tenancy**: BetterAuth for authentication; the tenant key is `workspaceId`; roles
  are **Owner**, **Member**, **Reviewer**, and (platform) **Operator**.
- **Durable orchestration**: Inngest with AgentKit for durable, resumable Workflows and
  human-in-the-loop gates (Decision 0004).
- **Agent connection**: The Agent Client Protocol (ACP) is the single boundary to agent CLIs;
  adding an agent is configuration, not engineering (Decision 0003).
- **Source integrations**: Source hosts and trackers are driven through their **REST APIs
  directly**, authenticated by a Personal Access Token held as an encrypted `Secret` and
  decrypted only inside the request that needs it — never by shelling out to a vendor CLI, and
  never by inheriting a host-local CLI login that the product's own credential model cannot
  express (Decision 0014, superseding 0009 for GitHub and GitLab). Decision 0009's
  "drive the official CLI" pattern remains correct where its reasoning still holds — most
  notably agents, whose CLI *is* the integrated product.
- **Extension contributions**: Commands, status items, notification channels, and integration
  providers are **registered contributions that declare their capabilities**, not entries in a
  closed union (F19, Decision 0016). The domain MUST ask for a capability, never for a named
  provider, and adding a provider MUST be registration rather than an edit spread across the
  codebase. Because provider identifiers are persisted, a stored value the running build does
  not recognise MUST degrade to an unfamiliar-but-rendered label, never to a surface that
  refuses to parse.
- **Realtime**: A **WebSocket** channel streams live agent activity and state changes to the
  SPA with low latency and carries client input back (terminal I/O, steering). The realtime
  channel is bidirectional and is not covered by `openapi.json` (Decision 0011).
- **Untrusted agent output**: Agent output is untrusted input rendered inside an authenticated
  operator session. Whatever renders it MUST fail safe **by default rather than by
  configuration**: raw HTML escaped, link schemes other than `http(s)` rendered as plain text,
  no remote images, and no `dangerouslySetInnerHTML` (Decision 0015). These guarantees are
  load-bearing for the review gate and MUST be covered by tests, never assumed.
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
- **Quality gates (all MUST exit 0 before merge)**: `make verify` — lint, typecheck, unit
  tests, the smoke test, the `openapi.json` staleness check, the dependency audit at the
  project's severity threshold, the Executor-boundary audit (no direct host access outside the
  local Executor, enforcing Principle II), the secret scan, and the E2E suite, in that order.
  `make e2e-critical` — the `@critical` Workspace-isolation test — blocks merge with no
  exception (Principle V). Migrations are generated and reviewed line-by-line as part of
  `make build`; they are never hand-written.
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

**Version**: 1.4.0 | **Ratified**: 2026-08-17 | **Last Amended**: 2026-08-24
