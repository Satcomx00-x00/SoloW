import { afterEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { Executor } from "./types.js";

/**
 * The `Executor` contract, as one suite every driver runs (issue #96, spec F07).
 *
 * `local.test.ts`'s header has claimed since issue #1 that what it pins is "the contract every
 * future executor kind must also satisfy" — but it was a claim about a file only the local
 * driver ever loaded, and the second driver arrived with none of it enforced. The Docker driver
 * re-derives the jail check, the verbatim-environment guarantee and the never-throw rule from
 * scratch, in a different language (`docker exec` argv rather than `Bun.spawn`), so the one
 * thing that can keep the two honest is a suite that does not know which driver it is running
 * against. Writing this found a real divergence on the first pass: `fs.copy` preserved the
 * source's mode under Docker (`cp -p`) and silently widened it to 0644 under local
 * (`Bun.write`) — the exact class of bug the `-p` in `setup-files.ts` exists to prevent.
 *
 * Two things this suite deliberately does **not** do:
 *
 * - It reads streams with `for await`, never `new Response(stream)`. `ProcessHandle.stdout` is
 *   typed `AsyncIterable<Uint8Array>`, not `ReadableStream`: a driver is free to hand back a
 *   plain async generator, and `new Response` rejects one. `local.test.ts` got away with the
 *   cast because Bun's own streams are both.
 * - It asserts nothing about `loadAverage`'s length. The local driver answers from `os.loadavg()`
 *   and a container **cannot**: verified that `/proc/loadavg` inside a container reports the
 *   *host's* figures and `nproc` the host's CPU count regardless of `--cpus`, so the honest
 *   container answer is an empty array. A contract that demanded a number here would have forced
 *   the Docker driver to report the orchestrator's load as the Task's.
 *
 * Anything a driver answers differently *by design* — where `forward()` points, whether `exec`
 * inherits the host's environment, what `dispose()` tears down — stays in that driver's own test
 * file. This suite is only for the promises the interface makes to its callers.
 */

export interface ExecutorContractHarness {
  executor: Executor;
  /**
   * The executor's root, as an **absolute path on the execution host**.
   *
   * The suite needs it for two things a relative path could not express: `spawn`'s `cwd`, and
   * the argv of the `exec` calls that inspect what `fs` did (`chmod`, `stat`). For the Docker
   * driver the mounts are identical-path, so the same string addresses the file in both
   * namespaces — which is what lets one suite check both drivers' work the same way.
   */
  root: string;
  /** Tear down whatever the factory built: the container, the temporary root, both. */
  cleanup(): Promise<void>;
}

export type ExecutorContractFactory = () => Promise<ExecutorContractHarness>;

/**
 * Run the contract against one driver. `create` is called per test rather than per suite: a
 * driver whose state leaks between cases (a memoized container, a cached image environment)
 * would otherwise pass on the strength of the first test's setup.
 */
export function describeExecutorContract(driver: string, create: ExecutorContractFactory): void {
  describe(`Executor contract — ${driver}`, () => {
    let harness: ExecutorContractHarness | undefined;

    afterEach(async () => {
      const current = harness;
      harness = undefined;
      // Swallowed: a test that already failed must report its own reason, not a teardown error
      // raised because the thing it was cleaning up never got built.
      if (current) await current.cleanup().catch(() => {});
    });

    async function fresh(): Promise<ExecutorContractHarness> {
      harness = await create();
      return harness;
    }

    /** The `PATH` a child launched by *this* executor can actually use — see `baseEnv`. */
    async function hostPath(executor: Executor): Promise<string> {
      const base = await executor.baseEnv();
      return base["PATH"] ?? "";
    }

    describe("fs — root-jailed (AC-2)", () => {
      it("round-trips a file written and read back within the root", async () => {
        const { executor } = await fresh();
        await executor.fs.writeFile("notes.txt", "hello\n");
        expect(await executor.fs.exists("notes.txt")).toBe(true);
        expect(await executor.fs.readFile("notes.txt")).toBe("hello\n");
        expect(await executor.fs.list(".")).toContain("notes.txt");
      });

      it("writes into a nested directory that does not exist yet", async () => {
        const { executor } = await fresh();
        // The parents are the driver's job, not the caller's: #52 copies `.env` files to paths
        // whose directories the Task has not created yet, and a driver that made the caller
        // `mkdir -p` first would fail there rather than here.
        await executor.fs.writeFile("nested/dir/file.txt", "deep\n");
        expect(await executor.fs.readFile("nested/dir/file.txt")).toBe("deep\n");
      });

      it("copies a file within the root, creating the destination's parents", async () => {
        const { executor } = await fresh();
        await executor.fs.writeFile("src.txt", "copy me\n");
        await executor.fs.copy("src.txt", "dest/copied.txt");
        expect(await executor.fs.readFile("dest/copied.txt")).toBe("copy me\n");
      });

      it("preserves the mode of a copied file", async () => {
        const { executor, root } = await fresh();
        // `setup-files.ts` copies an Owner's private key into a worktree, and a copy that came
        // out world-readable would be a credential leak created by the copy itself. The Docker
        // driver gets this from `cp -p`; the local one had to be told, because `Bun.write`
        // creates the destination at the process umask and quietly widened 0600 to 0664.
        await executor.fs.writeFile("id_key", "PRIVATE\n");
        const chmod = await executor.exec(["chmod", "600", join(root, "id_key")]);
        expect(chmod.exitCode).toBe(0);

        await executor.fs.copy("id_key", "copied/id_key");

        const mode = await executor.exec(["stat", "-c", "%a", join(root, "copied", "id_key")]);
        expect(mode.stdout.trim()).toBe("600");
      });

      it("reports a missing file as not existing rather than throwing", async () => {
        const { executor } = await fresh();
        expect(await executor.fs.exists("nope.txt")).toBe(false);
      });

      it("rejects a relative traversal attempt out of the root", async () => {
        const { executor } = await fresh();
        await expect(executor.fs.readFile("../../etc/passwd")).rejects.toThrow(
          /escapes executor root/,
        );
        // `exists` too: the check runs before any try, so a traversal is refused rather than
        // answered `false` — a caller that treats false as "not there" would then create it.
        await expect(executor.fs.exists("../outside.txt")).rejects.toThrow(/escapes executor root/);
        await expect(executor.fs.writeFile("../escape.txt", "x")).rejects.toThrow(
          /escapes executor root/,
        );
      });

      it("rejects an absolute path outside the root", async () => {
        const { executor } = await fresh();
        await expect(executor.fs.readFile("/etc/passwd")).rejects.toThrow(/escapes executor root/);
      });

      it("rejects a traversal that is disguised inside a longer relative path", async () => {
        const { executor } = await fresh();
        // A jail that compared strings without resolving `..` first would let this through.
        await expect(executor.fs.readFile("nested/../../escape.txt")).rejects.toThrow(
          /escapes executor root/,
        );
      });
    });

    describe("spawn — the environment is verbatim (AC-3)", () => {
      it("gives the child none of the executor's own environment", async () => {
        process.env["SOLOW_TEST_LEAK"] = "must-not-reach-the-child";
        try {
          const { executor, root } = await fresh();
          const proc = executor.spawn(["sh", "-c", 'echo "LEAK=[$SOLOW_TEST_LEAK]"'], {
            cwd: root,
            env: { PATH: await hostPath(executor) },
          });
          const output = await readAll(proc.stdout);
          await proc.exited;
          expect(output).toContain("LEAK=[]");
        } finally {
          delete process.env["SOLOW_TEST_LEAK"];
        }
      });

      it("passes through exactly the environment it was given", async () => {
        const { executor, root } = await fresh();
        const proc = executor.spawn(["sh", "-c", 'echo "MARKER=[$SOLOW_TEST_MARKER]"'], {
          cwd: root,
          env: { PATH: await hostPath(executor), SOLOW_TEST_MARKER: "pre'sent" },
        });
        const output = await readAll(proc.stdout);
        await proc.exited;
        // With a quote in it, because the Docker driver ships the environment through a shell
        // `eval` and a value that survives that is a value that survives anything.
        expect(output).toContain("MARKER=[pre'sent]");
      });

      it("keeps stdout and stderr as separate streams", async () => {
        const { executor, root } = await fresh();
        // `acp-runner.ts` reads protocol frames off stdout while the agent's diagnostics go to
        // stderr; a driver that merged them (a `docker exec -t`, say) would feed the parser log
        // lines and fail with a message about malformed JSON.
        const proc = executor.spawn(["sh", "-c", "echo out; echo err 1>&2"], {
          cwd: root,
          env: { PATH: await hostPath(executor) },
        });
        const [stdout, stderr] = await Promise.all([readAll(proc.stdout), readAll(proc.stderr)]);
        await proc.exited;
        expect(stdout.trim()).toBe("out");
        expect(stderr.trim()).toBe("err");
      });

      it("settles `exited` when the process is killed", async () => {
        const { executor, root } = await fresh();
        // The whole TERM→KILL ladder in `packages/acp/src/session.ts` waits on this promise; a
        // driver whose `kill` signalled the wrong process would hang every stop to its time-box.
        const proc = executor.spawn(["sh", "-c", "sleep 30"], {
          cwd: root,
          env: { PATH: await hostPath(executor) },
        });
        proc.kill();
        expect(await proc.exited).not.toBe(0);
      });
    });

    describe("exec — one-shot commands report failure, never throw it", () => {
      it("captures stdout and a zero exit code", async () => {
        const { executor } = await fresh();
        const result = await executor.exec(["sh", "-c", "echo hi"]);
        expect(result.exitCode).toBe(0);
        expect(result.stdout).toBe("hi\n");
      });

      it("reports a non-zero exit code instead of throwing", async () => {
        const { executor } = await fresh();
        const result = await executor.exec(["sh", "-c", "echo oops 1>&2; exit 3"]);
        expect(result.exitCode).toBe(3);
        expect(result.stderr).toBe("oops\n");
      });

      it("reports a plain exit 1 as a result too", async () => {
        const { executor } = await fresh();
        // Called out separately because 1 is also the code a dead container's `docker exec`
        // returns, and the Docker driver has to tell the two apart. `test -f` answering "no"
        // and `git rev-parse` answering "not a repository" both land here, and turning either
        // into a thrown "the executor is gone" would fail the Task with the wrong reason.
        const result = await executor.exec(["sh", "-c", "exit 1"]);
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toBe("");
      });

      it("merges the given environment over the executor's own, rather than replacing it", async () => {
        const { executor } = await fresh();
        // The deliberate opposite of `spawn`, and the reason `ExecOpts.env` and `SpawnOpts.env`
        // are separate types: this channel exists so `git` can be handed a credential without
        // it appearing in argv, and a `git` that lost the host's `PATH` and `HOME` would not
        // run at all. "The executor's own" is the *container's* for a container driver, never
        // the orchestrator's — copying the host's in would leak host credentials into the
        // isolation the profile asked for.
        const result = await executor.exec(["sh", "-c", 'echo "[$GC_TEST_VAR]"; echo "[$PATH]"'], {
          env: { GC_TEST_VAR: "supplied" },
        });
        const [supplied, inherited] = result.stdout.trim().split("\n");
        expect(supplied).toBe("[supplied]");
        expect(inherited).not.toBe("[]");
      });

      it("leaves the environment alone when none is given", async () => {
        const { executor } = await fresh();
        const result = await executor.exec(["sh", "-c", 'echo "[$GC_TEST_VAR]"']);
        expect(result.stdout.trim()).toBe("[]");
      });

      it("runs in the given working directory", async () => {
        const { executor, root } = await fresh();
        const result = await executor.exec(["pwd"], { cwd: root });
        expect(result.stdout.trim()).toBe(root);
      });
    });

    describe("baseEnv — the base a caller shapes a child's environment from", () => {
      it("describes the execution host, with a PATH a child can actually use", async () => {
        const { executor, root } = await fresh();
        const base = await executor.baseEnv();
        expect(typeof base["PATH"]).toBe("string");
        expect(base["PATH"]).not.toBe("");
        // Only strings: `SpawnOpts.env` cannot carry an `undefined`, and a driver that let one
        // through would produce a child environment missing a variable nobody named.
        expect(Object.values(base).every((value) => typeof value === "string")).toBe(true);

        // And it has to be a PATH *on the execution host*, which is the entire reason the member
        // exists — the proof is that a child launched with it can find a binary.
        const proc = executor.spawn(["sh", "-c", "echo resolved"], { cwd: root, env: base });
        expect(await readAll(proc.stdout)).toContain("resolved");
        expect(await proc.exited).toBe(0);
      });
    });

    describe("metrics — typed, in range, and never a made-up number", () => {
      it("answers with figures the driver can honestly source", async () => {
        const { executor } = await fresh();
        const metrics = await executor.metrics();
        // `loadAverage` is asserted to be an array and nothing more: see this file's header.
        expect(Array.isArray(metrics.loadAverage)).toBe(true);
        for (const value of [metrics.cpuPercent, metrics.memPercent, metrics.diskPercent]) {
          if (value === null) continue;
          expect(value).toBeGreaterThanOrEqual(0);
          expect(value).toBeLessThanOrEqual(100);
        }
      });

      it("never rejects, because a gauge must not fail a Task", async () => {
        const { executor } = await fresh();
        await expect(executor.metrics()).resolves.toBeDefined();
      });
    });
  });
}

/**
 * Read a process stream to the end.
 *
 * `for await`, not `new Response(stream)`: the interface promises an `AsyncIterable<Uint8Array>`
 * and nothing more, so a driver returning a plain async generator is conforming and `Response`
 * would throw on it. The streaming decode matters as well — a multi-byte character split across
 * two chunks decodes to a replacement character without it.
 */
async function readAll(stream: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of stream) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}
