/// <reference path="./dockerfile.d.ts" />
import type { ExecutorImageBuildState, ExecutorImageBuildStatus } from "@solow/contracts";
import EXECUTOR_DOCKERFILE from "../../../../docker/executor/Dockerfile" with { type: "text" };
import { orchestratorEnv } from "../env.js";
import { dockerCliEnv } from "./docker.js";
import type { Executor, ProcessHandle } from "./types.js";

/**
 * The guided setup's own build of the executor image (roadmap B4): one click instead of a terminal.
 *
 * Isolation by default only reaches a newcomer once the image exists, and until this the setup's
 * answer to "Docker is here but the image is not" was a command to go and type somewhere else —
 * the step most likely to end a first fifteen minutes. This is the same build `solow
 * executor-image` and `make executor-image` run: `docker build --tag <image> -`, the Dockerfile on
 * stdin and no build context, so nothing from the machine can end up in a layer.
 *
 * **The Dockerfile has one home**, `docker/executor/Dockerfile`, imported as text: Bun reads it
 * from a checkout, and `bun build` inlines it into the published orchestrator's bundle, so neither
 * needs a copy of its own or a path that is right in one and wrong in the other. (The launcher's
 * `dist/executor/Dockerfile` is the same file, copied by `scripts/build.ts` for a script that
 * cannot import it.)
 *
 * **Single-flight and in memory.** One build per orchestrator: a second press while one runs gets
 * the running one. Nothing is persisted — a restart mid-build kills the `docker` CLI it spawned,
 * BuildKit cancels the build with its client, and the setup offers the button again; the layers
 * already built are cached, so the second attempt picks up most of the way along.
 *
 * **Built, not proved.** Unlike the launcher's command, this does not then run the harnesses in a
 * container of the new image: the setup's test runs the run's own preflight in a one-shot container
 * of it (`openOutOfBandExecutor`), which asks more than a version check would and is the thing a
 * Task actually depends on. Two checks of one image would be two answers to keep in step.
 *
 * Lives in the executor module because it composes `docker` argv, which the boundary audit allows
 * nowhere else, and spawns through the host `Executor` like every other command here.
 */

/** Long enough for a cold build on a slow line; past it, something is wrong and nobody is told. */
export const IMAGE_BUILD_TIMEOUT_MS = 30 * 60_000;
/** What the polite stop is given before the build's `docker` CLI is killed outright. */
const KILL_GRACE_MS = 10_000;
/** The newest lines kept — enough to show why a step failed, small enough to poll every second. */
export const IMAGE_BUILD_OUTPUT_LINES = 40;
/** BuildKit prints whole command lines; past this a line says nothing more a person would read. */
const MAX_LINE_LENGTH = 400;

export interface ExecutorImageBuilder {
  /** Start a build, unless one is running already; either way, where the build now is. */
  start(): ExecutorImageBuildStatus;
  status(): ExecutorImageBuildStatus;
}

export interface ExecutorImageBuilderOpts {
  /** The host `Executor` the `docker` CLI is spawned through. */
  host: Executor;
  /** `SOLOW_DOCKER_BIN` unless stated, read here so the binary is named in this module alone. */
  dockerBin?: string;
  /** The tag built: the name the availability check looks for, `SOLOW_EXECUTOR_IMAGE`. */
  image?: string;
  /** Injectable for the tests; the real one is the repository's. */
  dockerfile?: string;
  /** The `docker` CLI's own environment — `dockerCliEnv()` unless a test says otherwise. */
  env?: Record<string, string>;
  now?: () => number;
  timeoutMs?: number;
}

