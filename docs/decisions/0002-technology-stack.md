# 0002 — Application plus a long-lived orchestrator; local-first with a path to hosted

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product, Architecture

## Context

Harnesses are external, long-running command-line processes that must be held open,
supervised, and streamed back to the user. A purely request/response surface cannot hold a
live harness process open across minutes of work. The product must also run both locally for
one user and hosted for a team.

## Decision

Structure SoloW as **two collaborating parts**: an **interactive application** for the
user-facing surfaces and data, and a **separate long-lived orchestration component** that
launches and supervises harnesses, manages working copies, and streams activity. Target
**local-first** operation now, with the **same product** able to run hosted later.

## Considered options

- **Single request/response application** — Rejected: cannot hold long-lived harness processes
  or stream them (constraint C-7).
- **Application + long-lived orchestrator (chosen)** — separates interactive concerns from
  durable, long-lived work; runs both together locally and separately when hosted.
- **Fully external heavyweight orchestration platform** — Rejected as the baseline: too heavy
  for a local-first single-binary experience, though a durable engine is still used inside
  the orchestrator (see [0004](./0004-durable-orchestration-engine.md)).

## Consequences

- Positive: long-lived harnesses are supported; the same codebase serves local and hosted; the
  orchestrator can scale independently when hosted.
- Negative: two parts to run and coordinate; more configuration surface (see risk R-6).
- Drives the [building block view](../architecture/05-building-blocks.md) and the
  [deployment view](../architecture/07-deployment-view.md).

## Implementation status (2026-08-20)

The orchestrator's `Bun.serve` now exposes the HTTP surface the interactive application needs
to actually reach it: `POST /events` (where the application's event emitter lands) alongside
the existing WebSocket hub, on the same port. See [Decision 0004](./0004-durable-orchestration-engine.md)'s
own status note for what receives those events.

## Review (2026-10-09)

The one-month review ([Conventions](../CONVENTIONS.md#maintenance)), held late, against the code
at version 0.21.0.

**Verdict: holds for the local half; the hosted half is Later.**

- Two parts, as decided: `apps/web` (the interactive application) and `apps/orchestrator` (a
  long-lived Bun service that supervises harnesses, worktrees and the stream). Since
  2026-10-08 the launcher supervises them, with the run engine, as three services that restart
  on their own.
- "The same product able to run hosted later" has not been exercised: an installation has one
  account and the Postgres driver is not wired. [0031](./0031-focus-on-the-solo-power-user.md)
  moves hosting to Later, so the expected consequence "the orchestrator can scale independently
  when hosted" is untested rather than refuted.
