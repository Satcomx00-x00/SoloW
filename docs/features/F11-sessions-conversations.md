# F11 — Sessions & Conversations

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

A Session is a single run of an Agent against a Task, and the Conversation is its recorded
exchange. GateControl keeps Sessions and Conversations so users can understand what an
Agent did, resume its work with full context, and revisit it later.

## Jobs served

- **J8 — Resume and recover.**

## User stories

- As a user, I want to resume an agent's work where it left off, so I do not lose its
  context or repeat work.
- As a Reviewer, I want to read the full conversation behind a change, so I understand why
  the agent did what it did.
- As a user, I want each attempt at a Task to be recorded, so I can compare or revisit them.

## Functional requirements

- **FR-1** Launching an Agent on a Task creates a Session that records the Conversation, a
  stream of events, and the proposed Diff.
- **FR-2** A user can read a Session's full Conversation, including the Agent's actions and
  any tool use.
- **FR-3** A user can resume a resumable Session so the Agent continues with its prior
  context (used by request-changes in [F10](./F10-review-approval.md)).
- **FR-4** A Task may have multiple Sessions over its life; each is recorded and
  distinguishable.
- **FR-5** A Session's state (active, awaiting review, resumable, closed) is shown to the
  user (see [Domain Model](../product/04-domain-model.md)).
- **FR-6** A Session's Conversation is the source for the shareable Snapshot in
  [F13](./F13-collaboration-sharing.md).

## Non-functional requirements

- **NFR-1** Conversations and events are durably recorded so a Session's history can be
  reconstructed (product [NFR-3](../product/03-product-requirements.md)).
- **NFR-2** Resuming a Session preserves context accurately.

## States & rules

- Session states and transitions are defined in [Domain Model](../product/04-domain-model.md).
- A Session belongs to exactly one Task; a Task may accumulate several Sessions.

## Edge cases & failure handling

- If a Session ends unexpectedly, its recorded Conversation and last state remain available,
  and the Task can start a new Session.
- If a Session cannot be resumed, the user is told why and can start a fresh Session.

## Out of scope

- The redaction rules for shared exports, specified in [F13](./F13-collaboration-sharing.md).

## Related

- [F04 — Multi-Agent Orchestration](./F04-agent-orchestration.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
