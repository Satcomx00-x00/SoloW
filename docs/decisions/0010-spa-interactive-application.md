# 0010 — Deliver the Interactive Application as a Single Page Application (SPA)

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Architecture, Design

## Context

The Interactive Application is highly interactive, stateful, and real-time. Its central
surfaces are a drag-and-drop Kanban Board ([F02](../features/F02-kanban-task-administration.md)),
an interactive node-graph Workflow canvas ([F03](../features/F03-workflow-designer.md),
[Decision 0007](./0007-reactflow-workflow-visualisation.md)), and a live review workspace with
streaming terminals and diffs ([F09](../features/F09-integrated-workspace.md)). These favour a
rich client that loads once and updates continuously, rather than full-page navigation. The
application also maintains live connections to the long-lived orchestrator
([Decision 0002](./0002-technology-stack.md)) to stream agent activity and state changes.

## Decision

Deliver the Interactive Application as a **Single Page Application (SPA)**: a client-rendered
application loaded once, which then navigates and updates on the client and communicates with
the backend through an API and live update channels. This refines how the "application" part
of [Decision 0002](./0002-technology-stack.md) is delivered.

## Considered options

- **Single Page Application (chosen)** — one initial load, then fluid client-side navigation
  and continuous live updates; the best fit for drag-and-drop boards, an interactive graph
  canvas, and streaming review surfaces.
- **Server-rendered multi-page application** — Rejected: full-page navigation and
  request/response rendering fight the highly interactive, real-time nature of the core
  surfaces.
- **Hybrid server-side rendering** — Rejected as unnecessary: the product is an authenticated
  tool, so first-load indexing and public-page rendering are not concerns that would justify
  the added complexity.

## Consequences

- Positive: rich, fluid, real-time interactions — the board, the Workflow canvas, and live
  streams — behave naturally; navigation is instant after the first load.
- Positive: a clean separation between the SPA client and the backend API and live channels,
  consistent with the application/orchestrator split in
  [Decision 0002](./0002-technology-stack.md).
- Negative: the backend must expose a well-defined API and live update channels for the SPA
  to consume; initial application load must be kept acceptable.
- Neutral: because the product is an authenticated tool, search indexing and public-page
  performance are not relevant trade-offs.
- Affects the [building block view](../architecture/05-building-blocks.md); does not change any
  feature's behaviour.
