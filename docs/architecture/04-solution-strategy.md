# 4. Solution Strategy

**Status:** Draft · **Owner:** Architecture · **Last reviewed:** 2026-08-17

This section states the core approach — the handful of decisions that shape everything else.
Each is expanded in the [Decision Log](../decisions/README.md).

## Strategy 1 — Separate the interactive application from a long-lived orchestrator

Agents are long-running external processes that must be held open, supervised, and streamed
back to the user (constraint C-7). A request/response-only surface cannot do this. Therefore
the system is split into an **interactive application** (Boards, Issues, Workflows, review,
data) and a **long-lived orchestration component** (launches agents, holds their processes,
manages working copies, streams activity). The two share state and communicate continuously.
→ [Decision 0002](../decisions/0002-technology-stack.md)

## Strategy 2 — Integrate agents through one standard protocol

Rather than integrating each agent tool bespoke, GateControl connects to all of them through
a single open standard (the Agent Client Protocol). Adding a new agent is a configuration
act, not an engineering one. → [Decision 0003](../decisions/0003-agent-connection-protocol.md)

## Strategy 3 — Make orchestration durable and resumable

Multi-step Workflows and long Tasks must survive interruption and pause cleanly for human
decisions. GateControl uses a durable orchestration engine so progress is recorded, human
gates are first-class waits, and interrupted work resumes from its last completed step rather
than restarting. → [Decision 0004](../decisions/0004-durable-orchestration-engine.md)

## Strategy 4 — Isolate every Task in its own working copy

Parallel safety is structural: each Task gets its own Git working copy per Repository, so
concurrent agents cannot collide. Multi-repository Tasks are a natural extension of this.
→ [F08](../features/F08-workspaces-repositories.md)

## Strategy 5 — Portable, credential-safe billing modes

Billing mode is a property of an Agent Profile. Subscription mode uses a portable credential
that works across all execution environments; the orchestrator guarantees a subscription
agent is never run in a way that causes metered billing, and never exposes credentials to
agent-run code. → [Decision 0005](../decisions/0005-subscription-authentication.md)

## Strategy 6 — One data model, two stores

The same conceptual data model backs both deployments: a lightweight embedded store for
local use and a shared database for hosted use, chosen by configuration.
→ [Decision 0008](../decisions/0008-data-store-strategy.md)

## Strategy 7 — Visual, node-graph Workflows

Workflows are designed and monitored as an interactive node graph, making complex,
multi-agent processes understandable at a glance and steerable in real time.
→ [Decision 0007](../decisions/0007-reactflow-workflow-visualisation.md)

## How the strategies combine

The application gives people a clear surface; the orchestrator does the durable, long-lived
work; the standard protocol keeps agents interchangeable; per-Task isolation keeps
parallelism safe; the billing-mode strategy keeps cost trustworthy; and one data model spans
both deployment modes. Together they deliver the [architectural goals](./01-introduction-and-goals.md).
