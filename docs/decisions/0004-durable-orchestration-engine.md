# 0004 — Use a durable orchestration engine for Workflows and Tasks

**Status:** Accepted, amended by [0030](./0030-review-gate-is-a-database-state.md) · **Date:** 2026-08-17 · **Deciders:** Architecture

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
- Positive: harness-chaining Workflows map naturally onto the engine's step model.
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

## Amendment: self-hosted production mode, signed (2026-10)

The launchers (`scripts/dev.sh`, `scripts/start.sh`, `packages/cli`) no longer run the Inngest
Dev Server (`inngest dev`, which its own banner calls "not a production deployment"). They run
`inngest start`, the self-hosted edition of the same binary (inngest-cli 1.45, SDK 4.18), with
SQLite persistence under `.solow/inngest` and two generated keys:

- `INNGEST_SIGNING_KEY`: the engine signs its calls to `/api/inngest` and the SDK rejects
  anything unsigned. Verified: an unsigned register or invoke is refused (401).
- `INNGEST_EVENT_KEY`: `inngest start` accepts events only with this key. Verified: a wrong key
  gets 401, the right one 200.

The SDK is switched out of dev mode by unsetting `INNGEST_DEV` and pointing `INNGEST_BASE_URL`
at the local engine. Keys reach the engine through its environment, not argv, so they stay out
of `ps`. They are generated once into `.solow/` (0600); exported values win.

The web app also authenticates to the orchestrator's `POST /events` with
`Authorization: Bearer $SOLOW_ORCHESTRATOR_SECRET`. Without a configured secret the route
refuses everything (503), so a missing launcher setting cannot silently open it.

Limits that remain: `inngest start --host` moves the API listener only. The connect gateway
(:8289) and the gRPC ports (:50052, :50053) bind all interfaces and have no bind flag in 1.45;
they are not used by SoloW (it serves functions over HTTP), but should be firewalled when the
machine is reachable from a network. `inngest start` keeps its queue in an in-process Redis
with periodic snapshots, so a crash can lose the last few seconds of queue state; acceptable
for a single user, and an external `--redis-uri` / `--postgres-uri` is the upgrade path.

## Review (2026-10-09)

The one-month review ([Conventions](../CONVENTIONS.md#maintenance)), held late, against the code
at version 0.21.0.

**Verdict: holds, as amended.** Two changes since acceptance, both recorded:
[0030](./0030-review-gate-is-a-database-state.md) took human Gates out of the engine (a gate is a
database state, and a decision starts the next run), and the amendment above moved the launchers
from the Dev Server to the signed, self-hosted `inngest start`. Runs, retries and the five-hour
quota park (`step.sleepUntil` in `task-run/terminal.ts`) still rely on the engine. Risk R-4 is
real and handled outside it: sweeps in `apps/orchestrator/src/reconcile.ts` find runs the engine
lost (orphaned, stranded at review, parked and never woken).
