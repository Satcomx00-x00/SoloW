# Decision Log (ADRs)

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This log records the significant decisions behind SoloW as Architecture Decision
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
| [0001](./0001-scope-near-clone.md) | Build a near-clone rather than a narrower product | Accepted |
| [0002](./0002-technology-stack.md) | Application + long-lived orchestrator, local-first with a path to hosted | Accepted |
| [0003](./0003-agent-connection-protocol.md) | Integrate agents via the Agent Client Protocol (ACP) | Accepted |
| [0004](./0004-durable-orchestration-engine.md) | Use a durable orchestration engine for Workflows and Tasks | Accepted |
| [0005](./0005-subscription-authentication.md) | Support Claude subscription billing via a portable token | Accepted |
| [0006](./0006-kanban-scoped-to-issues.md) | Administer Tasks on a Kanban board scoped under Issues | Accepted |
| [0007](./0007-reactflow-workflow-visualisation.md) | Visualise Workflows as an interactive node graph (ReactFlow) | Accepted |
| [0008](./0008-data-store-strategy.md) | One data model, two stores (embedded local, shared hosted) | Accepted |
| [0009](./0009-cli-based-source-integrations.md) | Drive source-host integrations through official CLIs (gh, glab) | Superseded by 0014 (GitHub/GitLab) |
| [0010](./0010-spa-interactive-application.md) | Deliver the Interactive Application as a Single Page Application (SPA) | Accepted |
| [0011](./0011-frontend-backend-protocol.md) | Front↔back protocol: tRPC (with OpenAPI export) plus WebSocket | Accepted |
| [0012](./0012-spa-build-stack.md) | Build the SPA with Vite + React; standalone API/orchestrator backend | Superseded by 0013 |
| [0013](./0013-nextjs-web-framework.md) | Use Next.js (App Router) as the web framework, delivering a SPA-style client | Accepted |
| [0014](./0014-direct-api-source-integrations.md) | Drive GitHub/GitLab integrations through their REST APIs directly, not gh/glab | Accepted |
| [0015](./0015-markdown-rendering-of-agent-output.md) | Render agent output as Markdown with react-markdown (no raw HTML) | Accepted |
| [0016](./0016-integration-provider-registry.md) | Register integration providers by capability, rather than enumerating them | Accepted |
| [0017](./0017-worktree-git-rpc.md) | Reach a Task's worktree through a synchronous RPC on the orchestrator | Accepted |
| [0018](./0018-provider-owned-project-fields.md) | Mirror the provider's own planning fields, rather than owning a project model | Accepted |
| [0019](./0019-editing-an-issue-where-it-lives.md) | Edit an imported Issue on the provider that owns it, never on the copy | Accepted |
| [0020](./0020-provider-revalidation-not-expiry.md) | Cache provider reads by revalidation, never by expiry | Accepted |
