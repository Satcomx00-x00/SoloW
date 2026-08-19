import { execFileSync } from "node:child_process";
import { E2E_ENV, ROOT } from "./fixture.js";

/**
 * Node-safe wrapper around `seed-cli.ts` (issue #15) — see that file for why this shells out to
 * a `bun` subprocess instead of importing `@gatecontrol/db` directly.
 */
function runSeedCli(kind: "issue" | "task", workspaceId: string, title: string): { id: string } {
  const env = { ...process.env, ...E2E_ENV };
  const out = execFileSync("bun", ["run", "e2e/support/seed-cli.ts", kind, workspaceId, title], {
    cwd: ROOT,
    env,
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop() ?? "{}");
}

/** Insert an Issue into an existing Workspace. There is no `issue.create` any more (issue #15). */
export function seedIssue(workspaceId: string, title: string): { id: string } {
  return runSeedCli("issue", workspaceId, title);
}

/** Insert a complete, self-contained Task graph into an existing Workspace. */
export function seedTask(workspaceId: string, title: string): { id: string } {
  return runSeedCli("task", workspaceId, title);
}
