# F04 — Multi-Harness Orchestration

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

SoloW drives many different AI coding harness command-line tools through a single,
standard protocol, and runs many of them at once. This lets users choose the best harness for
each Task and parallelise work without integrating each harness individually.

## Jobs served

- **J1 — Parallelise safely.**
- **J7 — Offload heavy work.**

## User stories

- As a Solo Power User, I want to run several harnesses at the same time, so I get more done
  in parallel.
- As a user, I want to choose which harness tool runs a Task, so I can use the one best suited
  to the work.
- As a user, I want a consistent way to start, watch, steer, and stop any harness, regardless
  of which tool it is.

## Functional requirements

- **FR-1** SoloW connects to Harnesses through a single open standard protocol (the
  Agent Client Protocol), so many different harness tools are supported through one
  mechanism.
- **FR-2** A user can select which Harness (via a Harness Profile) runs a given Task or
  Workflow Step.
- **FR-3** SoloW can run multiple Harnesses concurrently, each in its own Session and
  Worktree, bounded by concurrency limits.
- **FR-4** For each Session, the user can view the Harness's live activity, send input, and
  stop the Harness.
- **FR-5** SoloW surfaces a Harness's requests for tool use and, where the Harness
  Profile requires it, holds them for human approval before they proceed.
- **FR-6** SoloW reports each Harness's status (starting, working, awaiting input,
  awaiting review, finished, failed) uniformly across harness tools.
- **FR-7** Newly supported harnesses can be made available by adding a Harness Profile, without
  changing how the rest of the system works.

## Non-functional requirements

- **NFR-1** Adding support for an additional protocol-compliant harness requires no change to
  orchestration behaviour.
- **NFR-2** One Harness's failure does not affect other concurrently running Harnesses (see
  product [NFR-2](../product/03-product-requirements.md)).
- **NFR-3** Harness activity is streamed to the user with low latency.

## States & rules

- Each running Harness is bound to exactly one Session and one Worktree per Repository.
- A Harness's Authentication Mode and concurrency limit come from its Harness Profile (see
  [F05](./F05-harness-executor-profiles.md), [F06](./F06-authentication-billing.md)).
- Tool-use approval policy is defined per Harness Profile and enforced during the Session.

## Edge cases & failure handling

- If a Harness tool is not installed or reachable in the chosen Executor, the Task fails with
  a clear, actionable reason.
- If a Harness stops responding, SoloW marks the Session as failed and allows retry.
- If concurrency is saturated, additional Harnesses queue rather than overcommitting resources.

## Out of scope

- The internal details of the connection protocol (an architecture concern; see
  [Decision 0003](../decisions/0003-agent-connection-protocol.md)).
- Billing and quota handling, specified in [F06](./F06-authentication-billing.md).

## Related

- [F05 — Harness & Executor Profiles](./F05-harness-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [Decision 0003 — Harness connection protocol (ACP)](../decisions/0003-agent-connection-protocol.md)