export function createExecutorImageBuilder(opts: ExecutorImageBuilderOpts): ExecutorImageBuilder {
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? IMAGE_BUILD_TIMEOUT_MS;
  const dockerBin = opts.dockerBin ?? orchestratorEnv().SOLOW_DOCKER_BIN;
  const image = opts.image ?? orchestratorEnv().SOLOW_EXECUTOR_IMAGE;
  let state: ExecutorImageBuildState = "idle";
  let startedAt: number | null = null;
  let finishedAt: number | null = null;
  let reason: string | null = null;
  let output: string[] = [];

  const status = (): ExecutorImageBuildStatus => ({
    image,
    state,
    startedAt: startedAt === null ? null : new Date(startedAt).toISOString(),
    finishedAt: finishedAt === null ? null : new Date(finishedAt).toISOString(),
    output: [...output],
    reason,
  });

  const keep = (line: string) => {
    const trimmed = line.trimEnd();
    if (trimmed === "") return;
    output.push(
      trimmed.length > MAX_LINE_LENGTH ? `${trimmed.slice(0, MAX_LINE_LENGTH - 1)}…` : trimmed,
    );
    if (output.length > IMAGE_BUILD_OUTPUT_LINES) output = output.slice(-IMAGE_BUILD_OUTPUT_LINES);
  };

  const finish = (outcome: "succeeded" | "failed", why: string | null) => {
    state = outcome;
    reason = why;
    finishedAt = now();
  };

  async function run(): Promise<void> {
    let proc: ProcessHandle;
    try {
      proc = opts.host.spawn([dockerBin, "build", "--tag", image, "-"], {
        // Nothing is read from it — the Dockerfile arrives on stdin with no context — but a spawn
        // needs one, and the root exists on every host.
        cwd: "/",
        env: opts.env ?? dockerCliEnv(),
      });
    } catch (cause) {
      // `Bun.spawn` raises ENOENT synchronously for a binary that is not there.
      finish("failed", describeImageBuildFailure({ lines: output, spawnError: cause }));
      return;
    }

    let timedOut = false;
    let killer: ReturnType<typeof setTimeout> | undefined;
    const stop = setTimeout(() => {
      timedOut = true;
      proc.kill();
      killer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
    }, timeoutMs);
    try {
      const fed = (async () => {
        await proc.stdin.write(opts.dockerfile ?? EXECUTOR_DOCKERFILE);
        await proc.stdin.flush();
        await proc.stdin.end();
      })().catch(() => {
        // The CLI exiting before it read the file (no daemon) closes the pipe under the write;
        // its exit code and output say why, which is the answer worth giving.
      });
      // BuildKit reports its progress on stderr and the classic builder on stdout: both are read,
      // into one log, as the lines arrive.
      const [code] = await Promise.all([
        proc.exited,
        readLines(proc.stdout, keep),
        readLines(proc.stderr, keep),
        fed,
      ]);
      if (code === 0 && !timedOut) finish("succeeded", null);
      else finish("failed", describeImageBuildFailure({ lines: output, timedOut, timeoutMs }));
    } catch (cause) {
      finish("failed", describeImageBuildFailure({ lines: output, spawnError: cause }));
    } finally {
      clearTimeout(stop);
      clearTimeout(killer);
    }
  }

  return {
    start() {
      if (state === "building") return status();
      state = "building";
      startedAt = now();
      finishedAt = null;
      reason = null;
      output = [];
      // Detached from the request that started it: a build takes minutes, and the route answers
      // at once (Bun closes a request left unanswered for ten seconds). `run` settles every
      // failure into the state itself, so nothing is left to reject.
      void run();
      return status();
    },
    status,
  };
}

async function readLines(stream: AsyncIterable<Uint8Array>, onLine: (line: string) => void) {
  const decoder = new TextDecoder();
  let partial = "";
  for await (const chunk of stream) {
    partial += decoder.decode(chunk, { stream: true });
    const lines = partial.split(/\r?\n|\r/);
    partial = lines.pop() ?? "";
    for (const line of lines) onLine(line);
  }
  partial += decoder.decode();
  if (partial) onLine(partial);
}

/**
 * Why the image did not build, in words someone setting SoloW up can act on (E6).
 *
 * Read from what Docker printed, because its exit code is 1 for every one of these. The patterns
 * are the daemon's and the CLI's own sentences, and the order matters: a daemon that cannot be
 * reached also fails every download, so it is asked about first. Anything unrecognised says so
 * and leaves the reading to the output shown beside it, rather than guessing a cause.
 */
export function describeImageBuildFailure(args: {
  lines: readonly string[];
  timedOut?: boolean;
  timeoutMs?: number;
  spawnError?: unknown;
}): string {
  if (args.spawnError !== undefined) {
    return "SoloW couldn't run Docker on this machine. Install Docker (or point SOLOW_DOCKER_BIN at it), then build again.";
  }
  if (args.timedOut) {
    const minutes = Math.round((args.timeoutMs ?? IMAGE_BUILD_TIMEOUT_MS) / 60_000);
    return `The build was stopped after ${minutes} minutes. A slow connection can do that; build again, and the steps already done are reused.`;
  }
  const text = args.lines.join("\n");
  if (
    /permission denied.*docker(\.sock|_engine)|permission denied while trying to connect/i.test(
      text,
    )
  ) {
    return "This account isn't allowed to use Docker. Add it to the docker group and sign in again (or use rootless Docker), then build again.";
  }
  if (
    /cannot connect to the docker daemon|is the docker daemon running|error during connect/i.test(
      text,
    )
  ) {
    return "Docker is installed but isn't running. Start it, then build again.";
  }
  if (/no space left on device/i.test(text)) {
    return "Docker ran out of disk space while building. Free some (docker system prune removes what nothing uses), then build again.";
  }
  if (
    /temporary failure in name resolution|could not resolve host|failed to resolve source metadata|failed to do request|dial tcp|i\/o timeout|tls handshake timeout|network is unreachable|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED/i.test(
      text,
    )
  ) {
    return "The build couldn't download what it needs — the base images, or Claude Code and opencode from npm. Check this machine's internet connection, then build again.";
  }
  return "The image didn't build. The last lines Docker printed are below.";
}
