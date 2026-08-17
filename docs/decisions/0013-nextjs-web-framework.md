# 0013 — Use Next.js (App Router) as the web framework, delivering a SPA-style client

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Architecture
**Supersedes:** [Decision 0012](./0012-spa-build-stack.md)

## Context

[Decision 0010](./0010-spa-interactive-application.md) chose a Single Page Application, and
[Decision 0012](./0012-spa-build-stack.md) proposed building it with Vite + React on a
standalone backend. The team has instead decided to use **Next.js** as the web framework, for
its routing, tooling, ecosystem, and deployment story. The application remains **SPA-style**:
the core interactive surfaces — the Kanban board, the node-graph Workflow canvas, and the
streaming review workspace — stay client-rendered, and the front↔back protocols from
[Decision 0011](./0011-frontend-backend-protocol.md) (tRPC, `openapi.json`, WebSocket) are
unchanged.

## Decision

Use **Next.js (App Router)** as the web framework, delivering an authenticated **SPA-style**
experience:

- The core interactive surfaces are **client components**; the product does not rely on
  server-side rendering or React Server Components for those screens (consistent with
  [Decision 0010](./0010-spa-interactive-application.md)).
- **tRPC** queries/mutations and the generated **`openapi.json`** are served through Next.js
  Route Handlers ([Decision 0011](./0011-frontend-backend-protocol.md)).
- The **WebSocket** realtime channel and the long-lived agent orchestration run in a
  **separate always-on service**, since serverless-style Next.js does not host long-lived
  connections or agent processes well — preserving the application/orchestrator split of
  [Decision 0002](./0002-technology-stack.md).

This supersedes [Decision 0012](./0012-spa-build-stack.md); GateControl uses Next.js, not
Vite.

## Considered options

- **Next.js (App Router), SPA-style (chosen)** — the team's preferred framework, with routing,
  tooling, and deployment built in; interactive surfaces remain client components.
- **Vite + React standalone SPA** ([Decision 0012](./0012-spa-build-stack.md), superseded) — a
  clean pure-SPA split, but the team prefers Next.js's framework and ecosystem.
- **Next.js with full RSC/SSR** — Not adopted now: the core screens are inherently
  interactive client components, so the app is delivered SPA-style; RSC/SSR remain available
  for non-interactive shells if ever wanted, recorded here as a future option rather than a
  current choice.

## Consequences

- Positive: gains Next.js's routing, tooling, and deployment; keeps the SPA-style interactive
  experience and the tRPC/`openapi.json`/WebSocket protocols unchanged.
- Positive: RSC/SSR are available later for any non-interactive shell without another
  framework change.
- Neutral: tRPC and the OpenAPI export run inside Next.js Route Handlers; the WebSocket
  channel and orchestrator stay in a separate always-on service (the app/orchestrator split of
  [Decision 0002](./0002-technology-stack.md) is unchanged).
- The speckit plan template's Next.js-shaped rows apply again, with the caveat that the core
  interactive pages are client components rather than server components.
- Keeps [Decision 0010](./0010-spa-interactive-application.md) (SPA) and
  [Decision 0011](./0011-frontend-backend-protocol.md) (protocols).
