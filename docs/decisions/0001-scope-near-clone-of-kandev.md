# 0001 — Build a near-clone of kandev

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product

## Context

The goal is to build an alternative to kandev — an orchestration platform for running many
AI coding agents in parallel with human review. We had to decide how closely to match
kandev: a focused minimal product, a near-clone matching its breadth, or a differentiated
product in the same category.

## Decision

Build a **near-clone**: match kandev's full feature breadth (multi-agent orchestration,
Kanban board, visual workflows, worktree isolation, multi-repo, multiple executors,
integrations, review-first) and differentiate on a few high-value points rather than by
narrowing scope.

## Considered options

- **Focused minimal product** — only the core loop. Rejected: too small to be a real
  alternative; users would keep kandev for the missing breadth.
- **Near-clone (chosen)** — full breadth plus targeted differentiators.
- **Differentiated re-imagining** — a distinct angle. Rejected for now: higher risk before
  parity is proven; differentiation is layered on top of parity instead.

## Consequences

- Positive: a credible, complete alternative; a clear scope defined by kandev's capability
  set plus named differentiators (see [Vision & Scope](../product/01-vision-and-scope.md)).
- Negative: substantial scope; requires phased delivery.
- The differentiators are recorded as their own decisions: subscription billing
  ([0005](./0005-subscription-authentication.md)), durable orchestration
  ([0004](./0004-durable-orchestration-engine.md)), and one-product local-and-hosted
  ([0002](./0002-technology-stack.md), [0008](./0008-data-store-strategy.md)).
