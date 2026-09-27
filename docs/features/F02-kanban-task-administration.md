# F02 — Kanban Task Administration

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

The Kanban Board is the primary surface for administering Tasks. Tasks are the executable
units of harness work, always organised under an Issue. The board makes the state of every
Task obvious at a glance and is where users create, configure, launch, review, and complete
harness work.

## Jobs served

- **J1 — Parallelise safely.**
- **J2 — Organise harness work around issues.**

## User stories

- As a Team Lead, I want to see all harness Tasks for an Issue on one board, so I understand
  the state of that work.
- As a Solo Power User, I want to drag a Task between columns to change its state, so I can
  manage work directly.
- As a user, I want to create a Task under an Issue and configure which harness and executor
  runs it, so it is ready to launch.
- As a Reviewer, I want Tasks awaiting review to be clearly separated, so I know what needs
  my attention.

## Functional requirements

- **FR-1** A Board arranges Tasks in columns that represent the Task lifecycle states:
  Backlog, Ready, Running, Review, Parked, Done, Failed.
- **FR-2** A Board can be scoped to a single Issue, or span multiple Issues within a
  Workspace with Issues shown as groupings (swimlanes).
- **FR-3** A user can create a Task under an Issue, giving it a title, description, and the
  Harness Profile, Executor Profile, and Repository or Repositories it will use.
- **FR-4** A user can move a Task between states by direct manipulation, subject to the
  transition rules in [Domain Model](../product/04-domain-model.md).
- **FR-5** A Task card shows its Issue, its Harness, its Executor, its current state, and a
  live indicator when running.
- **FR-6** A user can launch a Ready Task, which starts a Harness Session and moves the Task
  to Running.
- **FR-7** A user can open any Task into the [Integrated Review Workspace](./F09-integrated-workspace.md)
  from the board.
- **FR-8** A user can define Task dependencies, so a Task with a prerequisite that is not yet
  Done is never started — not by launch, not by retry, not by a move into Running, and not by
  any automated path. Ready stays a planning state the user controls: a blocked Task can still be
  moved into Ready, it simply cannot enter Running until every prerequisite is Done.
- **FR-9** A user can filter and search Tasks on a Board by Issue, Harness, Executor, state,
  and text.
- **FR-10** A user can archive or delete a Task, with confirmation for the destructive
  action. *Shipped as History ([Decision 0025](../decisions/0025-history-retention.md)):* a
  deleted Task leaves every board and list and stays in History for seven days, restorable, with
  its worktree and transcripts kept so a restore can carry the harness's conversation on; a Done
  Task can be reopened (`done → ready`) and relaunched the same way. After seven days the sweep
  removes the worktrees and purges what was deleted. Deleting an Issue still removes its Tasks
  outright.
- **FR-11** Multiple Tasks can be Running at once, bounded by configured concurrency limits
  (see [F06](./F06-authentication-billing.md)).
- **FR-12** A user can split a Task into sub-tasks. A sub-task is a Task — same lifecycle, same
  review gate, same isolation — that inherits its parent's Issue, Workflow, Harness Profile,
  Executor Profile and Repositories unless overridden, and is briefed with the parent's
  transcript up to a fork point rather than starting from a cold prompt.

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
- A sub-task is a Task, not a checklist item: it gets its own worktree and branch, and its own
  review gate. Its parent link is not a dependency — a sub-task may run beside the Task it was
  split from, which is the point of splitting one. It stays on its parent's Issue, and on the
  Board it sits in the column its own state puts it in, folded under its parent when both are in
  the same column.
- A parent link that would close a chain is refused when it is made, naming the offending path,
  the same way a dependency cycle is. So is one that reaches another Issue or another Workspace.
- Forking is a *read* of the parent. A parent that is still running is not disturbed by being
  split from, and the fork point carries a hash of the transcript behind it: if that history is
  rewritten, the sub-task refuses to start rather than continuing from a history nobody promised.

## Edge cases & failure handling

- If a Task cannot start because concurrency is saturated, it waits in Ready and is clearly
  marked as queued.
- If a Harness or Executor fails mid-run, the Task moves to Failed with the reason attached
  and can be retried.
- If a subscription quota is exhausted while running, the Task moves to Parked rather than
  Failed (see [F06](./F06-authentication-billing.md)).
- If a sub-task's fork point no longer resolves before its first run — the parent's Session was
  purged, or its transcript changed behind the cursor — the run fails before a harness starts,
  saying which of the two happened. It does not silently start cold. A sub-task that has already
  run once carries on without the parent's transcript if the parent is purged later, and says so.
- Deleting a Task sends its live sub-tasks to History with it; the confirmation says how many, and
  the delete is refused while any Task in that subtree is still running. Restoring it brings back
  the ones that left with it. A sub-task restored on its own while its parent stays in History is
  detached to the top level, keeping its fork point.

## Out of scope

- The visual design of cards and columns (owned by Design).
- Workflow orchestration logic, which is specified in [F03](./F03-workflow-designer.md).

## Related

- [F01 — Issue Management](./F01-issue-management.md)
- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F09 — Integrated Review Workspace](./F09-integrated-workspace.md)
- [Decision 0006 — Kanban scoped to Issues](../decisions/0006-kanban-scoped-to-issues.md)
- Issue #6 — FR-8 as built: dependencies are Workspace-scoped `blocked_by` edges, a cycle is refused at write time naming the offending path, and a Task with an unsatisfied predecessor is never started by any automated path. Not built: chained creation that fires a dependent Task automatically once every predecessor succeeds — unblocking lifts a refusal, it does not launch anything.
- Issue #56 — FR-12 as built: `task.parent_task_id` with a fork cursor (`session_id`, `seq`,
  `sha256` of the history behind it) on the child's row; inheritance and cycle refusal in
  `task.createSubtask` / `task.setParent`, which the MCP surface exposes as tools like every
  other procedure. The fork reaches the harness as a reading of the parent's transcript in the
  brief (`renderForkDigest`), for every protocol and Executor: branching the parent's *harness
  conversation* (Claude Code's `--resume … --fork-session`) is not used, because each Task's
  harness runs against its own app-owned home ([Decision 0027](../decisions/0027-hermetic-harness-configuration.md))
  and the parent's conversation is not there to open. The Task page lists sub-tasks in its rail
  with a Split control and shows the parent chain before the title; Board cards fold under a
  parent in the same column and name it otherwise.
