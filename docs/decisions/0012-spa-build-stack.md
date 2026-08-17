# 0012 — Build the web client as a Vite + React SPA with a standalone API/orchestrator backend

**Status:** Superseded by [Decision 0013](./0013-nextjs-web-framework.md) · **Date:** 2026-08-17 · **Deciders:** Product, Architecture

> **Superseded:** The team subsequently chose **Next.js** as the web framework
> ([Decision 0013](./0013-nextjs-web-framework.md)). The application remains SPA-style, but it
> is built with Next.js, not Vite. This record is retained for history; its analysis of why a
> Single Page Application (not SSR/RSC) suits the product still stands and informs 0013.

## Context

Two prior decisions fix the shape of the front end: the Interactive Application is a Single
Page Application ([Decision 0010](./0010-spa-interactive-application.md)), and it talks to the
backend over tRPC plus a WebSocket channel with a generated `openapi.json`
([Decision 0011](./0011-frontend-backend-protocol.md)). The backend is a separate, long-lived
orchestration component ([Decision 0002](./0002-technology-stack.md)). What remained open was
*how* to build the SPA, since the earlier stack framing named Next.js, whose App Router is
server-rendering-first (SSR and React Server Components).

For a real-time, authenticated control plane, the core screens — the Kanban board, the
node-graph Workflow canvas, and the streaming review workspace — are inherently interactive
client components. In a Server-Components model those would all be client components anyway,
so the model's benefits (server-side data fetching, less client JavaScript, fast content
paint, SEO) do not apply, while its costs do: server/client boundary complexity, an unused
server-render runtime, and a second data path (server components fetching directly) that
conflicts with the single tRPC API surface chosen in Decision 0011.

## Decision

Build the web client as a dedicated **Vite + React Single Page Application** — client-rendered,
with **no server-side rendering and no React Server Components** — served as static assets.
The backend is a **standalone Node/TypeScript service** exposing the tRPC API, the generated
`openapi.json`, and the WebSocket channel, running alongside the long-lived orchestration
component. This supersedes the earlier "Next.js full-stack" framing of the stack; GateControl
does not use Next.js.

## Considered options

- **Vite + React SPA + standalone API/orchestrator (chosen)** — a clean separation: a static
  SPA, one typed API surface (tRPC + `openapi.json` + WebSocket), and the orchestrator; a
  single data path; no unused server-render machinery.
- **Next.js App Router used SPA-style** — Rejected: works, but fights the framework's
  Server-Components-first grain for little benefit and keeps SSR/RSC machinery the product
  does not use.
- **Next.js with SSR / RSC** — Rejected: SSR adds per-request rendering a real-time
  authenticated tool gains nothing from; RSC's server data-fetching bypasses the tRPC API and
  creates two data paths, and its screens would be client components regardless.

## Consequences

- Positive: the simplest mental model for this product — one client app, one typed API, one
  orchestrator; a single data path through tRPC and WebSocket; the client is statically
  hostable and the backend scales independently.
- Negative: loses Next.js conveniences (built-in routing and rendering), replaced by a
  client-side router and the standalone API service.
- Resolves the plan-template follow-up recorded with the constitution: the plan template's
  Server-Components-specific rows do not apply to this project, and plans follow the SPA stack
  from the constitution instead.
- Refines the "application" part of [Decision 0002](./0002-technology-stack.md); realises
  [Decision 0010](./0010-spa-interactive-application.md) and
  [Decision 0011](./0011-frontend-backend-protocol.md).
