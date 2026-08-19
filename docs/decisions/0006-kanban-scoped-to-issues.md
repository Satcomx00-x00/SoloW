# 0006 — Administer Tasks on a Kanban board scoped under Issues

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Product

## Context

Agent work needs an organising structure. Users think in terms of Issues (a bug, a request,
a feature) and want to break each Issue into concrete pieces of executable agent work, then
manage those pieces visually. We had to decide the relationship between Issues, Tasks, and
the Kanban board.

## Decision

Make the **Issue the organising unit** and the **Task the executable unit**, with **Tasks
administered on a Kanban board under an Issue**. A board can be scoped to a single Issue or
span many Issues (with Issues shown as groupings). Every Task belongs to exactly one Issue.

## Considered options

- **Flat board of Tasks with no Issue concept** — Rejected: loses the connection between
  agent work and the request it serves; makes status reporting against real work impossible.
- **Issues only, no Kanban** — Rejected: loses the at-a-glance, drag-to-manage administration
  that makes parallel work legible.
- **Issue → Tasks on a Kanban board (chosen)** — combines a real organising unit with a
  direct, visual administration surface.

## Consequences

- Positive: agent work is always anchored to an Issue; the board makes lifecycle state
  obvious; Issue status can derive from its Tasks.
- Positive: Issues can be native or synchronised from external trackers without changing how
  Tasks are administered.
- Negative: introduces a two-level hierarchy that all surfaces must respect consistently.
- Realises [F01](../features/F01-issue-management.md),
  [F02](../features/F02-kanban-task-administration.md), and the
  [domain model](../product/04-domain-model.md).
