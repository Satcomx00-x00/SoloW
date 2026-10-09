# F04 — Multi-Harness Orchestration

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-10-09

## Summary

SoloW drives AI coding harness command-line tools through a small set of protocols, and runs
many of them at once. This lets users choose the harness for each Task and parallelise work
without SoloW integrating each harness individually.

**Two harnesses come ready to use: Claude Code and opencode.** They are the two entries every
Workspace starts with in its harness catalog. Any other harness must be added by hand, under
Settings → Harnesses → "Add a custom harness": a command, its arguments, the protocol it speaks,
and the two credential variable names the billing guard sets and strips. A harness that speaks
the Agent Client Protocol (ACP) needs nothing more; one that speaks no supported protocol can
only be driven as a plain command line given the brief as an argument, with no tools, no
permission requests and no model choice. No other harness ships with a tested entry. Shipping ready-made entries
for the next most-used harnesses is planned for after 1.0 ([Roadmap](../ROADMAP.md)).

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

- **FR-1** SoloW connects to Harnesses through one of three protocols, named on the harness's
  catalog entry: the open Agent Client Protocol (ACP, used by opencode and any ACP-speaking
  harness), Claude Code's own streaming JSON mode (used by Claude Code), and a plain command
  line for a harness that speaks neither.
- **FR-2** A user can select which Harness (via a Harness Profile) runs a given Task or
  Workflow Step.
- **FR-3** SoloW can run multiple Harnesses concurrently, each in its own Session and
  Worktree, bounded by concurrency limits.
- **FR-4** For each Session, the user can view the Harness's live activity, send input, and
  stop the Harness.
- **FR-5** SoloW surfaces a Harness's requests for tool use and holds them for human approval
  before they proceed. Only a harness on ACP can ask mid-run; a request nobody answers within
  two minutes is refused. Claude Code has no such channel: it decides for itself under the
  permission mode its Harness Profile sets.
- **FR-6** SoloW reports each run's state the same way whichever harness tool runs it: the
  Task reads Running, Review, Parked, Failed or Done, and the Session's transcript shows what
  the harness is doing.
- **FR-7** A further harness is made available by adding a harness catalog entry and a Harness
  Profile that points at it, without changing how the rest of the system works. Only Claude
  Code and opencode have entries out of the box.

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
- If a Harness exits with an error, the Task moves to Failed with the reason and can be
  retried. There is no idle timeout: a harness that hangs without exiting runs until the user
  stops it. A run lost with its service is found by a sweep and shown among the runs needing
  attention.
- If a Harness Profile's concurrency cap is reached, a further start is refused with a
  plain-language message and the Task stays where it was; there is no queue that starts it
  later. (A Parked run waking with its Profile full is the one exception: it waits and asks
  again, see [F06](./F06-authentication-billing.md).)

## Out of scope

- The internal details of the connection protocol (an architecture concern; see
  [Decision 0003](../decisions/0003-agent-connection-protocol.md)).
- Billing and quota handling, specified in [F06](./F06-authentication-billing.md).

## Related

- [F05 — Harness & Executor Profiles](./F05-harness-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F11 — Sessions & Conversations](./F11-sessions-conversations.md)
- [Decision 0003 — Harness connection protocol (ACP)](../decisions/0003-agent-connection-protocol.md)
