# F08 — Worktrees & Repositories

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-20

## Summary

GateControl gives every Task its own isolated Git working copy — a Worktree — so multiple
agents can work in parallel without colliding. A single Task can span multiple
Repositories, each with its own branch and change set, so cross-repository work is a
first-class capability.

## Jobs served

- **J1 — Parallelise safely.**

## User stories

- As a Solo Power User, I want each agent to work in isolation, so concurrent Tasks never
  overwrite each other's files.
- As a user, I want a Task to change more than one repository at once, so cross-cutting work
  is handled together.
- As a Reviewer, I want each Task's changes on their own branch, so I can review and merge
  them cleanly.
- As a Solo Power User, I want the local configuration a repository needs — its `.env`, say —
  to be present in every new Worktree, so the agent can run the test suite and verify its own
  work instead of guessing.

## Functional requirements

- **FR-1** A user can connect one or more Git Repositories to a Workspace.
- **FR-2** When a Task starts, GateControl provisions an isolated Worktree for each
  Repository the Task touches, on its own branch.
- **FR-3** Concurrent Tasks operate in separate Worktrees and never share working files.
- **FR-4** A single Task can span multiple Repositories, each producing its own branch and
  change set.
- **FR-5** A user can choose the base branch or commit a Task's Worktree starts from.
- **FR-6** On acceptance of a Task's changes, GateControl supports integrating them
  (for example, creating a branch and a pull request per Repository) — see
  [F12](./F12-integrations.md) for source-host integration.
- **FR-7** When a Task is completed or discarded, its Worktrees are cleaned up.
- **FR-8** A Repository carries an allowlist of file patterns — its **setup files** — copied
  from the Repository into each new Worktree before the Agent works in it. The allowlist is
  explicit: GateControl never copies "everything Git ignores".

## Non-functional requirements

- **NFR-1** Worktree isolation holds across all Executor types.
- **NFR-2** Provisioning and cleaning up Worktrees does not affect other Tasks.
- **NFR-3** Repositories are cached where possible so repeated Tasks start quickly.
- **NFR-4** Setup files are treated as credential-bearing: their contents and their resolved
  paths are never logged, they are excluded from the diff presented for review, and they are
  excluded from the commit made on approval (Principle IV).

## States & rules

- A Worktree belongs to exactly one Task.
- A Task's Worktrees exist for the Task's active life and are removed on completion or
  discard.
- Multi-repository Tasks keep each Repository's changes independent for review and
  integration.
- Setup-file patterns are resolved within the Repository root only. A pattern that is absolute,
  that climbs out of the Repository, or that Git would read as pathspec magic is rejected when
  it is saved.
- Setup files are copied once, on the round that creates the Worktree. A Worktree resumed for
  another review round keeps whatever it already has.

## Edge cases & failure handling

- If a Repository is unreachable at Task start, the Task fails before running the Agent,
  with a clear reason.
- If Worktree cleanup fails, the failure is surfaced and does not block other Tasks.
- If a setup-file pattern matches nothing — or a matched file cannot be copied — GateControl
  warns and the Task continues. A Repository configured on a machine that lacks one of the
  files should still run, with less for the Agent to go on.

## Out of scope

- Source-host-specific integration (pull requests, permissions), specified in
  [F12](./F12-integrations.md).

## Related

- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [F12 — External Integrations](./F12-integrations.md)
