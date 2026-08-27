# F08 — Worktrees & Repositories

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-20

## Summary

SoloW gives every Task its own isolated Git working copy — a Worktree — so multiple
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
- **FR-2** When a Task starts, SoloW provisions an isolated Worktree for each
  Repository the Task touches, on its own branch.
- **FR-3** Concurrent Tasks operate in separate Worktrees and never share working files.
- **FR-4** A single Task can span multiple Repositories, each producing its own branch and
  change set.
- **FR-5** A user can choose the base branch or commit a Task's Worktree starts from.
- **FR-6** On acceptance of a Task's changes, SoloW supports integrating them
  (for example, creating a branch and a pull request per Repository) — see
  [F12](./F12-integrations.md) for source-host integration.
- **FR-7** When a Task is completed or discarded, its Worktrees are cleaned up.
- **FR-8** A Repository carries an allowlist of file patterns — its **setup files** — copied
  from the Repository into each new Worktree before the Agent works in it. The allowlist is
  explicit: SoloW never copies "everything Git ignores".

## Non-functional requirements

- **NFR-1** Worktree isolation holds across all Executor types.
- **NFR-2** Provisioning and cleaning up Worktrees does not affect other Tasks.
- **NFR-3** Repositories are cached where possible so repeated Tasks start quickly.
- **NFR-4** Setup files are treated as credential-bearing: their contents and their resolved
  paths are never logged, they are excluded from the diff presented for review, and they are
  excluded from the commit made on approval (Principle IV).

## States & rules

- A Worktree belongs to exactly one Task.
- A Task's attachment to a Repository is keyed on the **(Repository, branch)** pair, not on the
  Repository alone. One Task may therefore attach the same Repository twice on two branches, and
  produce two change sets from one unit of work.
- Each attachment carries its own base ref, its own checkout branch, and — once approved — its
  own result branch. There is no Task-wide branch.
- A Task's attachments are ordered. The first is the **primary** attachment.
- **The Agent runs in exactly one working directory: the primary attachment's Worktree.** Every
  other attachment is provisioned as a sibling Worktree and its absolute path is named to the
  Agent in the brief. That is the only way an Agent can reach a Repository it was not started
  in; until per-repository integration lands, an Agent that ignores the brief's `# Repositories`
  section simply produces an empty change set for that Repository, which is visible as an empty
  group in Changes rather than silent.
- **Who creates the primary Worktree depends on what the attachment asks for.** An Agent that
  makes its own (Claude Code's `--worktree`) is left to, because that is what lets several Tasks
  share one Repository — but such an Agent branches from HEAD and names the branch itself. So an
  attachment that names a base ref, or a checkout branch other than the one SoloW derives,
  is provisioned by SoloW and the Agent is started inside it. Otherwise the Owner's base
  ref would be stored, shown in the brief and silently ignored for the primary while every
  secondary honoured its own.
- The brief names each Worktree's branch only once something can say what it is. A Worktree
  SoloW provisioned is on the attachment's branch by construction; one the Agent made for
  itself is on a branch only Git can report, so until it has been adopted the brief names the
  Repository without a branch rather than naming one that does not exist.
- A Task's Worktrees exist for the Task's active life and are removed on completion or
  discard.
- Multi-repository Tasks keep each Repository's changes independent for review and
  integration: one diff, one branch and one commit per Repository.
- A Task's attachment set may be replaced while it is in Backlog or Ready. Once it has started,
  the set is fixed — re-pointing a Task whose Worktrees are already live would orphan them.
- Setup-file patterns are resolved within the Repository root only. A pattern that is absolute,
  that climbs out of the Repository, or that Git would read as pathspec magic is rejected when
  it is saved.
- Setup files are copied once, on the round that creates the Worktree. A Worktree resumed for
  another review round keeps whatever it already has.

## Edge cases & failure handling

- If any attached Repository is unreachable at Task start, the Task fails before running the
  Agent, with a reason naming that Repository. Only the Repository's name is recorded — the
  underlying Git error is logged and never written to the failure reason, because a failed clone
  echoes back the credential-helper argument list (Principle IV).
- A location that is not a Git repository is answered at once; a failure a retry could fix — a
  clone that timed out, a path momentarily unavailable — is retried first, and only the last
  attempt records the failure. One flake must not bury a Task permanently, and a Task that has
  run out of attempts must still say which Repository it was.
- If one Repository of several cannot be provisioned, the Worktrees already created for that
  launch are removed before the Task fails. They would otherwise keep their branches checked out
  and block the next launch from reusing them.
- If Worktree cleanup fails, the failure is surfaced and does not block other Tasks.
- If a setup-file pattern matches nothing — or a matched file cannot be copied — SoloW
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
