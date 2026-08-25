# F22 — Source Control Panel

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-24

## Summary

[F09](./F09-integrated-workspace.md) gives a Task a diff viewer. This feature turns it into the
source-control surface every developer already knows — the one in their editor: files grouped by
what git says about them, a status letter per row, a diff on click, and stage / unstage / discard
where the hand expects to find them.

One thing is deliberately not VS Code's. In an editor, staging is a step on the way to a commit
you make yourself. Here **staging *is* the review selection**: what is staged is exactly what
approval commits, and the review record says which files those were. There is no second button
that writes to a branch, because a path from agent output to a branch without a recorded human
decision is the one thing the product may not have (Principle I).

That single substitution is what makes the familiar interaction legal here. A reviewer who has
used git anywhere already knows how to say "these four files, not that one" — and saying it now
produces a *better* audit record than approve-or-reject ever did, because the record names the
selection instead of implying it.

See [Decision 0017](../decisions/0017-worktree-git-rpc.md) for how a browser reaches a worktree
that only the orchestrator may touch.

## Jobs served

- **J5 — Review before shipping.**
- **J10 — Operate with confidence.**

## User stories

- As a Reviewer, I want the agent's change grouped the way my editor groups it, so I can read it
  without learning a second vocabulary for the same thing.
- As a Reviewer, I want to approve some files and send the rest back, so one file I dislike does
  not cost me a Task that is otherwise right.
- As a Reviewer, I want to discard a file the agent should never have touched, without rejecting
  the whole run.
- As a Reviewer, I want to know which branch this is and whether it is ahead of its remote, so I
  know what approving is going to publish.
- As a Reviewer, I want to review a Task whose agent finished hours ago, so review is not tied to
  a process still being alive.
- As an Operator, I want every write the panel makes to be in the record, so "what did the human
  change before approving" has an answer.

## Functional requirements

- **FR-1** THE SYSTEM SHALL present each of a Task's worktrees as source-control groups —
  **Merge Changes**, **Staged Changes**, **Changes**, **Untracked** — omitting any group that is
  empty.
- **FR-2** Each row SHALL carry the git status letter (`M` `A` `D` `R` `C` `U` `?`), the file
  name, its parent path de-emphasised beside it, and the row's additions and deletions.
- **FR-3** Each group SHALL show a count, and the panel SHALL show the total as a badge.
- **FR-4** THE SYSTEM SHALL offer a tree and a flat-list presentation of the same rows, and SHALL
  persist the choice per user through [F19](./F19-extension-contributions.md)'s preference
  boundary.
- **FR-5** Selecting a row SHALL show that file's diff, without navigating away from the list.
- **FR-6** THE SYSTEM SHALL offer stage, unstage and discard on a single row and on a whole
  group.
- **FR-7** **Approval commits exactly the staged set.** WHEN a Session is approved, THE SYSTEM
  SHALL commit the staged paths and no others; unstaged and untracked files SHALL remain in the
  worktree and SHALL NOT be part of the approved change.
- **FR-8** WHERE nothing is staged, THE SYSTEM SHALL refuse approval and state why, rather than
  recording a decision over an empty commit.
- **FR-9** THE SYSTEM SHALL record every panel write on the Session log as a typed event naming
  the actor, the operation and the paths. A human's edit to the agent's proposal belongs in the
  record beside the agent's own work, not outside it.
- **FR-10** THE SYSTEM SHALL store, on the review record, the paths approved and the tree hash
  they were approved at.
- **FR-11** THE SYSTEM SHALL require confirmation before a discard, SHALL name what will be lost,
  and SHALL state that it cannot be undone from the panel.
- **FR-12** THE SYSTEM SHALL name the worktree's branch, its upstream if it has one, and how far
  ahead and behind it is.
- **FR-13** WHERE the Repository has a remote and a stored credential, THE SYSTEM SHALL offer
  publish, push, pull and sync, delegating to the integration strategies of issue #71. None of
  them SHALL be reachable for un-approved work.
- **FR-14** THE SYSTEM SHALL refresh on demand, and SHALL refresh itself at the same turn
  boundary that captures the diff, so a live run's panel is current without polling.
