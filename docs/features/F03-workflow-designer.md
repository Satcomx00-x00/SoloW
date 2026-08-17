# F03 — Visual Workflow Designer & Monitor

**Status:** Draft · **Owner:** Product · **Maturity:** Core / Edge · **Last reviewed:** 2026-08-17

## Summary

A Workflow is a repeatable, multi-step process that chains Agents and human decisions
together. GateControl presents Workflows as a **visual node graph**: users design a
Workflow by arranging and connecting Steps on a canvas, and watch a live Run's progress
overlaid on that same graph. This makes complex, multi-agent processes understandable and
steerable without reading logs.

## Jobs served

- **J3 — Design a repeatable process.**
- **J4 — Watch a process unfold.**
- **J8 — Resume and recover.**

## User stories

- As a Team Lead, I want to design a process where one agent plans, another implements, and
  a third reviews, so my team runs it the same way every time.
- As a user, I want to see, as a graph, where a running Workflow currently is, so I
  understand its state instantly.
- As a Reviewer, I want a Workflow to pause at a defined point for my approval, so nothing
  proceeds without a human decision.
- As a user, I want a Workflow that was interrupted to resume from where it stopped, so I do
  not repeat completed steps or waste quota.

## Functional requirements

### Designing
- **FR-1** A user can create a Workflow as a graph of Steps on a visual canvas, adding
  Steps as nodes and connecting them with directed edges that represent transitions.
- **FR-2** Step types include at minimum: an **Agent Step** (an Agent performs an action),
  a **Gate** (waits for a human decision), a **Condition** (branches on a rule), and a
  **Fork/Join** (runs branches in parallel and recombines them).
- **FR-3** Each Agent Step references an Agent Profile and the instruction or role it plays.
- **FR-4** A user can arrange, connect, disconnect, and delete Steps directly on the canvas,
  and the canvas supports panning, zooming, and readable layout of large graphs.
- **FR-5** The designer prevents invalid graphs (for example, a Join without a matching
  Fork, or an unreachable Step) and explains why.
- **FR-6** A user can save a Workflow, version it, and reuse it across Tasks and Issues.
- **FR-7** A user can import and export a Workflow as a shareable definition.

### Running & monitoring
- **FR-8** A Task can execute a Workflow; the Workflow's Steps then drive the Task's
  progress.
- **FR-9** A Run's live status is overlaid on the Workflow graph: each Step shows whether it
  is pending, running, waiting at a Gate, completed, failed, or skipped.
- **FR-10** When a Run reaches a Gate, it pauses and requests the required human decision;
  the Run continues only after the decision is recorded.
- **FR-11** A user can inspect any Step of a Run to see its Session, Conversation, and any
  produced Diff.
- **FR-12** A user can cancel a Run, and can retry a failed Step.
- **FR-13** An interrupted Run resumes from its last completed Step rather than restarting
  (see [NFR-1 in Product Requirements](../product/03-product-requirements.md)).

## Non-functional requirements

- **NFR-1** The live graph reflects Run progress in near real time.
- **NFR-2** Large Workflows (many Steps and branches) remain legible and navigable.
- **NFR-3** A Run's progress and decisions are durably recorded so the Run can resume after
  an interruption and its history can be reconstructed.

## States & rules

- Run states and transitions are defined in [Domain Model](../product/04-domain-model.md).
- A Gate blocks all downstream Steps until resolved; parallel branches not downstream of the
  Gate may continue.
- A Condition evaluates a defined rule and selects exactly one outgoing branch.
- A Workflow version in use by an active Run is immutable for that Run; editing produces a
  new version.

## Edge cases & failure handling

- If a Step fails, the Run pauses at that Step and surfaces the reason; the user can retry
  the Step, skip it (if allowed), or cancel the Run.
- If a Gate is never resolved, the Run remains paused and is clearly shown as waiting on a
  human, and can be reassigned or cancelled.
- If an Agent Step exhausts a subscription quota, the Step parks and the Run waits, matching
  Task Parked behaviour in [F06](./F06-authentication-billing.md).

## Out of scope

- The internal engine that guarantees durability and resumption (an architecture concern;
  see [Decision 0004](../decisions/0004-durable-orchestration-engine.md)).
- The specific visual styling of the canvas (owned by Design).

## Related

- [F02 — Kanban Task Administration](./F02-kanban-task-administration.md)
- [F04 — Multi-Agent Orchestration](./F04-agent-orchestration.md)
- [F10 — Review & Approval](./F10-review-approval.md)
- [Decision 0007 — ReactFlow for Workflow visualisation](../decisions/0007-reactflow-workflow-visualisation.md)
- [Decision 0004 — Durable orchestration engine](../decisions/0004-durable-orchestration-engine.md)
