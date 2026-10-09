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
 * The image the guided setup runs Claude in, unless the operator names another with
 * `SOLOW_EXECUTOR_IMAGE` on the orchestrator. Built from `docker/executor/Dockerfile` by
 * `make executor-image` or `solow executor-image`, which tag it with this name.
 *
 * A local tag, not a registry one: nothing pulls it, so a fresh machine has it only once someone
 * built it there — which is why the setup asks the daemon whether it exists before choosing it.
 * `packages/cli/bin/solow.mjs` cannot import this file and spells the same name; a test there
 * keeps the two in step.
 */
export const DEFAULT_EXECUTOR_IMAGE = "solow-executor:local";

/**
 * Whether the orchestrator can reach a Docker daemon. `available: false` is a finished answer, not
 * an error: it carries the reason so the Executors page can say why the default is Local.
 * `null` on the web side means "could not ask" (orchestrator not wired or down), which must not be
 * read as "no Docker".
 *
 * `executorImage` is the image a container needs a harness in, and whether the daemon already has
 * it. Only a local copy counts: the preflight would pull a missing one, but a local tag cannot be
 * pulled, and a setup that chose a container on the strength of a pull that will fail would trade
 * the host-run warning for a Task that never starts. `present` is false whenever Docker is not
 * available, since nothing could be asked.
 */
export const dockerAvailabilityReport = z.object({
  available: z.boolean(),
  reason: z.string().nullable(),
  executorImage: z.object({ name: z.string().min(1), present: z.boolean() }),
});
export type DockerAvailabilityReport = z.infer<typeof dockerAvailabilityReport>;

/** The image a new container executor can use right now, or null when there is none to use. */
export function usableExecutorImage(
  report: DockerAvailabilityReport | null | undefined,
): string | null {
  return report?.available && report.executorImage.present ? report.executorImage.name : null;
}

/** The kind a new Executor Profile starts as: the container when there is one, else the host. */
export function preferredExecutorKind(dockerAvailable: boolean): ExecutorKind {
  return dockerAvailable ? "docker" : "local";
}

/**
 * Where "Connect Claude" puts Claude (roadmap B4, E1). One rule for the server, which acts on it,
 * and the setup screen, which says what it will do before the Owner presses Connect.
 *
 * - No executor yet: the isolated container when its image is there, else this machine.
 * - The setup's own local executor, in a Workspace with no container executor at all
 *   (`replaceable`): moved into the container once the image exists. This is the newcomer who
 *   connected first and built the image afterwards; re-running the setup is how they get the
 *   isolation they were told about. The local executor is left in place, not removed.
 * - Anything else is kept. An executor the Owner made, or a local one kept as the default while a
 *   container executor exists, is a choice someone made, and the setup does not overrule it.
 */
export type SetupExecutorPlan =
  | { action: "keep" }
  | { action: "create"; kind: "docker"; image: string }
  | { action: "create"; kind: "local" };

export function setupExecutorPlan(args: {
  /** The executor a new Task gets now (`quickTaskProfiles`), or null when there is none. */
  current: { kind: ExecutorKind; replaceable: boolean } | null;
  /** `usableExecutorImage`'s answer. */
  isolatedImage: string | null;
}): SetupExecutorPlan {
  const { current, isolatedImage } = args;
  if (current && !(current.replaceable && isolatedImage)) return { action: "keep" };
  return isolatedImage
    ? { action: "create", kind: "docker", image: isolatedImage }
    : { action: "create", kind: "local" };
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
