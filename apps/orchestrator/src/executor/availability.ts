import type { DockerAvailabilityReport } from "@solow/contracts";
import { orchestratorEnv } from "../env.js";
import type { ExecResult, Executor } from "./types.js";

/**
 * Whether this host can run the container executor at all (roadmap B4), and whether it already has
 * the image a container needs a harness in.
 *
 * Two questions, the cheapest ones: does `docker version` reach a *server*, and does
 * `docker image inspect` find the executor image there. The full preflight (`preflight.ts`) asks
 * much more, but it needs a Profile and a Task's paths; this runs before either exists, to choose
 * what a new Executor Profile starts as and where the guided setup puts Claude. A "no" here is a
 * statement about the default, never a refusal — the Executors page still lets the operator pick
 * Docker.
 *
 * The image is looked up and never pulled: the default is a local tag no registry has, and an
 * availability check that could spend minutes downloading is not one anybody would wait for.
 *
 * Lives in the executor module because it composes `docker` argv, which the boundary audit allows
 * nowhere else.
 */
export async function probeDockerAvailability(
  host: Executor,
  dockerBin: string = orchestratorEnv().SOLOW_DOCKER_BIN,
  image: string = orchestratorEnv().SOLOW_EXECUTOR_IMAGE,
): Promise<DockerAvailabilityReport> {
  const absent = { name: image, present: false };
  try {
    const res = await answered(host, [dockerBin, "version", "--format", "{{.Server.Version}}"]);
    if (res.exitCode !== 0 || res.stdout.trim() === "") {
      const said = (res.stderr || res.stdout).trim().split("\n")[0] ?? "";
      return {
        available: false,
        reason: said || `${dockerBin} exited ${res.exitCode}`,
        executorImage: absent,
      };
    }
  } catch (cause) {
    // A missing binary rejects (Bun.spawn raises ENOENT synchronously) rather than exiting 127.
    return {
      available: false,
      reason: cause instanceof Error ? cause.message : String(cause),
      executorImage: absent,
    };
  }

  try {
    const found = await answered(host, [
      dockerBin,
      "image",
      "inspect",
      image,
      "--format",
      "{{.Id}}",
    ]);
    return {
      available: true,
      reason: null,
      executorImage: { name: image, present: found.exitCode === 0 },
    };
  } catch {
    // The daemon answered a moment ago, so this is a blip about the image rather than a verdict on
    // Docker: report it as not there, which keeps the setup on the host with its warning.
    return { available: true, reason: null, executorImage: absent };
  }
}

/** Raced, because `exec` has no deadline of its own and a wedged daemon answers never. */
async function answered(host: Executor, argv: string[]): Promise<ExecResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    host.exec(argv),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("docker did not answer within 5s")), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));
}
