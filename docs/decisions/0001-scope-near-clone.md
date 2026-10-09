# 0001 — Build a near-clone rather than a narrower product

**Status:** Superseded by [0031](./0031-focus-on-the-solo-power-user.md) for the 1.0 scope · **Date:** 2026-08-17 · **Deciders:** Product

## Context

The goal is to build an alternative to the established tools in this category —
orchestration platforms for running many AI coding harnesses in parallel with human review. We
had to decide how closely to match their capability surface: a focused minimal product, a
near-clone matching their breadth, or a differentiated product in the same category.

## Decision

Build a **near-clone**: match the full feature breadth of comparable tools (multi-harness
orchestration, Kanban board, visual workflows, worktree isolation, multi-repo, multiple
executors, integrations, review-first) and differentiate on a few high-value points rather
than by narrowing scope.

## Considered options

- **Focused minimal product** — only the core loop. Rejected: too small to be a real
  alternative; users would keep their existing tool for the missing breadth.
- **Near-clone (chosen)** — full breadth plus targeted differentiators.
- **Differentiated re-imagining** — a distinct angle. Rejected for now: higher risk before
  parity is proven; differentiation is layered on top of parity instead.

## Consequences

- Positive: a credible, complete alternative; a clear scope defined by the category's
  capability set plus named differentiators (see
  [Vision & Scope](../product/01-vision-and-scope.md)).
- Negative: substantial scope; requires phased delivery.
- The differentiators are recorded as their own decisions: subscription billing
  ([0005](./0005-subscription-authentication.md)), durable orchestration
  ([0004](./0004-durable-orchestration-engine.md)), and one-product local-and-hosted
  ([0002](./0002-technology-stack.md), [0008](./0008-data-store-strategy.md)).

## Review (2026-10-09)

The one-month review ([Conventions](../CONVENTIONS.md#maintenance)), held late, against the code
at version 0.21.0.

**Verdict: superseded for 1.0, as recorded.** [0031](./0031-focus-on-the-solo-power-user.md)
replaced breadth parity with one persona on 2026-10-08. What breadth bought is now measured row
by row in the [Feature Comparison](../product/06-feature-comparison.md) (77 of 101 rows built or
partial). What it cost is the finding behind 0031: the core loop was not yet safe or used. This
record stays as the reason the breadth exists and still applies to planning after 1.0.
