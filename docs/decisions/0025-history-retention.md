# 0025 — Closed and deleted Tasks stay resumable for seven days

**Status:** Accepted · **Date:** 2026-09-11 · **Deciders:** Architecture
**Builds on:** [0017](./0017-worktree-git-rpc.md), [0023](./0023-docker-executor-cli.md) ·
**Enables:** [F02](../features/F02-kanban-task-administration.md) (history), [F11](../features/F11-sessions-conversations.md)

## Context

A Task's history used to end the moment it left the board: `task.delete` hard-cascaded the Task,
its Sessions, events, reviews and worktree rows, and an approval removed the worktree. `done` was
terminal. A Task closed by mistake, or one whose harness had context worth another round, was
gone with its conversation.

Claude Code keeps a conversation's transcript under `$HOME/.claude/projects/<cwd>/<id>.jsonl`,
keyed by the directory the CLI ran in, and resumes it with `--resume <id>` from that same
directory. So "resume the conversation" needs three things kept together: the Task's rows, its
worktree, and — for a containerised run, whose `$HOME` is a tmpfs by design — the transcript
store.

## Decision

- **Delete is a soft delete.** `task.deleted_at` is set; the Task disappears from every board
  and list and appears in History, restorable for `TASK_RETENTION_DAYS = 7`. An Issue's deletion
  still hard-cascades its Tasks — a Task has no home without its Issue.
- **Done is not terminal.** `done → ready` is a legal transition ("Reopen"); a relaunch of a
  Task with a still-present worktree and a recorded harness session id carries the
  conversation on, in that worktree, with `--resume`. A lost conversation is said in a notice and
  the round starts again from the brief, in the same worktree, without spending a review round.
- **Worktrees live seven days after a Task closes**, whatever the decision was; a retention sweep
  removes them, then purges deleted Tasks whose seven days are up (the old cascade, moved to
  `@solow/db`). A Session whose worktree is still present is `resumable`; `closed` once retention
  removed it.
- **The Docker executor binds one host directory at `$HOME/.claude/projects`** — the transcripts,
  never `.claude/` itself, which holds credentials (Principle IV) — so a containerised Task can
  resume too. The directory is removed with the worktrees.

## Consequences

- A Task can be deleted by mistake and restored, and a finished Task can be reopened with the
  harness still remembering the work — the two things History exists for.
- Disk is held for seven days per Task: every worktree, plus the transcript store of a
  containerised run. `SOLOW_TASK_RETENTION_DAYS` is not exposed; seven days is the product's
  answer, matching the review wait.
- A relaunch that cannot find its conversation is an ordinary round from the brief, said so in
  the log, not a failed Task.
