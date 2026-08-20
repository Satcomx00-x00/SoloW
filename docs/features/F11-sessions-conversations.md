# F11 — Sessions & Conversations

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-20

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
- **FR-7** Every event in a Conversation states what it is — a user turn, an assistant turn, a
  tool call, a permission and its answer, a state change, a captured change — rather than being
  free-form text a reader has to interpret.
- **FR-8** A Conversation is append-only. A long run is *summarised*, never truncated: a summary
  stands in for a closed range of the record, and the range it stands for stays readable. Reading
  a Session returns the summary in place of the range it covers; the range itself is read back on
  request, which is what keeps a long run's cost bounded for the reader as well as the writer.
- **FR-9** A Session exposes a fork point another run can start from. The fork point is refused
  if the history behind it has changed since it was issued. What it proves is a claim about the
  stored records — the hash covers the payload as written, including anything the current event
  types do not describe, and is scoped to the Session so no two can be confused.
- **FR-10** No credential value reaches a recorded event. An agent that prints its own token has
  the value removed from the record and the line kept, so a reviewer can still see that it
  happened (Principle IV).

## Non-functional requirements

- **NFR-1** Conversations and events are durably recorded so a Session's history can be
  reconstructed (product [NFR-3](../product/03-product-requirements.md)).
- **NFR-2** Resuming a Session preserves context accurately.

## States & rules

- Session states and transitions are defined in [Domain Model](../product/04-domain-model.md).
- A Session belongs to exactly one Task; a Task may accumulate several Sessions.
- Compaction inserts summaries and does nothing else. Nothing in the product deletes or rewrites
  a recorded event, which is what lets a finished Task still show what was approved (Principle I)
  and what the fork point's content hash is able to prove. Summarised ranges never overlap, so
  the record has exactly one summary standing in for any part of it.
- Everything a reader *derives* from a Conversation — the change under review, the fork point —
  is derived from the whole of it, never from the part a summary left visible.
- A recorded state change is written once per transition. A step that is retried after recording
  one does not record it again: a Task that moved once must not read as having moved twice.
- Conversations recorded before events were typed are read through a documented compatibility
  mapping rather than rewritten in place. A line of agent output from that era is presented as an
  assistant turn — an approximation, because the era did not record which channel a line came in
  on — and anything the mapping does not recognise is presented as a notice rather than dropped.

## Edge cases & failure handling

- If a Session ends unexpectedly, its recorded Conversation and last state remain available,
  and the Task can start a new Session.
- If a Session cannot be resumed, the user is told why and can start a fresh Session.

## Out of scope

- The redaction rules for shared exports, specified in [F13](./F13-collaboration-sharing.md).
- Model-authored summaries. A summary is derived from the events it covers, so it costs nothing
  and says the same thing every time it is produced; a written one can replace the text later
  without changing what a summary *is*.
- Redaction beyond this run's own credential. A recorded event has the values GateControl itself
  put in the agent's environment removed from it; a secret the agent learned somewhere else is a
  question for the export rules in [F13](./F13-collaboration-sharing.md).
- Capturing tool inputs and results. A tool call's raw input can hold the contents of a file
  being written, so it is deliberately not recorded until there is a redaction rule for it
  (Principle IV).

## Related

- [F04 — Multi-Agent Orchestration](./F04-agent-orchestration.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [F13 — Collaboration & Sharing](./F13-collaboration-sharing.md)
