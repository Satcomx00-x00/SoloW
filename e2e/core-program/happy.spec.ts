import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PATHS } from "../support/fixture.js";

/**
 * Happy-path E2E (task TASK-025): an Owner takes an Issue all the way to a reviewed, approved
 * change on a new local branch — the loop the whole product exists to serve. The agent is the
 * deterministic fixture runner, but every other layer (SPA → tRPC → DAL → orchestrator →
 * worktree → git) is production code.
 *
 * Waits are selector-based only; nothing in this file sleeps for a fixed duration.
 */

const REPO_NAME = "e2e-fixture-repo";

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: PATHS.repo, encoding: "utf8" }).trim();

/** Connect the fixture git repository through Settings (once per suite run). */
async function ensureRepository(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/settings");
  // Wait for the list to actually resolve before deciding. Reading visibility straight after
  // navigating would answer "not there yet" while the query is still in flight, and every test
  // that did so would connect another copy of the same repository.
  await expect(page.getByLabel("Connected repositories")).toBeVisible();
  const badge = page.getByText(`${REPO_NAME} · local_path`);
  if (await badge.isVisible()) return;
  await page.getByLabel("Name").last().fill(REPO_NAME);
  await page.getByLabel("Location").fill(PATHS.repo);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(badge).toBeVisible();
}

async function createIssue(page: import("@playwright/test").Page, title: string): Promise<void> {
  await page.getByRole("button", { name: "New issue" }).click();
  const dialog = page.getByRole("dialog", { name: "New issue" });
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create issue" }).click();
  await expect(dialog).toBeHidden();
}

async function pickOption(
  page: import("@playwright/test").Page,
  label: string,
  option: string,
): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

async function createTask(
  page: import("@playwright/test").Page,
  opts: { title: string; issue: string },
): Promise<void> {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(opts.title);
  await pickOption(page, "Issue", opts.issue);
  await pickOption(page, "Agent profile", "Claude Code (subscription)");
  await pickOption(page, "Executor", "Local executor");
  await pickOption(page, "Repository", REPO_NAME);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
}

/** The board column a Task card currently sits in. */
function cardIn(page: import("@playwright/test").Page, column: string, title: string) {
  return page.getByLabel(`${column} column`).getByText(title, { exact: true });
}

/** Drive a Task from Backlog to Review; returns its id (read from the task page URL). */
async function launchToReview(
  page: import("@playwright/test").Page,
  title: string,
): Promise<string> {
  const card = page.getByLabel("Backlog column").locator("li", { hasText: title });
  await card.getByRole("button", { name: "Ready" }).click();
  await expect(cardIn(page, "Ready", title)).toBeVisible();

  await page
    .getByLabel("Ready column")
    .locator("li", { hasText: title })
    .getByRole("button", { name: "Launch" })
    .click();

  // The orchestrator runs the agent and parks the Task at the review gate; the board learns
  // about it over the live channel, with no reload.
  await expect(cardIn(page, "Review", title)).toBeVisible();

  await cardIn(page, "Review", title).click();
  await expect(page).toHaveURL(/\/task\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname.split("/").pop() as string;
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
    await page.goto("/board");
    await createIssue(page, issueTitle);
    await createTask(page, { title: taskTitle, issue: issueTitle });

    const card = page.getByLabel("Backlog column").locator("li", { hasText: taskTitle });
    await card.getByRole("button", { name: "Ready" }).click();
    await page
      .getByLabel("Ready column")
      .locator("li", { hasText: taskTitle })
      .getByRole("button", { name: "Launch" })
      .click();

    // The Task stays Running because its agent is waiting for us.
    await expect(cardIn(page, "Running", taskTitle)).toBeVisible();
    await cardIn(page, "Running", taskTitle).click();
    await expect(page).toHaveURL(/\/task\/[0-9a-f-]+$/);

    const box = page.getByLabel("Message the agent");
    await expect(box).toBeEnabled();
    await box.fill("check the heater fuse too");
    await page.getByRole("button", { name: "Send" }).click();

    // SPA → hub → registry → the agent for *this* Task → back down the stream (TASK-022).
    await expect(page.getByText("agent received: check the heater fuse too")).toBeVisible();
    // Having taken the instruction the agent finishes, so the review gate opens.
    await expect(page.locator('[data-task-state="review"]')).toBeVisible();
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
    await page.goto("/board");
    await createIssue(page, issueTitle);
    await createTask(page, { title: taskTitle, issue: issueTitle });
    await expect(cardIn(page, "Backlog", taskTitle)).toBeVisible();

    const taskId = await launchToReview(page, taskTitle);

    // The agent's output is on screen — streamed live and replayed from the session log.
    await expect(page.getByText(/agent edited/)).toBeVisible();

    // And the change itself is reviewable in the app: the files the agent actually wrote, with
    // their line counts, not just the name of a branch (TASK-022).
    await page.getByRole("tab", { name: "Changes" }).click();
    // Scoped to the file list: each path also appears several times inside the patch below it.
    const changed = page.getByLabel("Changed files");
    await expect(changed.getByText(`marker-${taskId}.txt`)).toBeVisible();
    await expect(changed.getByText("visible.txt")).toBeVisible();
    // …and the patch body carries the line the agent actually wrote.
    await expect(page.getByText(/^\+edited by the agent/)).toBeVisible();

    await page.getByRole("button", { name: "Approve" }).click();

    // The workflow committed the change and moved the Task to Done. The state is read from the
    // header badge specifically — the lifecycle labels also appear in the shell navigator.
    await expect(page.locator('[data-task-state="done"]')).toBeVisible();
    const branch = `gatecontrol/task-${taskId}`;
    // Shown twice now, in the task header and at the top of the diff, so take the first: the
    // assertion is that the result branch is surfaced at all, not where.
    await expect(page.getByText(branch).first()).toBeVisible();

    // …and the branch really exists in the repository, with the agent's file on it. Polled:
    // the API answers as soon as the state is written, a moment before the step returns.
    expect(git(["branch", "--list", branch])).toContain(branch);
    await expect
      .poll(() => git(["show", "--name-only", "--format=", branch]))
      .toContain(`marker-${taskId}.txt`);
    expect(git(["show", `${branch}:marker-${taskId}.txt`])).toContain("edited by the agent");
    // No push, no PR: the change lives only on the local branch (spec FR-009).
    expect(git(["remote"])).toBe("");
  });

  test("rejecting a diff discards the agent's changes", async ({ page }) => {
    const stamp = Date.now();
    const issueTitle = `Keypad flicker ${stamp}`;
    const taskTitle = `Debounce the backlight ${stamp}`;

    await ensureRepository(page);
    await page.goto("/board");
    await createIssue(page, issueTitle);
    await createTask(page, { title: taskTitle, issue: issueTitle });

    const taskId = await launchToReview(page, taskTitle);
    await page.getByRole("button", { name: "Reject" }).click();
    // Rejecting discards the agent's work, so it is confirmed rather than done on one click.
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Discard the changes" })
      .click();

    // The Task returns to Ready and the worktree is torn down — nothing was committed.
    await expect(page.locator('[data-task-state="ready"]')).toBeVisible();
    const branch = `gatecontrol/task-${taskId}`;
    await expect.poll(() => existsSync(join(PATHS.worktrees, taskId))).toBe(false);
    expect(git(["log", "--oneline", branch, "--"])).not.toContain("GateControl");
  });
});
