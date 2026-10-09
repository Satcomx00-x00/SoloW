import { describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openOutOfBandExecutor, orchestratorStatePaths } from "./factory.js";

/**
 * What the container driver is told it may never mount (B5). The guard's own rules are
 * `docker.test.ts`; this is about which directories are handed to it.
 */
describe("orchestratorStatePaths", () => {
  it("names the directory the database and its keys live in, whatever the database driver", () => {
    // A Postgres deployment has no database file to mount, but its `secret.key`,
    // `orchestrator.secret` and engine keys are still files in the state directory.
    for (const driver of ["sqlite", "postgres"] as const) {
      const paths = orchestratorStatePaths(
        { SOLOW_DB_DRIVER: driver, SOLOW_SQLITE_PATH: "/srv/solow/state/solow.db" },
        "/home/op",
      );
      expect(paths).toContain("/srv/solow/state");
    }
  });

  it("names the launchers' .solow and the CLI's data directory too", () => {
    const paths = orchestratorStatePaths(
      { SOLOW_DB_DRIVER: "postgres", SOLOW_SQLITE_PATH: "/srv/db/solow.db" },
      "/home/op",
    );
    expect(paths).toContain(resolve(".solow"));
    expect(paths).toContain("/home/op/.solow");

    const custom = orchestratorStatePaths(
      {
        SOLOW_DB_DRIVER: "postgres",
        SOLOW_SQLITE_PATH: "/srv/db/solow.db",
        SOLOW_HOME: "/data/solow/",
      },
      "/home/op",
    );
    expect(custom).toContain("/data/solow");
  });
});

/**
 * The host half of `openOutOfBandExecutor` — what Settings' bare probe and a Task on the local
 * executor get. The container half is driven end to end through both routes in `index.test.ts`.
 */
describe("openOutOfBandExecutor", () => {
  const roots = { worktreeRoot: "/unused", repoCacheRoot: "/unused" };
  const launch = { workspaceId: "ws-1", taskId: null, harnessCommands: ["claude"] } as const;

  it("keeps a host launch in a temp directory it removes, with nothing to preflight", async () => {
    const opened = await openOutOfBandExecutor(null, { ...launch, purpose: "probe", ...roots });

    expect(opened.cwd.startsWith(join(tmpdir(), "solow-probe-"))).toBe(true);
    expect(existsSync(opened.cwd)).toBe(true);
    expect(await opened.preflight()).toEqual({ ok: true, harnessCommands: [] });
    await opened.dispose();
    expect(existsSync(opened.cwd)).toBe(false);
  });

  it("refuses a kind with no driver before making anything", async () => {
    // Never a quiet fall-through to the host: that is a Task asking for isolation and not getting it.
    await expect(
      openOutOfBandExecutor(
        { config: { kind: "ssh" } as never },
        { ...launch, purpose: "explain", ...roots },
      ),
    ).rejects.toThrow(/no executor driver for kind "ssh"/);
  });
});
