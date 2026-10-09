import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createExecutorImageBuilder,
  describeImageBuildFailure,
  IMAGE_BUILD_OUTPUT_LINES,
} from "./image-build.js";
import type { Executor, ProcessHandle, SpawnOpts } from "./types.js";

/**
 * The guided setup's build of the executor image (roadmap B4), driven against a fake host whose
 * one `docker build` the test feeds and ends by hand — a real build takes a daemon and minutes,
 * and is run once by hand against one (see the B4 note in F07).
 */

const IMAGE = "solow-executor:test";
const encoder = new TextEncoder();

/** A byte stream the test writes into, read by the builder as the CLI's stdout or stderr. */
function pipe() {
  const queue: Uint8Array[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const poke = () => {
    wake?.();
    wake = null;
  };
  return {
    write(text: string) {
      queue.push(encoder.encode(text));
      poke();
    },
    end() {
      ended = true;
      poke();
    },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = queue.shift();
          if (next) yield next;
          else if (ended) return;
          else await new Promise<void>((resolve) => (wake = resolve));
        }
      },
    } satisfies AsyncIterable<Uint8Array>,
  };
}

/** One spawned `docker build`: what it was asked, what it was fed, and its exit to call. */
interface FakeBuild {
  argv: string[];
  opts: SpawnOpts;
  stdin: string;
  stdinEnded: boolean;
  kills: Array<number | string | undefined>;
  out: ReturnType<typeof pipe>;
  err: ReturnType<typeof pipe>;
  exit(code: number): void;
}

function fakeHost(onKill?: (build: FakeBuild) => void) {
  const builds: FakeBuild[] = [];
  const host = {
    spawn(argv: string[], opts: SpawnOpts): ProcessHandle {
      let exit: (code: number) => void = () => {};
      const exited = new Promise<number>((resolve) => (exit = resolve));
      const build: FakeBuild = {
        argv,
        opts,
        stdin: "",
        stdinEnded: false,
        kills: [],
        out: pipe(),
        err: pipe(),
        exit(code) {
          build.out.end();
          build.err.end();
          exit(code);
        },
      };
      builds.push(build);
      return {
        stdin: {
          write: (data: string) => {
            build.stdin += data;
            return data.length;
          },
          flush: async () => 0,
          end: async () => {
            build.stdinEnded = true;
          },
        },
        stdout: build.out.iterable,
        stderr: build.err.iterable,
        exited,
        kill(signal) {
          build.kills.push(signal);
          onKill?.(build);
        },
      };
    },
  } as unknown as Executor;
  return { host, builds };
}

