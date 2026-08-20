import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalExecutor } from "./local.js";

/**
 * The local `Executor` (issue #1). What matters here is the contract every future executor kind
 * (#46 #47 #48) must also satisfy: `fs` cannot be walked outside its root (AC-2), `spawn` hands
 * the child exactly the environment it was given and nothing of the host's own (AC-3), and `exec`
 * reports failure through the exit code rather than throwing.
 */

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function freshRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "gc-executor-"));
  return root;
}

describe("fs — root-jailed (AC-2)", () => {
  it("round-trips a file written and read back within the root", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await executor.fs.writeFile("notes.txt", "hello\n");
    expect(await executor.fs.exists("notes.txt")).toBe(true);
    expect(await executor.fs.readFile("notes.txt")).toBe("hello\n");
    expect(await executor.fs.list(".")).toContain("notes.txt");
  });

  it("writes into a nested directory that does not exist yet", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await executor.fs.writeFile("nested/dir/file.txt", "deep\n");
    expect(await executor.fs.readFile("nested/dir/file.txt")).toBe("deep\n");
  });

  it("copies a file within the root", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await executor.fs.writeFile("src.txt", "copy me\n");
    await executor.fs.copy("src.txt", "dest/copied.txt");
    expect(await executor.fs.readFile("dest/copied.txt")).toBe("copy me\n");
  });

  it("reports a missing file as not existing rather than throwing", async () => {
    const executor = createLocalExecutor(await freshRoot());
    expect(await executor.fs.exists("nope.txt")).toBe(false);
  });

  it("rejects a relative traversal attempt out of the root", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await expect(executor.fs.readFile("../../etc/passwd")).rejects.toThrow(/escapes executor root/);
    await expect(executor.fs.exists("../outside.txt")).rejects.toThrow(/escapes executor root/);
    await expect(executor.fs.writeFile("../escape.txt", "x")).rejects.toThrow(
      /escapes executor root/,
    );
  });

  it("rejects an absolute path outside the root", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await expect(executor.fs.readFile("/etc/passwd")).rejects.toThrow(/escapes executor root/);
  });

  it("rejects a traversal that is disguised inside a longer relative path", async () => {
    const executor = createLocalExecutor(await freshRoot());
    // A naive `startsWith` jail check that skips resolving `..` segments would let this through.
    await expect(executor.fs.readFile("nested/../../escape.txt")).rejects.toThrow(
      /escapes executor root/,
    );
  });
});

describe("spawn — environment is verbatim (AC-3)", () => {
  it("gives the child none of the parent's environment beyond what it was handed", async () => {
    process.env["GATECONTROL_TEST_LEAK"] = "must-not-reach-the-child";
    try {
      const executor = createLocalExecutor(await freshRoot());
      const proc = executor.spawn(["sh", "-c", 'echo "LEAK=[$GATECONTROL_TEST_LEAK]"'], {
        cwd: root as string,
        env: { PATH: process.env["PATH"] ?? "" },
      });
      const output = await new Response(proc.stdout as unknown as ReadableStream).text();
      await proc.exited;
      expect(output).toContain("LEAK=[]");
    } finally {
      delete process.env["GATECONTROL_TEST_LEAK"];
    }
  });

  it("passes through exactly the environment it was given", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const proc = executor.spawn(["sh", "-c", 'echo "MARKER=[$GATECONTROL_TEST_MARKER]"'], {
      cwd: root as string,
      env: { PATH: process.env["PATH"] ?? "", GATECONTROL_TEST_MARKER: "present" },
    });
    const output = await new Response(proc.stdout as unknown as ReadableStream).text();
    await proc.exited;
    expect(output).toContain("MARKER=[present]");
  });

  it("kill ends the process", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const proc = executor.spawn(["sh", "-c", "sleep 30"], {
      cwd: root as string,
      env: { PATH: process.env["PATH"] ?? "" },
    });
    proc.kill();
    const code = await proc.exited;
    expect(code).not.toBe(0);
  });
});

describe("exec — one-shot commands never throw on failure", () => {
  it("captures stdout and a zero exit code", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const result = await executor.exec(["sh", "-c", "echo hi"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("hi\n");
  });

  it("reports a non-zero exit code instead of throwing", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const result = await executor.exec(["sh", "-c", "echo oops 1>&2; exit 3"]);
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("oops\n");
  });

  it("runs in the given cwd", async () => {
    const dir = await freshRoot();
    const executor = createLocalExecutor(dir);
    const result = await executor.exec(["pwd"], { cwd: dir });
    expect(result.stdout.trim()).toBe(dir);
  });

  it("merges the given env over the host's, rather than replacing it", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const result = await executor.exec(["sh", "-c", 'echo "$GC_TEST_VAR"; echo "$PATH"'], {
      env: { GC_TEST_VAR: "supplied" },
    });
    const [supplied, inherited] = result.stdout.trim().split("\n");
    // Merged, unlike `spawn` (see the AC-3 suite above): this channel exists so `git` can be
    // handed a credential, and a git that lost PATH and HOME would not run at all.
    expect(supplied).toBe("supplied");
    expect(inherited?.length ?? 0).toBeGreaterThan(0);
  });

  it("leaves the environment untouched when none is given", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const result = await executor.exec(["sh", "-c", 'echo "[$GC_TEST_VAR]"']);
    expect(result.stdout.trim()).toBe("[]");
  });
});

describe("forward and metrics and dispose", () => {
  it("forward resolves to a reachable local URL", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const handle = await executor.forward(5001);
    expect(handle.url).toBe("http://localhost:5001");
    await handle.close();
  });

  it("metrics reports sane, typed values", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const metrics = await executor.metrics();
    expect(Array.isArray(metrics.loadAverage)).toBe(true);
    expect(metrics.loadAverage.length).toBeGreaterThan(0);
    if (metrics.cpuPercent !== null) {
      expect(metrics.cpuPercent).toBeGreaterThanOrEqual(0);
      expect(metrics.cpuPercent).toBeLessThanOrEqual(100);
    }
    if (metrics.memPercent !== null) {
      expect(metrics.memPercent).toBeGreaterThanOrEqual(0);
      expect(metrics.memPercent).toBeLessThanOrEqual(100);
    }
  });

  it("dispose resolves without touching anything (nothing to tear down locally)", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await expect(executor.dispose()).resolves.toBeUndefined();
  });
});
