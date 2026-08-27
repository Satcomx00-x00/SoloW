# 0004 — Use a durable orchestration engine for Workflows and Tasks

**Status:** Accepted · **Date:** 2026-08-17 · **Deciders:** Architecture

## Context

Multi-step Workflows and long Tasks must survive interruptions, pause cleanly for human
decisions (Gates), retry failed steps, and resume from where they stopped rather than
restarting. Building these guarantees by hand is error-prone. A durable-execution engine
provides them as first-class capabilities. The chosen engine runs locally as well as hosted,
which fits the one-product goal.

## Decision

Build orchestration on a **durable-execution engine** that provides recorded progress,
retries, and human-in-the-loop waits. Human Gates are modelled as first-class waits; every
significant state change is recorded so Runs and Tasks can resume and be reconstructed.

## Considered options

- **Hand-built orchestration** (the common approach) — Rejected as the baseline: reimplements
  durability, retries, and human-wait handling, which is exactly where correctness is hard.
- **A heavyweight enterprise workflow platform** — Rejected: powerful but too operationally
  heavy for a local-first product.
- **A durable engine that runs local-first and hosted (chosen)** — provides durability,
  retries, and human gates while still running on a single machine.

## Consequences

- Positive: interrupted Workflow Runs and Tasks resume instead of restarting (product NFR-1);
  human Gates are reliable; failures retry cleanly.
- Positive: agent-chaining Workflows map naturally onto the engine's step model.
- Negative: adds a dependency to the local-first story; resumption correctness for partially
  completed steps must be validated (risk R-4).
- Realises the [durability cross-cutting concept](../architecture/08-crosscutting-concepts.md)
  and [F03](../features/F03-workflow-designer.md).

## Implementation status (2026-08-20)

The engine now actually receives and executes: the orchestrator's `/api/inngest` endpoint
(`apps/orchestrator/src/inngest/serve.ts`, `inngest/bun`'s `serve()`) is what the local Inngest
Dev Server (`bunx inngest-cli dev`, started by `scripts/dev.sh`) polls to discover
`taskRun`, and `/events` (`apps/orchestrator/src/inngest/events.ts`) is what turns the
application's `emit()` POSTs into real `inngest.send()` calls. Previously neither endpoint
existed, so events emitted by the application had nowhere to go and no Task or Workflow step
ever actually ran — this closes that gap without changing `task-run.ts`'s own logic.
