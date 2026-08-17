# F09 — Integrated Review Workspace

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

The Integrated Review Workspace is the focused, per-Task surface where a user watches an
Agent work and reviews what it produced. It brings together a live terminal, a code editor,
a diff viewer, a preview of the running result, and the Agent conversation — so everything
needed to understand and judge a Task is in one place.

## Jobs served

- **J5 — Review before shipping.**

## User stories

- As a Reviewer, I want to see the Agent's changes as a clear diff, so I can judge them.
- As a user, I want a live terminal for the Task, so I can see and steer what is happening.
- As a user, I want to open and read the changed files with proper code intelligence, so I
  understand the change in context.
- As a Reviewer, I want to preview the running result, so I can confirm it actually works.

## Functional requirements

- **FR-1** The workspace presents, for a single Task: a live **terminal**, a **code
  editor**, a **diff viewer**, a **preview**, and the **Conversation** for the Task's
  Session.
- **FR-2** The **terminal** streams the Agent's live activity and lets the user send input
  and stop the Agent.
- **FR-3** The **code editor** lets the user open and read files in the Task's Worktree with
  code intelligence (navigation, symbol awareness) appropriate to the language.
- **FR-4** The **diff viewer** shows the Agent's proposed changes, grouped by Repository and
  file, at a level of detail sufficient to review hunk by hunk (see [F10](./F10-review-approval.md)).
- **FR-5** The **preview** shows the running result of the Task where applicable (for
  example, a running application), so the user can verify behaviour.
- **FR-6** The panels can be arranged and resized so the user can focus on what matters for
  a given Task.
- **FR-7** The workspace reflects Task and Session state changes in near real time.
- **FR-8** The workspace is reachable from any surface that lists a Task
  (see [Information Architecture](../product/05-information-architecture.md)).

## Non-functional requirements

- **NFR-1** Live streams (terminal, status) update with low latency.
- **NFR-2** The workspace remains responsive on large diffs and large files.

## States & rules

- The workspace always corresponds to exactly one Task and its current Session.
- Review actions taken here drive the Task's lifecycle (see [F10](./F10-review-approval.md)).

## Edge cases & failure handling

- If a preview cannot be produced for a Task, the workspace clearly indicates that rather
  than appearing broken.
- If a Session has ended, the workspace shows the final state and the recorded Conversation.

## Out of scope

- The specific rules governing acceptance and rejection, specified in [F10](./F10-review-approval.md).
- Visual design of the panels (owned by Design).

## Related

- [F10 — Review & Approval](./F10-review-approval.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [F08 — Worktrees & Repositories](./F08-workspaces-repositories.md)
