# 0030 — A review gate is a database state, and a decision starts the next run

**Status:** Accepted · **Date:** 2026-10-08 · **Deciders:** Architecture
**Amends:** [0004](./0004-durable-orchestration-engine.md) · **Affects:** [F03](../features/F03-workflow-designer.md), [F10](../features/F10-review-approval.md)

## Context

[0004](./0004-durable-orchestration-engine.md) modelled a human gate as a first-class wait: the
Task's run parked in the engine until a `review.decided` event matched it, then carried on. On a
real Workspace, a Spec Kit Task launched six times showed what that costs:

- **Decisions published to nothing.** The local engine loses parked waits when it restarts. The
  decision was recorded, the event went nowhere, and the gate kept its Approve button: one person
  clicked it twenty times in a minute. A stack of compensations grew around this — a sweep that
  stamps "decision not applied", a reaper exception for it, a dev-only path that guessed whether a
  run was parked — and none of them could deliver the decision.
- **Several runs on one Task.** A gate that looked dead was relaunched, and a launch from `review`
  started a second run beside the one still waiting. One Task had seven live runs, three of them
  running the same Step at once, each moving the cursor the others read.
- **Steps that never read their brief.** Unrelated to the gate, but found in the same logs: after
  any relaunch, a Step boundary resumed an earlier Session's conversation instead of briefing the
  new Step, so Plan, Tasks, Analyze, Implement and Verify each returned Clarify's summary in half a
  minute.

## Decision

1. **A run ends when it opens a gate.** It records the completion and the diff, sets the Task to
   `review` (under a Workflow) and returns. The gate is the database row and nothing else.
2. **A decision is a conditional write, then a run.** `review.decide` moves the Task `review →
   running` only if it is still in `review`, records the `review` row, and sends
   `task.launch.requested` carrying the decision. Losing the write means the gate was already
   decided. If the event cannot be sent, the row is removed and the gate is put back.
3. **The run a decision starts applies it first**, from the database: the declaration recorded at
   the gate, the worktrees recorded on disk. It takes the decision up with one conditional write
   (`review.applied_at`), so a redelivered event finds it spent and leaves.
4. **One start per Task.** Every start claims the Task row from the state it was read in, and a
   Task in `review` cannot be started at all — only decided. The engine adds a concurrency limit of
   one per Task for whatever reaches it anyway.
5. **A conversation belongs to its Step.** The harness's conversation id is stored with the Step
   it was briefed for, and a round only resumes a conversation from its own Step.

This is the shape approval gates take in systems that wait on people for days — GitHub Actions
environments, Argo's suspend and resume — where the pending approval is state, and approving it
schedules work, rather than a process holding a socket open for a reviewer.

## Consequences

- Positive: a decision is either applied or refused where it was clicked; no engine restart can
  lose one, and the "decision not applied" machinery has nothing left to detect.
- Positive: no executor sits idle behind a person — the run that opens a gate releases it.
- Positive: the gate has no timeout; a Task can wait for review as long as nobody looks.
- Negative: each decision pays for a run's entry again — loading, the executor preflight, and an
  idempotent re-provision of the worktrees. For a container executor that is a container start.
- Negative: runs parked at a gate by an older build are not migrated. They wait on an event that
  is no longer sent and end at their seven-day timeout; their Tasks can be decided normally.
