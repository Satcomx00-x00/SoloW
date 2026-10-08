# 0031 — Focus on the solo power user

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** Product
**Supersedes:** [0001](./0001-scope-near-clone.md) for the 1.0 scope · **Affects:** [Roadmap](../ROADMAP.md) phase 0

## Context

[0001](./0001-scope-near-clone.md) set the goal as breadth parity with comparable tools. The
result is a product that is wide and uneven: remote and cloud environments with no driver,
notification plumbing with no screen, a Workflows designer marked WIP, and a release every day.
The findings of 2026-10-08 trace the failures to scope, defaults and a missing feedback loop, not
to the technology. Breadth before depth is the cause of the first.

## Decision

1. **SoloW 1.0 is for one persona: the solo power user, on their own machine.** Everything is
   judged by whether it shortens the path from an Issue to a reviewed pull request for that person.
2. **Moved to "Later", after 1.0 and only if the numbers justify it:** hosted teams, remote (SSH)
   and cloud environments, notifications, sharing and analytics.
3. **Unfinished surfaces are hidden, not deleted.** Remote and cloud environment kinds and the
   areas marked WIP sit behind `ff-remote-environments` and `ff-wip-areas`, which ship OFF — the
   one exception to the default-ON rule of the flag registry. The code stays; turning the flag on
   brings it back.
4. **Until 1.0 only fixes and the roadmap's own items ship**, on a weekly release cadence (see
   [Conventions](../CONVENTIONS.md#contribution-and-release-rules)).

## Considered options

- **Keep 0001 and finish the breadth.** Rejected: ten weeks of breadth work would still leave the
  core loop unsafe and unmeasured.
- **Delete the unfinished code.** Rejected: it is tested and most of it is a driver away from
  working; hiding it costs nothing and keeps the option.

## Consequences

- Positive: Settings and the sidebar show only what works; every change competes for the same
  small scope.
- Negative: the near-clone comparison table in [Vision & Scope](../product/01-vision-and-scope.md)
  no longer describes the 1.0 target; a hosted-teams user has nothing until "Later".
- 0001 stays as the record of why the breadth exists, and still applies to post-1.0 planning.
