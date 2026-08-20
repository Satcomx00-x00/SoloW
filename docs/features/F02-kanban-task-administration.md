# F02 — Kanban Task Administration

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

The Kanban Board is the primary surface for administering Tasks. Tasks are the executable
units of agent work, always organised under an Issue. The board makes the state of every
Task obvious at a glance and is where users create, configure, launch, review, and complete
agent work.

## Jobs served

- **J1 — Parallelise safely.**
- **J2 — Organise agent work around issues.**

## User stories

- As a Team Lead, I want to see all agent Tasks for an Issue on one board, so I understand
  the state of that work.
- As a Solo Power User, I want to drag a Task between columns to change its state, so I can
  manage work directly.
- As a user, I want to create a Task under an Issue and configure which agent and executor
  runs it, so it is ready to launch.
- As a Reviewer, I want Tasks awaiting review to be clearly separated, so I know what needs
  my attention.

## Functional requirements

- **FR-1** A Board arranges Tasks in columns that represent the Task lifecycle states:
  Backlog, Ready, Running, Review, Parked, Done, Failed.
- **FR-2** A Board can be scoped to a single Issue, or span multiple Issues within a
  Workspace with Issues shown as groupings (swimlanes).
- **FR-3** A user can create a Task under an Issue, giving it a title, description, and the
  Agent Profile, Executor Profile, and Repository or Repositories it will use.
- **FR-4** A user can move a Task between states by direct manipulation, subject to the
  transition rules in [Domain Model](../product/04-domain-model.md).
- **FR-5** A Task card shows its Issue, its Agent, its Executor, its current state, and a
  live indicator when running.
- **FR-6** A user can launch a Ready Task, which starts an Agent Session and moves the Task
  to Running.
- **FR-7** A user can open any Task into the [Integrated Review Workspace](./F09-integrated-workspace.md)
  from the board.
- **FR-8** A user can define Task dependencies, so a Task with a prerequisite that is not yet
  Done is never started — not by launch, not by retry, not by a move into Running, and not by
  any automated path. Ready stays a planning state the user controls: a blocked Task can still be
  moved into Ready, it simply cannot enter Running until every prerequisite is Done.
- **FR-9** A user can filter and search Tasks on a Board by Issue, Agent, Executor, state,
  and text.
- **FR-10** A user can archive or delete a Task, with confirmation for the destructive
  action.
- **FR-11** Multiple Tasks can be Running at once, bounded by configured concurrency limits
  (see [F06](./F06-authentication-billing.md)).

## Non-functional requirements

- **NFR-1** Task state changes are reflected on the Board in near real time for all viewers.
- **NFR-2** The Board remains usable with many Tasks and many concurrent Running Tasks.

## States & rules

- The lifecycle states and their transitions are defined once in
  [Domain Model](../product/04-domain-model.md); the Board is their primary presentation.
- A Task cannot enter Running unless it is Ready (fully configured), within concurrency
  limits, and has no prerequisite that is not yet Done; otherwise it queues.
- Dependencies are `blocked_by` edges scoped to one Workspace. An edge that would close a cycle
  is refused when it is declared, naming the offending path, rather than discovered later by a
  Task that silently never starts.
- Moving a Running Task backward interrupts its Session (with confirmation).
- A Task in Review cannot reach Done until a human Review outcome is recorded.

## Edge cases & failure handling

- If a Task cannot start because concurrency is saturated, it waits in Ready and is clearly
  marked as queued.
- If an Agent or Executor fails mid-run, the Task moves to Failed with the reason attached
  and can be retried.
- If a subscription quota is exhausted while running, the Task moves to Parked rather than
  Failed (see [F06](./F06-authentication-billing.md)).

## Out of scope

- The visual design of cards and columns (owned by Design).
- Workflow orchestration logic, which is specified in [F03](./F03-workflow-designer.md).

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F09 — Integrated Review Workspace](./F09-integrated-workspace.md)
- [Decision 0006 — Kanban scoped to Issues](../decisions/0006-kanban-scoped-to-issues.md)
- Issue #6 — FR-8 as built: dependencies are Workspace-scoped `blocked_by` edges, a cycle is refused at write time naming the offending path, and a Task with an unsatisfied predecessor is never started by any automated path. Not built: chained creation that fires a dependent Task automatically once every predecessor succeeds — unblocking lifts a refusal, it does not launch anything.
