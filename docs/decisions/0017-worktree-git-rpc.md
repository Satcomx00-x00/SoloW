# 0017 — Reach a Task's worktree through a synchronous RPC on the orchestrator

**Status:** Accepted · **Date:** 2026-08-24 · **Deciders:** Product, Architecture
**Builds on:** [0002](./0002-technology-stack.md), [0011](./0011-frontend-backend-protocol.md) ·
**Enables:** [F22](../features/F22-source-control.md)

## Context

[F22](../features/F22-source-control.md) asks for an interactive source-control panel: read the
worktree's git status, stage a file, unstage it, discard it, and see the answer immediately. Two
facts decide how that is possible at all.

**The web app may not run git.** Issue #1 put every reach into the execution host behind the
`Executor` interface, and `make audit-executor-boundary` enforces it: exactly one file,
`apps/orchestrator/src/executor/local.ts`, may spawn a process or touch a file. That is not an
inconvenience to route around — it is what will let a Docker (#96) or SSH (#97) executor exist
without a second implementation of every call site.

**Nothing the web app has today can ask a question and get an answer.** `orchestrator-client.ts`
POSTs events to `/events`, which forwards them into `inngest.send()`. That is a handoff to a
durable engine — deliberately fire-and-forget, deliberately asynchronous, deliberately durable.
It is the right shape for "run this Task" and the wrong shape for "what does `git status` say",
which is a sub-second read a human is waiting on.

The orchestrator serves three routes: `POST /events`, `/api/inngest`, and the WebSocket upgrade.
None of them answers a question about a directory.

There is a third fact that rules out the obvious shortcut. The panel has to work **when no agent
is running** — that is the normal case for review, because the agent has finished by then. Any
design that routes through the live agent handle covers the least important half of the feature.

## Decision

Add a **synchronous, signed, workspace-scoped HTTP route on the orchestrator** for worktree
operations, and have the web app's tRPC procedures call it.

```
browser ──tRPC──▶ apps/web ──POST /worktree/git──▶ apps/orchestrator ──▶ Executor ──▶ git
```

Three things make it small rather than a new subsystem.

**1. It reuses the ticket the WebSocket already uses.** `signStreamTicket` / `verifyStreamTicket`
(`packages/core/src/stream.ts`) already mint a 60-second HMAC ticket carrying `workspaceId` and
`taskId`, precisely so the orchestrator can authorise a request without a session store. The web
app authenticates the operator as it does for every tRPC call, then signs a ticket for the Task
in question; the orchestrator verifies it and derives the Workspace from the *claims*, never from
the request body (Principle V). This is the same rule the stream channel already follows, for the
same reason.

**2. It carries operations, not paths to a shell.** The route accepts a closed union — `status`,
`stage`, `unstage`, `discard`, `branch` — with typed arguments, resolved against the Task's own
worktrees. It is not a command endpoint, and no part of a request reaches an argument vector
without having been parsed by a Zod contract first. A path is resolved and then verified to be
inside the worktree root before git sees it (F22 NFR-3).

**3. It stays on the executor side of the boundary.** The handler calls the same
`WorktreeOps`-shaped functions the lifecycle uses, which call the `Executor`. The audit stays
green because nothing about where git runs has changed — only who may ask for it.

The route is not part of `openapi.json`. It is service-to-service, like `/events`, and the
public HTTP contract is the tRPC surface the browser talks to (Decision 0011).

## Considered options

- **A synchronous route on the orchestrator (chosen).** One more route beside `/events`, the
  authorisation mechanism already in the repository, and behaviour that survives the executor
  becoming remote — because the call was always going through `Executor`.

- **Extend the WebSocket hub.** Rejected. The hub routes to a *live agent handle*: it exists to
  deliver an operator's steering or stop to a process that is running. Review happens when that
  process is gone, so this would need a second path for the case that matters most — and
  request/response over a broadcast stream means correlation ids, timeouts and a reply channel,
  which is an RPC protocol built badly rather than avoided.

- **Let the web app run git directly.** Rejected outright. It means deleting the executor-boundary
  audit or exempting a second file from it, and it makes the panel local-only forever: the moment
  a Task runs in a container or on another host, `git -C <path>` in the web process is pointing at
  a directory that is not there. The audit exists to make this failure impossible to ship, and it
  did its job here.

- **Capture more into session events and keep the panel read-only.** Rejected as the *whole*
  answer, kept as the fallback. It is genuinely good for reading — it is how the captured diff
  already survives the worktree being deleted — but a status that arrives at turn boundaries
  cannot answer a click, and staging is a write with no event shape that makes sense as "the
  agent said so".

- **Request/reply through Inngest.** Rejected. The durable engine's guarantees — retries,
  replay, steps that survive a restart — are exactly wrong for a read a human is waiting 80ms
  for, and a replayed `git status` step returning a memoized answer would be a panel showing the
  past with total confidence.

## Consequences

- Positive: the panel works for a finished Task, a parked Task and a failed Task — every state
  where someone actually reviews — because it does not depend on an agent being alive.
- Positive: no new capability in `apps/web`. It gains a client, not a filesystem.
- Positive: the same route serves the file tree (#68) and the read-only editor (#67) when they
  arrive. Both need "read something out of a worktree" and neither now needs its own answer.
- Positive: remote executors inherit it. The driver changes; the route does not.
- Negative: a fourth surface to reason about, after tRPC/OpenAPI, the WebSocket, and MCP. The
  constitution names the first three; this one is service-to-service and stays out of
  `openapi.json`, but it is a surface and it is now a thing that can be misused.
- Negative: the orchestrator becomes latency-sensitive. It was a background service; a slow or
  restarting orchestrator is now visible as a panel that will not load. `bun --hot` reloading it
  mid-review is no longer only the running Task's problem.
- Negative: two callers can now write to one worktree — the panel and the agent. F22's rule that
  the panel is read-only while the agent runs is what keeps that from being a race, and it is a
  rule enforced in code, not a convention.
- The ticket's 60-second TTL means a panel left open re-signs before each call rather than
  holding a long-lived credential. That is deliberate and matches the stream's behaviour.

## Out of scope

- **A general RPC surface.** This is a closed union of worktree operations. Growing it into
  "the orchestrator's API" is a decision to take deliberately, not by accretion.
- **Hunk-level operations.** F22 defers them; if they arrive, they arrive as new members of the
  union, not as a patch string a client composes.
- **Anything that writes to a remote.** Push, publish and pull belong to issue #71's integration
  strategies, behind the review gate. This route reads and stages; it does not ship.
