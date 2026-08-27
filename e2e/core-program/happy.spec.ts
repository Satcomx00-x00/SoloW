import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PATHS, SEED_WORKSPACE_A } from "../support/fixture.js";
import {
  connectRepository,
  createTask,
  launchTask,
  launchToReview,
  openReview,
  openTask,
} from "../support/flows.js";
import { seedIssue } from "../support/seed.js";

/**
 * Happy-path E2E (task TASK-025): an Owner takes an Issue all the way to a reviewed, approved
 * change on a new local branch — the loop the whole product exists to serve. The agent is the
 * deterministic fixture runner, but every other layer (SPA → tRPC → DAL → orchestrator →
 * worktree → git) is production code.
 *
 * The journey is today's: there is no flat `/board` (boards live inside Projects, and the
 * fixture repository belongs to none), so a Task is created from the header's Create menu,
 * opened from its Issue's page, launched with the Task page's own lifecycle arrows, and reviewed
 * behind the gate the operator opens. See `support/flows.ts` for why that vocabulary is shared.
 *
 * Waits are selector-based only; nothing in this file sleeps for a fixed duration.
 */

const REPO_NAME = "e2e-fixture-repo";

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: PATHS.repo, encoding: "utf8" }).trim();

async function ensureRepository(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

test.describe("steering a running agent", () => {
  test("an instruction typed in the terminal reaches the agent and its reply comes back", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Latch sticks in the cold ${stamp}`;
    // The marker keeps the fixture agent running so there is a live agent to steer.
    const taskTitle = `Warm the latch housing ${stamp} [steerable]`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, { title: taskTitle, issue: issueTitle, repository: REPO_NAME });
    await openTask(page, issue.id, taskTitle);
    await launchTask(page);

    const box = page.getByLabel("Message the agent");
    await expect(box).toBeEnabled();
    await box.fill("check the heater fuse too");
    await page.getByRole("button", { name: "Send" }).click();

    // SPA → hub → registry → the agent for *this* Task → back down the stream (TASK-022).
    await expect(page.getByText("agent received: check the heater fuse too")).toBeVisible();
    // Having taken the instruction the agent finishes and declares — the gate is the operator's
    // to open, so the page offers it rather than moving on its own.
    await openReview(page);
  });
});

test.describe("core program happy path", () => {
  test("issue → task → launch → live stream → review → approve → Done on a new branch", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Gate servo stalls ${stamp}`;
    const taskTitle = `Investigate servo draw ${stamp}`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, { title: taskTitle, issue: issueTitle, repository: REPO_NAME });

    const taskId = await openTask(page, issue.id, taskTitle);
    await launchToReview(page);

    // The agent's output is on screen — streamed live and replayed from the session log.
    await expect(page.getByText(/agent edited/)).toBeVisible();

    // And the change itself is reviewable in the app: the files the agent actually wrote, in
    // the captured source-control panel, with the written line in the diff beside them. No tab
    // to click any more — the Changes column sits beside the terminal in the split pane, on
    // screen the whole time the review is.
    const changed = page.getByRole("list", { name: "Changes" });
    await expect(changed.getByTitle(`marker-solow-task-${taskId}.txt`)).toBeVisible();
    await expect(changed.getByTitle("visible.txt")).toBeVisible();
    // …and the diff body carries the line the agent actually wrote.
    await expect(page.getByText(/edited by the agent in/).first()).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();

    // The workflow committed the change and moved the Task to Done. The state is read from the
    // badge's own attribute — the lifecycle labels also appear as plain words elsewhere.
    await expect(page.locator('[data-task-state="done"]').first()).toBeVisible();
    const branch = `solow-task-${taskId}`;
    await expect(page.getByText(branch).first()).toBeVisible();

    // …and the branch really exists in the repository, with the agent's file on it. Polled:
    // the API answers as soon as the state is written, a moment before the step returns.
    expect(git(["branch", "--list", branch])).toContain(branch);
    await expect
      .poll(() => git(["show", "--name-only", "--format=", branch]))
      .toContain(`marker-solow-task-${taskId}.txt`);
    expect(git(["show", `${branch}:marker-solow-task-${taskId}.txt`])).toContain(
      "edited by the agent",
    );
    // No push, no PR: the change lives only on the local branch (spec FR-009).
    expect(git(["remote"])).toBe("");
  });

  test("rejecting a diff discards the agent's changes", async ({ page }) => {
    const stamp = Date.now();
    const issueTitle = `Keypad flicker ${stamp}`;
    const taskTitle = `Debounce the backlight ${stamp}`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, { title: taskTitle, issue: issueTitle, repository: REPO_NAME });

    const taskId = await openTask(page, issue.id, taskTitle);
    await launchToReview(page);

    await page.getByRole("button", { name: "Reject" }).click();
    // Rejecting discards the agent's work, so it is confirmed rather than done on one click.
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard the changes" })
      .click();

    // The Task returns to Ready and the worktree is torn down — nothing was committed.
    await expect(page.locator('[data-task-state="ready"]').first()).toBeVisible();
    const branch = `solow-task-${taskId}`;
    await expect.poll(() => existsSync(join(PATHS.worktrees, `solow-task-${taskId}`))).toBe(false);
    expect(git(["log", "--oneline", branch, "--"])).not.toContain("SoloW");
  });
});
