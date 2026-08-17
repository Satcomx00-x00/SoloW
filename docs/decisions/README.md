# Decision Log (ADRs)

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This log records the significant decisions behind GateControl as Architecture Decision
Records (ADRs). Each ADR captures one decision, its context, the options considered, and the
consequences — following the widely used
[Nygard / MADR](https://adr.github.io) conventions.

Rules for this log ([per our conventions](../CONVENTIONS.md)):

- One decision per record; records are numbered sequentially and are immutable once
  accepted.
- A superseded decision is marked with its replacement, never deleted.
- Each record is reviewed roughly one month after acceptance to compare expected against
  actual consequences.

## Index

| # | Decision | Status |
|---|----------|--------|
| [0001](./0001-scope-near-clone-of-kandev.md) | Build a near-clone of kandev | Accepted |
| [0002](./0002-technology-stack.md) | Application + long-lived orchestrator, local-first with a path to hosted | Accepted |
| [0003](./0003-agent-connection-protocol.md) | Integrate agents via the Agent Client Protocol (ACP) | Accepted |
| [0004](./0004-durable-orchestration-engine.md) | Use a durable orchestration engine for Workflows and Tasks | Accepted |
| [0005](./0005-subscription-authentication.md) | Support Claude subscription billing via a portable token | Accepted |
| [0006](./0006-kanban-scoped-to-issues.md) | Administer Tasks on a Kanban board scoped under Issues | Accepted |
| [0007](./0007-reactflow-workflow-visualisation.md) | Visualise Workflows as an interactive node graph (ReactFlow) | Accepted |
| [0008](./0008-data-store-strategy.md) | One data model, two stores (embedded local, shared hosted) | Accepted |
| [0009](./0009-cli-based-source-integrations.md) | Drive source-host integrations through official CLIs (gh, glab) | Accepted |
| [0010](./0010-spa-interactive-application.md) | Deliver the Interactive Application as a Single Page Application (SPA) | Accepted |
| [0011](./0011-frontend-backend-protocol.md) | Front↔back protocol: tRPC (with OpenAPI export) plus WebSocket | Accepted |
| [0012](./0012-spa-build-stack.md) | Build the SPA with Vite + React; standalone API/orchestrator backend | Superseded by 0013 |
| [0013](./0013-nextjs-web-framework.md) | Use Next.js (App Router) as the web framework, delivering a SPA-style client | Accepted |
