import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeExecutorContract } from "./contract.js";
import { createLocalExecutor } from "./local.js";

/**
 * The local `Executor` (issue #1).
 *
 * Everything the interface promises *every* driver — the root jail (AC-2), the verbatim spawn
 * environment (AC-3), `exec` reporting failure through the exit code rather than throwing — now
 * lives in `contract.ts` and is run at the bottom of this file. That is what this file's header
 * used to claim it was doing on its own: the claim only became true once a second driver was
 * made to run the same cases (#96).
 *
 * What is left here is what is genuinely *local*: the answers that are correct precisely because
 * the execution host is this process.
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

describe("baseEnv — the base a caller shapes the child environment from", () => {
  it("hands back the host's own environment, which is what a local child would inherit", async () => {
    process.env["SOLOW_TEST_BASE"] = "from-the-host";
    try {
      const executor = createLocalExecutor(await freshRoot());
      const base = await executor.baseEnv();
      // The whole reason this member exists is that a container executor answers differently:
      // for the local driver the host *is* the execution host, so the value must stay exactly
      // what `task-run` used to read out of `process.env` itself — no behaviour change.
      expect(base["SOLOW_TEST_BASE"]).toBe("from-the-host");
      expect(base["PATH"]).toBe(process.env["PATH"] as string);
    } finally {
      delete process.env["SOLOW_TEST_BASE"];
    }
  });
});

describe("exec — the host's own environment is what gets merged into", () => {
  it("hands the child the host's PATH, not a container's", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const result = await executor.exec(["sh", "-c", 'echo "$PATH"'], {
      env: { GC_TEST_VAR: "supplied" },
    });
    // The contract only asks that *something* was inherited; for this driver the something is
    // identifiable, and it is the host's own — which is exactly what makes the local driver the
    // wrong place to run a Task that asked for isolation.
    expect(result.stdout.trim()).toBe(process.env["PATH"] as string);
  });
});

describe("forward and metrics and dispose", () => {
  it("forward resolves to a reachable local URL", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const handle = await executor.forward(5001);
    expect(handle.url).toBe("http://localhost:5001");
    await handle.close();
  });

  it("reports a real load average, which only a driver on the host can", async () => {
    const executor = createLocalExecutor(await freshRoot());
    const metrics = await executor.metrics();
    // Deliberately *not* in the shared contract: `/proc/loadavg` inside a container reports the
    // host's figures, so the Docker driver answers `[]` rather than passing off the
    // orchestrator's load as the Task's. Here the host genuinely is the execution host.
    expect(metrics.loadAverage.length).toBeGreaterThan(0);
  });

  it("dispose resolves without touching anything (nothing to tear down locally)", async () => {
    const executor = createLocalExecutor(await freshRoot());
    await expect(executor.dispose()).resolves.toBeUndefined();
  });
});

/**
 * The cross-driver contract, against the driver it was first written from.
 *
 * `docker.live.test.ts` runs the identical suite against a real daemon. If a case here is
 * genuinely local-only it belongs above, not in `contract.ts` — the value of the suite is
 * entirely in it being the same code for both.
 */
describeExecutorContract("local", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gc-executor-contract-"));
  return {
    executor: createLocalExecutor(dir),
    root: dir,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
});
