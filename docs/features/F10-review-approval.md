# F10 — Review & Approval

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

Review is the human decision that gives SoloW its review-first character. No agent
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
- **FR-9** Proposed changes are grouped by `(repository, branch)`, not by repository alone. A
  Task can attach one repository twice on two branches, and a group heading naming only the
  repository would be ambiguous exactly where it matters — the branch is what a reviewer
  fetches.
- **FR-10** Each group states its **integration target before the decision is taken**: the
  branch an approval commits to, what that branch was cut from, and how many files changed. A
  repository the agent never touched is still shown as a group, saying so — approving records a
  result branch for it, and a reviewer shown only the changed repositories would be wrong about
  what they had just approved.
- **FR-11** One decision covers the whole Task, and its scope is stated in one line above the
  actions ("2 repositories, 2 branches, 14 files"). Per-repository approvals are deliberately
  **not** offered: they look more granular and are worse, because they produce partially
  integrated Tasks — repository A landed, B was rejected — a state nothing in the model
  describes and nobody can act on.
- **FR-12** No pull request is promised by that summary, because this build opens none. Opening
  one is [F12](./F12-integrations.md)'s integration strategies; stating it here would be the
  same failure the summary exists to prevent, pointed the other way.
- **FR-13** IF integration fails for any group after approval, THEN the Task fails with
  `partial_integration` and its Session log names the branches that were committed and the ones
  that were not, with the reason each failed. It is not retried automatically: a second attempt
  would commit twice to the branches that already took, and what to do about a half-landed
  change is a person's decision.

### Ending a round

- **FR-14** A round ends on the agent's **declaration**, not on its process exiting. An agent
  that reports `task_complete` and then waits — which is what a CLI agent does — is torn down
  after a grace period of silence, and any further output re-arms that grace so a declaration
  the agent supersedes does not cut it off mid-thought.
- **FR-15** THE SYSTEM SHALL NOT hold a durable step open on a process it does not control.
  Waiting on the agent's exit made the run outlive the engine's execution budget, so the step
  was never checkpointed, the run was retried from the top indefinitely, and every step below
  it — the review gate, the wait for a decision, the commit — was unreachable while the agent's
  own side effects landed normally. The product looked correct until an approval did nothing.

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
