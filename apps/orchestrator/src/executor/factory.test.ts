import { describe, expect, it } from "bun:test";
import { resolve } from "node:path";
import { orchestratorStatePaths } from "./factory.js";

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
