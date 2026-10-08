import type { DockerAvailabilityReport } from "@solow/contracts";
import { orchestratorEnv } from "../env.js";
import type { Executor } from "./types.js";

/**
 * Whether this host can run the container executor at all (roadmap B4).
 *
 * One question, the cheapest one: does `docker version` reach a *server*. The full preflight
 * (`preflight.ts`) asks much more, but it needs a Profile and a Task's paths; this runs before
 * either exists, to choose what a new Executor Profile starts as. A "no" here is a statement
 * about the default, never a refusal — the Executors page still lets the operator pick Docker.
 *
 * Lives in the executor module because it composes `docker` argv, which the boundary audit allows
 * nowhere else.
 */
export async function probeDockerAvailability(
  host: Executor,
  dockerBin: string = orchestratorEnv().SOLOW_DOCKER_BIN,
): Promise<DockerAvailabilityReport> {
  try {
    // Raced, because `exec` has no deadline of its own and a wedged daemon answers never.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const res = await Promise.race([
      host.exec([dockerBin, "version", "--format", "{{.Server.Version}}"]),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("docker did not answer within 5s")), 5_000);
      }),
    ]).finally(() => clearTimeout(timer));
    if (res.exitCode === 0 && res.stdout.trim() !== "") return { available: true, reason: null };
    const said = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
    return { available: false, reason: said || `${dockerBin} exited ${res.exitCode}` };
  } catch (cause) {
    // A missing binary rejects (Bun.spawn raises ENOENT synchronously) rather than exiting 127.
    return { available: false, reason: cause instanceof Error ? cause.message : String(cause) };
  }
}
