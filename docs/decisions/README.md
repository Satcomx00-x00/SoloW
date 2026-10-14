# Decision Log (ADRs)

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-10-09

This log records the significant decisions behind SoloW as Architecture Decision
Records (ADRs). Each ADR captures one decision, its context, the options considered, and the
consequences — following the widely used
[Nygard / MADR](https://adr.github.io) conventions.

Rules for this log ([per our conventions](../CONVENTIONS.md)):

- One decision per record; records are numbered sequentially and are immutable once
  accepted.
- A superseded decision is marked with its replacement, never deleted.
- Each record is reviewed roughly one month after acceptance to compare expected against
  actual consequences. The review is appended to the record as a dated "Review" section, and
  the index below shows when each was last reviewed, or when its first review falls due.

## Index

| # | Decision | Status | Reviewed |
|---|----------|--------|----------|
| [0001](./0001-scope-near-clone.md) | Build a near-clone rather than a narrower product | Superseded by 0031 for the 1.0 scope | 2026-10-09 |
| [0002](./0002-technology-stack.md) | Application + long-lived orchestrator, local-first with a path to hosted | Accepted | 2026-10-09 |
| [0003](./0003-agent-connection-protocol.md) | Integrate harnesses via the Agent Client Protocol (ACP) | Accepted | 2026-10-09 |
| [0004](./0004-durable-orchestration-engine.md) | Use a durable orchestration engine for Workflows and Tasks | Accepted | 2026-10-09 |
| [0005](./0005-subscription-authentication.md) | Support Claude subscription billing via a portable token | Accepted | 2026-10-09 |
| [0006](./0006-kanban-scoped-to-issues.md) | Administer Tasks on a Kanban board scoped under Issues | Accepted | 2026-10-09 |
| [0007](./0007-reactflow-workflow-visualisation.md) | Visualise Workflows as an interactive node graph (ReactFlow) | Accepted | 2026-10-09 |
| [0008](./0008-data-store-strategy.md) | One data model, two stores (embedded local, shared hosted) | Accepted | 2026-10-09 |
| [0009](./0009-cli-based-source-integrations.md) | Drive source-host integrations through official CLIs (gh, glab) | Superseded by 0014 (GitHub/GitLab) | 2026-10-09 |
| [0010](./0010-spa-interactive-application.md) | Deliver the Interactive Application as a Single Page Application (SPA) | Accepted | 2026-10-09 |
| [0011](./0011-frontend-backend-protocol.md) | Front↔back protocol: tRPC (with OpenAPI export) plus WebSocket | Accepted | 2026-10-09 |
| [0012](./0012-spa-build-stack.md) | Build the SPA with Vite + React; standalone API/orchestrator backend | Superseded by 0013 | 2026-10-09 |
| [0013](./0013-nextjs-web-framework.md) | Use Next.js (App Router) as the web framework, delivering a SPA-style client | Accepted | 2026-10-09 |
| [0014](./0014-direct-api-source-integrations.md) | Drive GitHub/GitLab integrations through their REST APIs directly, not gh/glab | Accepted | 2026-10-09 |
| [0015](./0015-markdown-rendering-of-agent-output.md) | Render harness output as Markdown with react-markdown (no raw HTML) | Accepted | 2026-10-09 |
| [0016](./0016-integration-provider-registry.md) | Register integration providers by capability, rather than enumerating them | Accepted | 2026-10-09 |
| [0017](./0017-worktree-git-rpc.md) | Reach a Task's worktree through a synchronous RPC on the orchestrator | Accepted; not built, the route was never wired (review of 2026-10-09) | 2026-10-09 |
| [0018](./0018-provider-owned-project-fields.md) | Mirror the provider's own planning fields, rather than owning a project model | Accepted | 2026-10-09 |
| [0019](./0019-editing-an-issue-where-it-lives.md) | Edit an imported Issue on the provider that owns it, never on the copy | Accepted | 2026-10-09 |
| [0020](./0020-provider-revalidation-not-expiry.md) | Cache provider reads by revalidation, never by expiry | Accepted | 2026-10-09 |
| [0021](./0021-commits-decide-the-version.md) | The commits decide the version, not the pull request | Accepted | 2026-10-09 |
| [0022](./0022-relicense-to-apache-2.md) | Relicense from AGPL-3.0-only to Apache-2.0 | Accepted | 2026-10-09 |
| [0023](./0023-docker-executor-cli.md) | Drive the container Executor through the `docker` CLI, one session container per Task | Accepted, amended 2026-09-03 | 2026-10-09 |
| [0024](./0024-agent-libraries-loading.md) | One library, three hand-overs: how each harness runtime is given MCP servers and Skills | Accepted | 2026-10-09 |
| [0025](./0025-history-retention.md) | Closed and deleted Tasks stay resumable for seven days | Accepted, amended by 0032 | due 2026-10-11 |
| [0026](./0026-checkpoints-through-harness-hooks.md) | Workflow checkpoints are enforced through the harness's own hooks, relayed over the filesystem | Accepted | due 2026-10-12 |
| [0027](./0027-hermetic-harness-configuration.md) | A Task's harness runs against a blank, app-owned configuration | Accepted | due 2026-10-24 |
| [0028](./0028-harness-configs-in-the-app.md) | Harness configuration is stored in the app and handed over at launch | Accepted | due 2026-11-02 |
| [0029](./0029-one-sidebar-navigation.md) | One labelled sidebar replaces the activity rail and the navigator | Accepted | due 2026-11-05 |
| [0030](./0030-review-gate-is-a-database-state.md) | A review gate is a database state, and a decision starts the next run | Accepted | due 2026-11-08 |
| [0031](./0031-focus-on-the-solo-power-user.md) | Focus on the solo power user | Accepted | due 2026-11-08 |
| [0032](./0032-transcript-retention.md) | A finished Task keeps its transcript for a window the Workspace chooses | Accepted | due 2026-11-08 |