/** Let the builder's detached run take its next step. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

const builderOn = (
  host: Executor,
  extra: Partial<{ timeoutMs: number; dockerfile: string }> = {},
) =>
  createExecutorImageBuilder({
    host,
    dockerBin: "docker",
    image: IMAGE,
    env: { PATH: "/usr/bin", HOME: "/home/op" },
    now: () => Date.UTC(2026, 9, 9, 12, 0, 0),
    ...extra,
  });

describe("createExecutorImageBuilder", () => {
  it("is idle until asked, and names the image it would build", () => {
    const { host, builds } = fakeHost();
    expect(builderOn(host).status()).toEqual({
      image: IMAGE,
      state: "idle",
      startedAt: null,
      finishedAt: null,
      output: [],
      reason: null,
    });
    expect(builds).toHaveLength(0);
  });

  it("builds from stdin with no context, as `solow executor-image` does, and answers at once", async () => {
    const { host, builds } = fakeHost();
    const started = builderOn(host).start();
    expect(started.state).toBe("building");
    expect(started.startedAt).toBe("2026-10-09T12:00:00.000Z");
    await settle();

    expect(builds).toHaveLength(1);
    expect(builds[0]?.argv).toEqual(["docker", "build", "--tag", IMAGE, "-"]);
    // The CLI's own environment, as given — never the orchestrator's whole one.
    expect(builds[0]?.opts.env).toEqual({ PATH: "/usr/bin", HOME: "/home/op" });
    expect(builds[0]?.stdinEnded).toBe(true);
  });

  it("feeds the repository's Dockerfile — the one `make executor-image` builds", async () => {
    const { host, builds } = fakeHost();
    builderOn(host).start();
    await settle();
    const dockerfile = readFileSync(
      join(import.meta.dir, "..", "..", "..", "..", "docker", "executor", "Dockerfile"),
      "utf8",
    );
    expect(builds[0]?.stdin).toBe(dockerfile);
  });

  it("starts one build however often it is asked while that one runs", async () => {
    const { host, builds } = fakeHost();
    const builder = builderOn(host);
    const first = builder.start();
    await settle();
    const second = builder.start();
    await settle();
    expect(builds).toHaveLength(1);
    expect(second.state).toBe("building");
    expect(second.startedAt).toBe(first.startedAt);
  });

  it("succeeds on exit 0, keeping the lines Docker printed on either stream", async () => {
    const { host, builds } = fakeHost();
    const builder = builderOn(host);
    builder.start();
    await settle();
    const build = builds[0] as FakeBuild;
    // A line split across chunks, CRLF endings, and BuildKit on stderr: all read as lines.
    build.err.write("#1 [internal] load build defin");
    build.err.write("ition from Dockerfile\r\n#2 DONE 0.1s\n");
    build.out.write("Successfully tagged solow-executor:test\n");
    await settle();
    expect(builder.status().output).toContain(
      "#1 [internal] load build definition from Dockerfile",
    );
    build.exit(0);
    await settle();

    const done = builder.status();
    expect(done.state).toBe("succeeded");
    expect(done.reason).toBeNull();
    expect(done.finishedAt).toBe("2026-10-09T12:00:00.000Z");
    expect(done.output).toEqual(
      expect.arrayContaining([
        "#1 [internal] load build definition from Dockerfile",
        "#2 DONE 0.1s",
        "Successfully tagged solow-executor:test",
      ]),
    );
  });

  it("keeps only the newest lines, each of them short", async () => {
    const { host, builds } = fakeHost();
    const builder = builderOn(host);
    builder.start();
    await settle();
    const build = builds[0] as FakeBuild;
    for (let i = 1; i <= 100; i++) build.err.write(`line ${i}\n`);
    build.err.write(`${"x".repeat(5_000)}\n`);
    build.exit(0);
    await settle();

    const { output } = builder.status();
    expect(output).toHaveLength(IMAGE_BUILD_OUTPUT_LINES);
    expect(output.at(-2)).toBe("line 100");
    expect(output.at(-1)?.length).toBeLessThan(500);
  });

  it("fails in plain words when the daemon is not running", async () => {
    const { host, builds } = fakeHost();
    const builder = builderOn(host);
    builder.start();
    await settle();
    const build = builds[0] as FakeBuild;
    build.err.write(
      "ERROR: Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?\n",
    );
    build.exit(1);
    await settle();

    const failed = builder.status();
    expect(failed.state).toBe("failed");
    expect(failed.reason).toBe(
      "Docker is installed but isn't running. Start it, then build again.",
    );
    expect(failed.output.at(-1)).toContain("Cannot connect to the Docker daemon");
  });

  it("fails, rather than throwing, when there is no docker to run", async () => {
    const host = {
      spawn() {
        throw new Error("ENOENT: no such file or directory, posix_spawn 'docker'");
      },
    } as unknown as Executor;
    const builder = builderOn(host);
    builder.start();
    await settle();
    expect(builder.status().state).toBe("failed");
    expect(builder.status().reason).toContain("couldn't run Docker");
  });

  it("stops a build that runs past its deadline, and says so", async () => {
    const { host, builds } = fakeHost((build) => build.exit(143));
    const builder = builderOn(host, { timeoutMs: 20 });
    builder.start();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(builds[0]?.kills[0]).toBeUndefined();
    const stopped = builder.status();
    expect(stopped.state).toBe("failed");
    expect(stopped.reason).toContain("stopped after");
  });

  it("starts afresh after a failure, with the old output gone", async () => {
    const { host, builds } = fakeHost();
    const builder = builderOn(host);
    builder.start();
    await settle();
    builds[0]?.err.write("ERROR: no space left on device\n");
    builds[0]?.exit(1);
    await settle();
    expect(builder.status().state).toBe("failed");

    const again = builder.start();
    await settle();
    expect(builds).toHaveLength(2);
    expect(again.state).toBe("building");
    expect(again.output).toEqual([]);
    expect(again.reason).toBeNull();
    expect(again.finishedAt).toBeNull();
  });
});

describe("describeImageBuildFailure", () => {
  const said = (line: string) => describeImageBuildFailure({ lines: [line] });

  it("names the cause someone can act on", () => {
    expect(
      said(
        "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock",
      ),
    ).toContain("isn't allowed to use Docker");
    expect(said("error during connect: Head http://docker/_ping: dial unix")).toContain(
      "isn't running",
    );
    // Docker 29.8's own words, from a real build pointed at a socket with no daemon behind it.
    expect(
      said(
        "ERROR: failed to connect to the docker API at unix:///nonexistent/docker.sock; check if the path is correct and if the daemon is running: dial unix /nonexistent/docker.sock: connect: no such file or directory",
      ),
    ).toContain("isn't running");
    expect(
      said(
        "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
      ),
    ).toContain("isn't allowed to use Docker");
    expect(
      said("ERROR: failed to copy: write /var/lib/docker/x: no space left on device"),
    ).toContain("disk space");
    expect(
      said(
        "ERROR: failed to resolve source metadata for docker.io/library/node:22-trixie-slim: dial tcp: lookup registry-1.docker.io: Temporary failure in name resolution",
      ),
    ).toContain("internet connection");
    expect(said("npm error code EAI_AGAIN")).toContain("internet connection");
  });

  it("asks about the daemon before the downloads a dead daemon also fails", () => {
    expect(
      describeImageBuildFailure({
        lines: [
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. dial unix: i/o timeout",
        ],
      }),
    ).toContain("isn't running");
  });

  it("does not guess at a failure it does not recognise", () => {
    expect(said('ERROR: process "/bin/sh -c npm install" did not complete successfully')).toBe(
      "The image didn't build. The last lines Docker printed are below.",
    );
  });

  it("says a stopped build was stopped, whatever it printed", () => {
    expect(
      describeImageBuildFailure({
        lines: ["dial tcp: i/o timeout"],
        timedOut: true,
        timeoutMs: 1_800_000,
      }),
    ).toContain("stopped after 30 minutes");
  });
});
