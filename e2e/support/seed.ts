import { execFileSync } from "node:child_process";
import { E2E_ENV, ROOT } from "./fixture.js";

/**
 * Node-safe wrapper around `seed-cli.ts` (issue #15) — see that file for why this shells out to
 * a `bun` subprocess instead of importing `@solow/db` directly.
 */
function runSeedCli(args: string[]): { id: string } {
  const env = { ...process.env, ...E2E_ENV };
  const out = execFileSync("bun", ["run", "e2e/support/seed-cli.ts", ...args], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}");
}

/**
 * Insert an Issue into an existing Workspace, attached to the named Repository — attached,
 * because the product's own Issues always are, and the Task dialog's picker (rightly) refuses
 * to list one that is not. `repoName` omitted seeds the unattached shape, for the one test that
 * asserts about listings rather than pickers.
 */
export function seedIssue(workspaceId: string, title: string, repoName?: string): { id: string } {
  return runSeedCli(["issue", workspaceId, repoName ?? "-", title]);
}

/** Insert a complete, self-contained Task graph into an existing Workspace. */
export function seedTask(workspaceId: string, title: string): { id: string } {
  return runSeedCli(["task", workspaceId, title]);
}
