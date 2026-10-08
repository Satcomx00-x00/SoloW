import { z } from "zod";
import type { ExecutorKind } from "./executor-config.js";
import type { HarnessPermissionMode } from "./profile.js";

/**
 * Isolation by default (roadmap B4).
 *
 * A harness that never asks, running as the operator on the operator's own machine, can read,
 * delete or send anything the operator can. The container executor is the bound on that, so it is
 * what a new setup starts from whenever a container runtime is there to provide it. Nothing here
 * forbids the local executor: it stays a choice, made in front of `HOST_RUN_WARNING`.
 */

/**
 * `POST /executor-availability` on the orchestrator. Only the Workspace is signed — the answer is
 * about the machine the orchestrator runs on, not about any Task.
 */
export const dockerAvailabilityRequest = z.object({ ticket: z.string().min(1) });
export type DockerAvailabilityRequest = z.infer<typeof dockerAvailabilityRequest>;

/**
 * Whether the orchestrator can reach a Docker daemon. `available: false` is a finished answer, not
 * an error: it carries the reason so the Executors page can say why the default is Local.
 * `null` on the web side means "could not ask" (orchestrator not wired or down), which must not be
 * read as "no Docker".
 */
export const dockerAvailabilityReport = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
});
export type DockerAvailabilityReport = z.infer<typeof dockerAvailabilityReport>;

/** The kind a new Executor Profile starts as: the container when there is one, else the host. */
export function preferredExecutorKind(dockerAvailable: boolean): ExecutorKind {
  return dockerAvailable ? "docker" : "local";
}

/**
 * Whether this pairing is the dangerous one: an unattended harness with the operator's own
 * account behind it. `local` is the only kind that shares the orchestrator's host and uid; ssh and
 * cloud run elsewhere and are bounded by that machine, not by this check.
 */
export function runsUnattendedOnHost(
  executorKind: ExecutorKind | null | undefined,
  permissionMode: HarnessPermissionMode | null | undefined,
): boolean {
  return executorKind === "local" && permissionMode === "bypassPermissions";
}

export const HOST_RUN_WARNING_TITLE = "This run is not isolated";

export const HOST_RUN_WARNING =
  "The local executor runs the harness as you, on this machine, and “never ask” means it " +
  "will not stop before it acts. Anything your account can read, change or send, a harness that " +
  "has been prompt-injected by an issue or a web page can too. Use it only for agents you trust; " +
  "prefer a Docker executor, or a permission mode that asks.";

/** One line for places too small for the full warning. */
export const LOCAL_EXECUTOR_NOTE = "Local runs as you, on this machine — for trusted agents only.";

/**
 * Which profiles a Quick task runs with, since it asks for neither (roadmap E2): the Owner's
 * stored defaults; failing that, the oldest Harness Profile, and a Docker executor when there is
 * one (isolation by default, as above) or else the oldest. One rule for the server, which applies
 * it, and the dialog, which shows the host-run warning for what it will pick. The lists may come
 * in any order: the oldest is chosen by `createdAt`, never by position.
 */
export function quickTaskProfiles(args: {
  /** Already checked to still exist; null when nothing is stored. */
  stored: { harnessProfileId: string | null; executorProfileId: string | null } | null;
  harnesses: ReadonlyArray<{ id: string; createdAt: string }>;
  executors: ReadonlyArray<{ id: string; kind: ExecutorKind; createdAt: string }>;
}): { agentProfileId: string | null; executorProfileId: string | null } {
  const oldest = <T extends { id: string; createdAt: string }>(rows: readonly T[]): T | undefined =>
    [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  return {
    agentProfileId: args.stored?.harnessProfileId ?? oldest(args.harnesses)?.id ?? null,
    executorProfileId:
      args.stored?.executorProfileId ??
      oldest(args.executors.filter((x) => x.kind === "docker"))?.id ??
      oldest(args.executors)?.id ??
      null,
  };
}
