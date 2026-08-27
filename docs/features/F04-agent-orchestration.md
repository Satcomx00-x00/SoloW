# F04 — Multi-Agent Orchestration

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-17

## Summary

SoloW drives many different AI coding-agent command-line tools through a single,
standard protocol, and runs many of them at once. This lets users choose the best agent for
each Task and parallelise work without integrating each agent individually.

## Jobs served

- **J1 — Parallelise safely.**
- **J7 — Offload heavy work.**

## User stories

- As a Solo Power User, I want to run several agents at the same time, so I get more done
  in parallel.
- As a user, I want to choose which agent tool runs a Task, so I can use the one best suited
  to the work.
- As a user, I want a consistent way to start, watch, steer, and stop any agent, regardless
  of which tool it is.

## Functional requirements

- **FR-1** SoloW connects to Agents through a single open standard protocol (the
  Agent Client Protocol), so many different agent tools are supported through one
  mechanism.
- **FR-2** A user can select which Agent (via an Agent Profile) runs a given Task or
  Workflow Step.
- **FR-3** SoloW can run multiple Agents concurrently, each in its own Session and
  Worktree, bounded by concurrency limits.
- **FR-4** For each Session, the user can view the Agent's live activity, send input, and
  stop the Agent.
- **FR-5** SoloW surfaces an Agent's requests for tool use and, where the Agent
  Profile requires it, holds them for human approval before they proceed.
- **FR-6** SoloW reports each Agent's status (starting, working, awaiting input,
  awaiting review, finished, failed) uniformly across agent tools.
- **FR-7** Newly supported agents can be made available by adding an Agent Profile, without
  changing how the rest of the system works.

## Non-functional requirements

- **NFR-1** Adding support for an additional protocol-compliant agent requires no change to
  orchestration behaviour.
- **NFR-2** One Agent's failure does not affect other concurrently running Agents (see
  product [NFR-2](../product/03-product-requirements.md)).
- **NFR-3** Agent activity is streamed to the user with low latency.

## States & rules

- Each running Agent is bound to exactly one Session and one Worktree per Repository.
- An Agent's Authentication Mode and concurrency limit come from its Agent Profile (see
  [F05](./F05-agent-executor-profiles.md), [F06](./F06-authentication-billing.md)).
- Tool-use approval policy is defined per Agent Profile and enforced during the Session.

## Edge cases & failure handling

- If an Agent tool is not installed or reachable in the chosen Executor, the Task fails with
  a clear, actionable reason.
- If an Agent stops responding, SoloW marks the Session as failed and allows retry.
- If concurrency is saturated, additional Agents queue rather than overcommitting resources.

## Out of scope

- The internal details of the connection protocol (an architecture concern; see
  [Decision 0003](../decisions/0003-agent-connection-protocol.md)).
- Billing and quota handling, specified in [F06](./F06-authentication-billing.md).

## Related

- [F05 — Agent & Executor Profiles](./F05-agent-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [Decision 0003 — Agent connection protocol (ACP)](../decisions/0003-agent-connection-protocol.md)
