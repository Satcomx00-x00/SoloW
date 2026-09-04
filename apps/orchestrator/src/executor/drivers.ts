import type { ExecutorKind } from "@solow/contracts";

/**
 * Which Executor kinds actually have a driver behind them (issue #73).
 *
 * The configuration union names four kinds because that is what makes the matrix additive — a
 * new runtime is a union member plus a driver, never a migration. But a *configurable* kind is
 * not a *runnable* one: #97 (SSH) and #107 (Kubernetes) are still configurable ahead of their
 * drivers, and a Task pointed at either fails here.
 *
 * Without this check a Task pointed at such a profile would run on the orchestrator's own host
 * and report success — the user asked for isolation and silently did not get it. Failing the
 * Task with a legible reason is the only honest answer. Adding a driver means adding its kind
 * here, and the list is deliberately separate from the union so forgetting is a visible failure
 * rather than a wrong execution host.
 *
 * `"docker"` was added **last** in #96, after the lifecycle actually built the Task's executor
 * from its profile. Widening this list first would have reproduced, exactly, the failure it was
 * written to prevent: the gate opens, nothing downstream reads the kind, and the container the
 * operator asked for is a container nobody ever created.
 */
export const AVAILABLE_EXECUTOR_KINDS: readonly ExecutorKind[] = ["local", "docker"];

export function hasDriver(kind: ExecutorKind): boolean {
  return AVAILABLE_EXECUTOR_KINDS.includes(kind);
}

/** A failure reason legible on the board, not a stack trace. */
export function missingDriverReason(kind: ExecutorKind): string {
  return `no executor driver for kind "${kind}" — this SoloW build can only run ${AVAILABLE_EXECUTOR_KINDS.join(", ")}`;
}
