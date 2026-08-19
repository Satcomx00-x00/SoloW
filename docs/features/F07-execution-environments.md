# F07 — Execution Environments

**Status:** Draft · **Owner:** Product · **Maturity:** Core · **Last reviewed:** 2026-08-19

## Summary

An Executor is where an Agent actually runs. GateControl supports several execution
environments so users can run agents locally for convenience or offload heavy work to
containers, remote machines, or the cloud — all managed from the same control plane.

## The `Executor` interface (issue #1)

Before a second Executor kind exists, GateControl adopted one interface every kind implements —
`apps/orchestrator/src/executor/types.ts`:

```ts
interface Executor {
  spawn(cmd: string[], opts: SpawnOpts): ProcessHandle; // long-lived agent process
  exec(cmd: string[], opts?: ExecOpts): Promise<ExecResult>; // one-shot: git, du, version probes
  fs: ExecutorFs; // list, read, write, copy — root-jailed
  forward(port: number): Promise<ForwardHandle>; // dev-server preview
  metrics(): Promise<ExecutorMetrics>; // cpu, mem, disk, load
  dispose(): Promise<void>;
}
```

`apps/orchestrator/src/executor/local.ts` — the Local Executor — is the first and, until #46/#47
land, only implementation, and the one module in the orchestrator allowed to call `Bun.spawn`,
the Bun shell, or touch the host filesystem directly
(`scripts/audit-executor-boundary.ts` enforces the boundary). Everything that reaches into the
place an agent runs goes through it instead of a call of its own:

- The **agent runner** (`apps/orchestrator/src/agent/claude-code-runner.ts`) launches the
  `claude` CLI via `executor.spawn` — `packages/claude-code`'s `startClaudeSession` never spawns
  a process itself, it takes a `SpawnFn` the caller supplies.
- The **worktree manager and diff reader** (`apps/orchestrator/src/worktree/manager.ts`) run
  every `git` invocation via `executor.exec` instead of a `Bun.spawn`/shell call of its own.

Two properties every implementation must hold:

- **`fs` is root-jailed.** Path resolution happens once, in the executor, and every consumer
  inherits it — the highest path-traversal risk surface in the product (#33 file tree, #52
  `.env` copy).
- **`spawn` takes the environment verbatim.** It replaces the child's environment rather than
  merging it with the executor's own, so the one credential the billing guard shaped is all an
  agent process ever sees (Principle IV).

A second Executor kind (Container #46, Remote SSH #47, Cloud #48) is a new file implementing
this interface — a driver, not a second copy of "how do I reach the place the agent runs".

## Jobs served

- **J7 — Offload heavy work.**

## User stories

- As a Solo Power User, I want agents to run on my own machine by default, so setup is
  trivial.
- As a user, I want to run a resource-heavy Task in a container, so it does not slow my
  machine.
- As an Operator, I want agents to run on a designated remote host, so compute is where it
  should be.

## Functional requirements

- **FR-1** GateControl supports these Executor types: **Local** (a process on the host),
  **Container** (an isolated container), **Remote** (an SSH-connected host), and **Cloud**
  (a cloud runner).
- **FR-2** A user configures an Executor as an Executor Profile (see [F05](./F05-agent-executor-profiles.md))
  and selects it per Task.
- **FR-3** Each Executor type runs the same Agents and produces the same Session behaviour,
  so the choice of Executor does not change how a Task is used or reviewed.
- **FR-4** Subscription and API-key credentials are made available to Agents in every
  Executor type without exposing them to Agent-run code (see [F06](./F06-authentication-billing.md),
  [F17](./F17-security-secrets.md)).
- **FR-5** GateControl reports Executor health and availability, and prevents launching a
  Task on an unavailable Executor with a clear reason.
- **FR-6** A Worktree is provisioned inside the chosen Executor so file isolation holds
  regardless of environment (see [F08](./F08-workspaces-repositories.md)).

## Non-functional requirements

- **NFR-1** Adding or removing an Executor does not affect Tasks running on other Executors.
- **NFR-2** Remote and container Executors are usable without a human logging in interactively
  on the target machine.
- **NFR-3** Cloud execution is optional and never required for the product to function
  (see product [NFR-14](../product/03-product-requirements.md)).

## States & rules

- Executor availability is monitored; a Task queues or fails clearly if its Executor is
  unavailable.
- The Executor type is transparent to review: the same diff, terminal, and preview
  experience applies everywhere.

## Edge cases & failure handling

- If a Remote host becomes unreachable mid-run, the affected Session fails with a clear
  reason and can be retried, without affecting other Executors.
- If a Container cannot be provisioned, the Task fails before starting the Agent, with an
  actionable message.

## Out of scope

- The internal mechanics of container, SSH, and cloud provisioning (architecture concerns).
- Cost of third-party cloud compute (owned by the provider).

## Related

- [F05 — Agent & Executor Profiles](./F05-agent-executor-profiles.md)
- [F06 — Authentication & Billing Modes](./F06-authentication-billing.md)
- [F08 — Worktrees & Repositories](./F08-workspaces-repositories.md)
