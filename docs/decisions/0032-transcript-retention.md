# 0032 — A finished Task keeps its transcript for a window the Workspace chooses

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** Architecture
**Amends:** [0025](./0025-history-retention.md) · **Closes:** FINDINGS F4 ·
**Affects:** [F11](../features/F11-sessions-conversations.md) FR-8, Settings → Workspace

## Context

[0025](./0025-history-retention.md) gave closed and deleted Tasks a seven-day life: a deleted Task
is purged with all its rows after seven days, and a Done Task loses its worktree after seven days
but keeps every row "for as long as the Task exists". Done Tasks are rarely deleted, so in practice
their rows are kept forever.

Almost all of that weight is the transcript. Every `session_event` row is one thing the harness
said or did: an assistant turn, a tool call, a tool result that can hold a whole file (truncated,
but still kilobytes), a todo list stored whole on every rewrite. A run is thousands of them. The
rows around them (the Session, reviews, token usage, summaries, state changes) are a few dozen
per Task. The database grows with every run and nothing ever shrinks it, which is FINDINGS F4.

Two things limit what can go:

- **The outcome metrics (ROADMAP A4) and the health view (F3)** are built from Sessions, reviews,
  `session_usage`, the Task row and the `state` / `agent_done` / `workflow_decision` events. None
  of them reads a transcript.
- **The log was promised to be append-only** (F11 FR-8, the `session_summary` comment) so that the
  review gate keeps its evidence. That promise is about a Task that can still be decided. Once a
  Task is Done or deleted, the gate has already been decided.

## Decision

1. **The rule.** A Session's transcript is removed once its Task has been *finished* for longer
   than the Workspace's window. Finished means Done (measured from `task.updated_at`) or deleted
   (measured from `task.deleted_at`), the same marks 0025's sweep uses. Running, review, parked,
   failed and backlog Tasks are never touched, however old they are. Two more guards: no Session
   of the Task is `active`, and no undeleted, unfinished sub-task is waiting to fork from the
   Session, because a fork point is verified by hashing the events behind it.
2. **What goes and what stays.** These are listed once in `@solow/contracts`
   (`HISTORY_PRUNED_EVENT_KINDS` / `HISTORY_KEPT_EVENT_KINDS`) and shown in Settings in plain words.
   - *Deleted rows:* `user_turn`, `assistant_turn`, `notice`, `tool_call`, `tool_result`, `todos`,
     `permission_request`, `permission_resolved`, `widget`, `widget_response`.
   - *Emptied in place:* the `patch` text of each `diff` event, with `truncated: true`. The file
     list and line counts stay, because the round view is built from them. The patch itself is in
     the branch or the pull request.
   - *Kept unchanged:* the `state`, `workflow_decision`, `agent_done` and `usage` events, and every
     other table: Task, Session, `session_summary`, `session_usage`, `review`, `worktree`.
   - The Session is stamped `events_pruned_at`, and the Task page says that the transcript was
     removed by retention, with a link to the setting. Without that notice, the page would look
     like a run that said nothing.
3. **The window is per Workspace**, in `workspace.history_retention_days`. The choices are 7, 30,
   90 or 365 days, or null for **keep forever**. There is no window shorter than
   `TASK_RETENTION_DAYS`: a Task restored or reopened within its week in History must come back
   with its conversation. A test in `@solow/core` checks this.
4. **The default is 30 days for a new Workspace. An existing Workspace keeps everything until its
   Owner chooses.** The migration adds the column with `DEFAULT 30`, then sets every Workspace
   that already exists to null (keep forever) and flags it (`workspace.history_retention_notice`).
   Thirty days is four times the History window and long enough to look back over a month's work.
   It is not applied on upgrade because nobody has seen it yet: the first hourly sweep after the
   upgrade would delete every transcript finished more than a month ago, the pre-migrate backup
   is pruned after five more upgrades, and the Owner would never have been told. Existing data is
   never deleted silently. Instead, while the flag is set, Settings → History retention and the
   History page show a one-time notice that transcripts are being kept and invite the Owner to
   choose; saving any window, "keep forever" included, clears it. *(Amended 2026-10-08, before
   0049 shipped in a release: the first version applied 30 days to existing Workspaces.)*
5. **Shown and changed in Settings → Workspace → History retention.** The picker holds a draft,
   and the server counts what that draft *would* remove right now (`workspace.previewHistoryRetention`:
   Tasks, Sessions, events, diffs and approximate bytes) before anything is saved. Nothing is
   written until the Owner presses Save.
6. **It runs as the third arm of the existing hourly retention sweep in the orchestrator**, after
   purge and expiry. It is not an Inngest cron, for three reasons. The sweep already runs hourly on
   the process that shares the database file. It already runs after the first reconcile pass, so a
   Task that reconcile is about to settle is never pruned underneath it. And it needs no engine:
   retention should not stop because the run engine is down.
7. **Bounded batches.** Rows are deleted 500 at a time, one statement per batch, with a yield to
   the event loop between batches. One sweep removes at most 20,000 events. A Session is stamped
   only after its last transcript row is gone, so a sweep that is cut short (by the bound, a crash
   or a restart) leaves the Session unstamped and the next sweep finishes it.
8. **No vacuum.** The database runs with `auto_vacuum = NONE`, so `PRAGMA incremental_vacuum`
   would do nothing. Turning incremental vacuum on needs a full `VACUUM`, which rewrites the whole
   file under an exclusive lock and briefly needs twice the disk space. Pages freed by pruning go
   on SQLite's freelist and are reused by new events, so the file stops growing instead of
   shrinking. That is the property F4 asks for. A compacted copy is available whenever wanted:
   the backup is a `VACUUM INTO` ([backup and restore](../operations/backup-and-restore.md)).

## Alternatives considered

- **Delete whole Sessions, or whole finished Tasks.** This would destroy the rows the outcome
  metrics and History read. Rejected: those rows are small, and they are the product's evidence
  that it works.
- **Strip payloads but keep every row.** This keeps `seq` dense and the summary counts exact, but
  frees only part of the space and leaves every index entry behind. Used for `diff` alone, where
  the row itself is read.
- **A global environment variable, as 0025 did for its seven days.** F4 asks for a rule the user
  can *see and change*, and the cost of a window depends on how one Workspace is used.
- **Prune at startup.** That only works for a process that restarts often. A long-lived install
  would never prune, and a startup that deletes 100,000 rows is a slow startup.

## Consequences

- A new install stops growing without bound even if its Owner never opens Settings. An install
  that predates the rule keeps growing until its Owner answers the notice; that is the price of
  never deleting what someone already had without asking.
- A Task finished more than a window ago opens with its record, its decisions, its rounds and the
  file list of each change, but not the conversation. A summary still says what its range held,
  but expanding the range returns what is left of it. A fork cursor minted earlier from a pruned
  Session is refused as stale, which is the behaviour F11 FR-9 already defines.
- Lowering the window is destructive on the next hourly sweep. That is why Settings shows the count
  before saving and only writes on Save.
- `session_event` is no longer strictly append-only. The exception is limited to finished Tasks,
  is stated where the rule was stated (the schema comment and F11 FR-8), and leaves a stamp on the
  Session.