- **FR-15** THE SYSTEM SHALL work for a Task with no agent running.
- **FR-16** THE SYSTEM SHALL present one source-control view per `(repository, branch)` worktree,
  named by its Repository (issue #7, issue #57).
- **FR-17** THE SYSTEM SHALL exclude the Repository's setup-file allowlist (issue #52) from every
  group, exactly as the captured diff does.

## Non-functional requirements

- **NFR-1** Every git invocation SHALL go through the `Executor` interface (issue #1). No
  filesystem or process access is added to `apps/web`; `make audit-executor-boundary` stays
  green.
- **NFR-2** A status read SHALL be bounded. A worktree with ten thousand changed files SHALL
  produce a truncated response that says it was truncated, never an unbounded payload.
- **NFR-3** Every path a client names SHALL be resolved and then verified to be inside the
  worktree root before any git command sees it — resolve-then-contain, never a prefix test on an
  unresolved path (the rule issue #68 states, and the same resolver).
- **NFR-4** No response, log line or event SHALL contain a credential, a remote URL with
  userinfo, or the contents of an excluded setup file (Principle IV).
- **NFR-5** A status read SHALL be the only call the panel makes to render, and SHALL complete
  within the latency budget of an interactive panel on a repository of ordinary size.
- **NFR-6** Behaviour SHALL be identical on every Executor kind — local today, Docker and SSH
  when issues #96 and #97 land — because the calls go through the same interface.
- **NFR-7** A mutation SHALL be refused unless the caller's Workspace owns the Task
  (Principle V), verified on the orchestrator and not only in the browser.

## States & rules

- A file is in exactly one group: conflicted, staged, changed, or untracked. A file both staged
  and further modified appears in *both* Staged Changes and Changes, as git reports it and as an
  editor shows it.
- **The panel is read-only while the agent is running.** Staging under a process that is still
  writing is a race whose loser is the reviewer, and the panel would be describing a tree that
  has already moved. Writes become available when the Task is at the review gate, parked, or
  failed with its worktree preserved.
- **Approval is still one decision.** Selecting files chooses the content of that decision; it
  does not split one Task into several partial approvals. A Task spanning repositories still
  approves once, across all of them (issue #70's rule).
- Discard is destructive and final from the panel's point of view. The agent's work is not in a
  commit yet, so there is nothing to restore it from.
- A worktree that has been cleaned up has no source control. The Task's captured diff is still
  there, and the panel says which it is showing.
- Nothing in this feature commits, pushes, or opens a change request outside the review gate.

## Edge cases & failure handling

- **The agent is still running** — read-only, with the reason stated in place of the actions
  rather than as disabled buttons with no explanation.
- **The worktree is gone** (an approved Task, cleaned up) — the panel falls back to the captured
  diff, read-only, and says so. This is why the capture exists.
- **A merge conflict** — the Merge Changes group lists the conflicted paths and shows their
  markers. Resolution is out of scope; the panel shows the state and does not pretend to fix it.
- **The file changed between the status read and the click** — the operation is applied to the
  path, git decides, and the result is re-read. The panel never reports success from its own
  optimistic copy.
- **A binary file** — listed with its status and no line counts, and its diff says it is binary.
- **A path that resolves outside the worktree** — refused, logged, and reported as a rejected
  path. This is the one class of request that is a security event rather than a mistake.
- **Discarding an untracked file** — deletes it, and the confirmation says so in those words,
  because "discard" reads as "revert" and here it means "delete".
- **No remote, or no credential** — publish and sync are absent with the reason, not present and
  failing on click.
- **A detached HEAD** — named as detached rather than as a branch. Approval still commits; there
  is simply no upstream to compare against.
- **The orchestrator is unreachable** — the panel reports the service as unavailable and offers
  retry. It does not fall back to a stale status, which would invite staging decisions against a
  tree nobody has read.

## Out of scope

- **Hunk-level and line-level staging.** Splitting and re-applying patches correctly is where git
  UIs go subtly wrong, and file granularity is what a review selection actually needs. Revisit
  with evidence that files are too coarse.
- **Editing files in the panel.** Issue #67 states the rule and it holds here: a human editing
  the agent's worktree makes the review record describe changes the agent did not make.
- **An independent commit button, a commit message box, and amend.** Superseded by FR-7 — the
  gate is the commit.
- **History, blame, stash, and the timeline.** Every one is a second feature with its own
  storage question.
- **Conflict resolution.** Showing a conflict is here; resolving it is an editor's job (#67) or
  the agent's.
- **Branch creation and switching.** A Task's branch is decided by its attachment (issue #57);
  changing it mid-review would move the ground under the diff being approved.

## Related

- [F09 — Integrated Review Workspace](./F09-integrated-workspace.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [F07 — Execution Environments](./F07-execution-environments.md)
- [F19 — Extension Contributions](./F19-extension-contributions.md)
- [F17 — Security & Secrets](./F17-security-secrets.md)
- [Decision 0017 — A synchronous worktree RPC on the orchestrator](../decisions/0017-worktree-git-rpc.md)
