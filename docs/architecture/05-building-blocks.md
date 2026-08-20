# 5. Building Block View

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section describes the major parts of GateControl and their responsibilities. It
corresponds to the **C4 Container and Component** levels, described in prose. It is
deliberately implementation-agnostic: it names responsibilities, not code.

## Level 1 — Containers (the major runnable parts)

- **Interactive Application** — What users see and use: Boards, Issues, the Workflow
  designer and monitor, the review workspace, Profiles, Integrations, Insights, and
  Settings. It reads and writes the shared state and streams live updates. It is delivered as
  a **SPA-style experience built with Next.js (App Router)** — the core interactive surfaces
  are client components, without reliance on server-side rendering or React Server Components
  (see [Decision 0010](../decisions/0010-spa-interactive-application.md),
  [Decision 0013](../decisions/0013-nextjs-web-framework.md)). It talks to the backend over
  **tRPC** for queries and mutations, served through Next.js Route Handlers with a generated
  `openapi.json` describing that HTTP API, and over a **WebSocket** channel for the live,
  bidirectional stream — agent activity and state changes outward, terminal input and steering
  inward (see [Decision 0011](../decisions/0011-frontend-backend-protocol.md)). The WebSocket
  channel and the Orchestration Component run in a **separate always-on service**, since
  serverless-style Next.js does not host long-lived connections or agent processes.

- **Orchestration Component** — A long-lived component that launches and supervises agents,
  provisions and cleans up working copies, applies billing-mode and credential rules, and
  streams agent activity back to the application. It is where the durable orchestration
  engine runs.

- **State Store** — The authoritative record of Workspaces, Issues, Tasks, Workflows, Runs,
  Sessions, Profiles, Integrations, and secrets. Chosen by deployment
  ([Decision 0008](../decisions/0008-data-store-strategy.md)).

- **Agent Connections** — The standard-protocol boundary to external agent tools
  ([Decision 0003](../decisions/0003-agent-connection-protocol.md)).

- **Execution Environments** — The local, container, remote, and cloud runtimes where agents
  actually run ([F07](../features/F07-execution-environments.md)).

### Container summary (textual C4 Container view)

> Interactive Application ↔ State Store
> Interactive Application ↔ (live updates) ↔ Orchestration Component
> Orchestration Component ↔ State Store
> Orchestration Component → Agent Connections → agents inside Execution Environments
> Orchestration Component → provisions Worktrees inside Execution Environments

## Level 2 — Components (responsibilities within the parts)

### Within the Interactive Application
- **Board & Issue management** — administering Tasks under Issues (F01, F02).
- **Workflow designer & monitor** — the visual node graph (F03).
- **Review workspace** — terminal, editor, diff, preview, conversation (F09, F10).
- **Configuration surfaces** — Profiles, Integrations, Settings (F05, F12, F16, F17).
- **Insights** — reporting (F14).
- **Contribution registries** — the seam that assembles the surfaces which are not fixed lists:
  the command palette, the status bar, and notification delivery ([F19](../features/F19-extension-contributions.md)).
  A feature module *registers* what it contributes — an id, a default priority, an optional
  visibility predicate, and whatever the surface renders or runs it with — and a surface renders
  whatever the registry resolved for the current context and the user's saved arrangement. The
  dependency runs one way: a feature never imports a surface, and a surface never imports a
  feature. That is what makes a plugin system a matter of supplying registrations at runtime
  rather than of editing every surface, and it is why a user's arrangement of a surface is a
  per-user preference in the State Store rather than browser state.

### Within the Orchestration Component
- **Task runner** — starts, supervises, and finishes Sessions for Tasks (F04, F11).
- **Workflow engine** — drives Runs step by step, handles Gates, ensures durability and
  resumption (F03, Decision 0004).
- **Worktree manager** — provisions and cleans up isolated working copies (F08).
- **Billing & credential guard** — enforces billing mode, concurrency caps, and credential
  isolation (F06, F17).
- **Integration connectors** — issue-tracker, source-host, and chat connectors (F12, F15).

## Responsibility boundaries

- The Interactive Application never launches or holds agent processes; it directs and
  observes them through the Orchestration Component.
- A feature module never reaches into a surface it does not own; it contributes to one, and a
  failing contribution costs its own slot rather than the surface (F19).
- The Orchestration Component never renders user interface; it does the durable, long-lived
  work and reports state.
- All parts read the same authoritative State Store, so the interface, orchestration, and
  reporting never disagree.
