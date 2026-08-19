# F10 — Review & Approval

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Review is the human decision that gives GateControl its review-first character. No agent
change is integrated until a person has inspected it and approved it. Review applies both
to a Task's final changes and to human-in-the-loop Gates inside Workflows and Agent tool
use.

## Jobs served

- **J5 — Review before shipping.**

## User stories

- As a Reviewer, I want to approve, reject, or request changes on an agent's proposed diff,
  so only good changes land.
- As a Reviewer, I want to approve or deny an agent's request to use a sensitive tool, so I
  keep control of risky actions.
- As a user, I want a Workflow to pause for my decision at defined points, so the process
  respects human judgment.

## Functional requirements

- **FR-1** When an Agent proposes changes, the Task enters Review and the changes are
  presented as a Diff for inspection (see [F09](./F09-integrated-workspace.md)).
- **FR-2** A Reviewer can **approve** (accept the changes), **reject** (discard them), or
  **request changes** (return the Task to the Agent with feedback).
- **FR-3** Approval is required before a Task can reach Done; changes are integrated only
  after approval.
- **FR-4** A Reviewer can approve or deny an Agent's request to use a tool, when the Agent
  Profile's policy requires human approval (see [F04](./F04-agent-orchestration.md)).
- **FR-5** A Workflow Gate presents a decision to a human and blocks downstream Steps until
  the decision is recorded (see [F03](./F03-workflow-designer.md)).
- **FR-6** Every Review decision is recorded with who decided, when, and any feedback given.
- **FR-7** Requesting changes resumes the Agent's Session with the reviewer's feedback in
  context rather than starting over.
- **FR-8** Destructive review actions (rejecting/discarding changes) require confirmation.

## Non-functional requirements

- **NFR-1** No path integrates agent changes without a recorded human approval
  (product [NFR-3](../product/03-product-requirements.md)).
- **NFR-2** Review decisions are durably recorded and auditable.

## States & rules

- A Task in Review advances to Done only on approval, returns to Running on request-changes,
  and returns to its prior state or is discarded on rejection.
- Tool-use approval and Workflow Gates are forms of Review governed by the same principle:
  a recorded human decision is required to proceed.

## Edge cases & failure handling

- If a Reviewer is unavailable, the Task or Run remains safely paused and clearly marked as
  awaiting review; it can be reassigned.
- If changes are rejected, the Worktree changes are discarded cleanly (see [F08](./F08-workspaces-repositories.md)).

## Out of scope

- The presentation of the diff and workspace panels, specified in [F09](./F09-integrated-workspace.md).

## Related

- [F03 — Visual Workflow Designer & Monitor](./F03-workflow-designer.md)
- [F09 — Integrated Review Workspace](./F09-integrated-workspace.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
