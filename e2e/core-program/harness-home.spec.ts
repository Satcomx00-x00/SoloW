import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PATHS, SEED_WORKSPACE_A } from "../support/fixture.js";
import {
  connectRepository,
  createTask,
  launchTask,
  openReview,
  openTask,
} from "../support/flows.js";
import { seedIssue } from "../support/seed.js";

/**
 * A Task's harness runs against a blank, app-owned configuration (Decision 0027).
 *
 * Checked where it matters — at the harness. The fixture harness records the `HOME` it was
 * launched with (`support/orchestrator.ts`), so this is the environment the real spawn would have
 * handed Claude Code, not a value read back from SoloW's own bookkeeping.
 */

const REPO_NAME = "e2e-fixture-repo";

test.describe("the harness home", () => {
  test("is the Task's own directory, never the operator's, and holds none of their configuration", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Hermetic ${stamp}`;
    const taskTitle = `Runs clean ${stamp}`;

    await page.goto("/settings?section=repositories");
    await connectRepository(page, REPO_NAME, PATHS.repo);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const taskId = await openTask(page, issue.id, taskTitle);
    await launchTask(page);

    const record = join(PATHS.harnessRuns, `solow-task-${taskId}.json`);
    await expect.poll(() => existsSync(record), { timeout: 60_000 }).toBe(true);
    const { home, claudeConfigDir, xdgConfigHome } = JSON.parse(readFileSync(record, "utf8")) as {
      home: string | null;
      claudeConfigDir: string | null;
      xdgConfigHome: string | null;
    };

    const expected = join(PATHS.worktrees, `${taskId}--harness-home`);
    expect(home).toBe(expected);
    expect(home).not.toBe(homedir());
    expect(existsSync(expected)).toBe(true);
    // The names that would otherwise still reach past `HOME` point inside it too.
    expect(claudeConfigDir).toBe(join(expected, ".claude"));
    expect(xdgConfigHome).toBe(join(expected, ".config"));
    // Nothing of the operator's followed the harness in: no user settings, no user MCP servers,
    // no user CLAUDE.md. What the app wants loaded arrives on the command line instead.
    const entries = readdirSync(expected, { recursive: true }).map(String);
    for (const leak of [".claude.json", "CLAUDE.md", join(".claude", "settings.json")]) {
      expect(entries).not.toContain(leak);
    }
    // Settled at the gate, so the run does not hold a concurrency slot the next spec needs.
    await openReview(page);
  });
});
