# 0011 — Front↔back communication: tRPC (with OpenAPI export) plus WebSocket

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Architecture

## Context

The Interactive Application is a Single Page Application
([Decision 0010](./0010-spa-interactive-application.md)) that talks to the backend over two
distinct kinds of communication:

1. **Request/response** — queries and mutations (create a Task, move a card, save a Profile).
2. **A live, bidirectional channel** — streaming agent terminal output, Board and Workflow
   Run state changes, and carrying client input back to a running agent (terminal input,
   steering).

The stack is TypeScript end-to-end with Zod validation. A required deliverable is an
**`openapi.json`** describing the HTTP API, so that external consumers, a future CLI, and
standard tooling can use the API against a portable contract.

## Decision

- Use **tRPC over HTTP** for queries and mutations, giving the SPA an end-to-end type-safe
  client with no schema drift and reuse of the project's Zod contracts.
- **Generate and publish an `openapi.json`** describing the HTTP API, exported from the tRPC
  routers, as a committed build artifact — so the API is also available through a standard,
  language-agnostic contract.
- Use a **WebSocket** channel for the live, bidirectional stream: agent activity, Board and
  Run updates outward, and terminal input and steering inward.

`openapi.json` describes the **HTTP request/response API only**. The realtime WebSocket
channel is not covered by OpenAPI; if it needs a formal contract later, that is documented
separately (for example with AsyncAPI) and is out of scope here.

## Considered options

- **tRPC with OpenAPI export plus WebSocket (chosen)** — keeps tRPC's inferred-client
  developer experience while still producing the required `openapi.json`; WebSocket covers the
  bidirectional realtime need.
- **REST + OpenAPI generated from Zod** — Rejected: a clean way to get `openapi.json`, but
  loses the inferred-client ergonomics tRPC gives the SPA.
- **GraphQL** — Rejected: heavier server and caching model than this application needs.
- **Plain tRPC with no OpenAPI** — Rejected: does not satisfy the `openapi.json` deliverable.
- **Server-Sent Events for the live channel** — Rejected: server-to-client only; the SPA must
  send input back to a running agent, which requires a bidirectional channel.

## Consequences

- Positive: the SPA gets a type-safe client; external consumers and tooling get a standard
  `openapi.json`; the realtime channel is fully bidirectional.
- Negative: tRPC procedures must be shaped and annotated so they export cleanly to OpenAPI —
  a constraint on router design and a build step that must be kept working.
- Neutral: OpenAPI does not describe the WebSocket channel; that is an accepted boundary.
- Distinct from the internal protocols, which this decision does not change: **ACP**
  (orchestrator ↔ agent CLIs, [Decision 0003](./0003-agent-connection-protocol.md)) and
  **Inngest** durable orchestration ([Decision 0004](./0004-durable-orchestration-engine.md)).
- Affects the [building block view](../architecture/05-building-blocks.md) and the API-surface
  constraint in the constitution.
