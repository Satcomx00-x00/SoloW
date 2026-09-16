import { expect, test } from "@playwright/test";
import { HARNESS_PROFILE_NAME, PATHS, SEED_WORKSPACE_A } from "../support/fixture.js";
import {
  connectRepository,
  createTask,
  launchTask,
  launchToReview,
  openTask,
  openWorkspaceTab,
} from "../support/flows.js";
import { seedIssue, seedIssueWithBrief } from "../support/seed.js";

/**
 * The Task page's own interactions — the frame around the run, not the run itself (which
 * `happy.spec.ts` covers): the four tabs and the pick in the URL, the rail beside the evidence
 * with the decision at its foot, Explain on a criterion answered by the Task's harness, the
 * held Stop, the terminal's filter count, and a delete that is undone from its toast.
 */

const REPO_NAME = "e2e-fixture-repo";

async function ensureRepository(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

test.describe("the Task page", () => {
  test("is four tabs: the pick is in the URL, survives a reload, and arrows move focus without switching", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Hinge squeaks ${stamp}`;
    const taskTitle = `Oil the hinge ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    await openTask(page, issue.id, taskTitle);
    await launchToReview(page);

    const tabs = page.getByRole("tablist", { name: "Task" });
    for (const name of ["Run", "Brief", "Plan", "Changes"]) {
      await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    }
    // At the gate with no criteria, the page opens on the change.
    await expect(tabs.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    await openWorkspaceTab(page, "Run");
    await expect(page).toHaveURL(/[?&]tab=run/);
    await page.reload();
    await expect(tabs.getByRole("tab", { name: "Run", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Manual activation: → moves the focus to Brief; Run stays the tab on screen until Enter.
    await tabs.getByRole("tab", { name: "Run", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Brief" })).toBeFocused();
    await expect(tabs.getByRole("tab", { name: "Run", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Enter");
    await expect(tabs.getByRole("tab", { name: "Brief" })).toHaveAttribute("aria-selected", "true");
  });

  test("keeps the dossier in a rail beside the evidence, with the decision at its foot", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Bell too quiet ${stamp}`;
    const taskTitle = `Raise the bell volume ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const taskId = await openTask(page, issue.id, taskTitle);
    await launchToReview(page);

    const rail = page.getByRole("complementary", { name: "About this task" });
    for (const name of ["Status", "Repository", "Dependencies", "Run"]) {
      await expect(rail.getByRole("region", { name })).toBeVisible();
    }
    // The branch, with its copy button on it; the harness, named on the page.
    await expect(rail.getByRole("region", { name: "Repository" })).toContainText(
      `solow-task-${taskId}`,
    );
    await expect(rail.getByRole("button", { name: "Copy branch name" })).toBeVisible();
    await expect(rail.getByRole("region", { name: "Run" })).toContainText(HARNESS_PROFILE_NAME);
    // The gate is in the rail, whichever tab is open.
    await openWorkspaceTab(page, "Plan");
    await expect(rail.getByRole("button", { name: "Approve" })).toBeVisible();
    await expect(rail.getByRole("button", { name: "Reject" })).toBeVisible();
  });

  test("explains a criterion on the Brief tab, from the task's own harness, and folds it away", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Sensor drifts ${stamp}`;
    const taskTitle = `Recalibrate the sensor ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssueWithBrief(SEED_WORKSPACE_A, issueTitle, REPO_NAME, [
      "The harness leaves a marker file in its worktree.",
      "Nothing outside the worktree is touched.",
    ]);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    await openTask(page, issue.id, taskTitle);
    await launchToReview(page);

    // With criteria to verify, the gate opens on the brief — and says how many are left.
    const tabs = page.getByRole("tablist", { name: "Task" });
    await expect(tabs.getByRole("tab", { name: "Brief" })).toHaveAttribute("aria-selected", "true");
    const brief = page.getByRole("region", { name: "Acceptance criteria" });
    await expect(brief.getByText("AC-1", { exact: true })).toBeVisible();
    await expect(brief.getByText("AC-2", { exact: true })).toBeVisible();

    // Nothing is explained until asked; the answer lands under the criterion it is about.
    const explanation = page.locator('[data-criterion-explanation="AC-2"]');
    await expect(explanation).toHaveCount(0);
    await brief.getByRole("button", { name: "Explain AC-2" }).click();
    await expect(explanation).toContainText("explains AC-2");
    await expect(explanation).toContainText("not part of the record");
    await expect(page.locator('[data-criterion-explanation="AC-1"]')).toHaveCount(0);

    await brief.getByRole("button", { name: "Hide the explanation of AC-2" }).click();
    await expect(explanation).toHaveCount(0);
    await brief.getByRole("button", { name: "Explain AC-2" }).click();
    await expect(explanation).toContainText("explains AC-2");
  });

  test("stops a running harness on a held press, never on a click, and counts what a filter hides", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Lock jams ${stamp}`;
    const taskTitle = `Free the lock ${stamp} [steerable]`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    await openTask(page, issue.id, taskTitle);
    await launchTask(page);
    await expect(page.getByLabel("Message the harness")).toBeEnabled();
    await expect(page.getByText(/harness edited/)).toBeVisible();

    // The terminal's filters say how much they hid, the moment they are pressed.
    const filters = page.getByRole("group", { name: "Transcript filters" });
    await filters.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.locator("[data-transcript-shown]")).toContainText(/\d+ of \d+/);
    await filters.getByRole("button", { name: "Tools", exact: true }).click();
    await expect(page.locator("[data-transcript-shown]")).toHaveCount(0);

    // A click is exactly the gesture the hold exists to refuse.
    const stop = page.getByRole("button", { name: "Stop" });
    await stop.click();
    await expect(page.getByText("harness stopped by the operator")).toHaveCount(0);
    await expect(stop).toBeEnabled();

    // Held for the fill to cross it, the stop goes.
    const box = await stop.boundingBox();
    if (!box) throw new Error("Stop has no box");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(600);
    await page.mouse.up();
    await expect(page.getByText("harness stopped by the operator")).toBeVisible();
  });

  test("deletes a task on the press and undoes it from the toast", async ({ page }) => {
    const stamp = Date.now();
    const issueTitle = `Spare part ${stamp}`;
    const taskTitle = `Order the spare ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const taskId = await openTask(page, issue.id, taskTitle);
    // Where the delete lands is the unassigned list; visited once now so that, under the e2e
    // `next dev`, its first compile (10–20s on this host) does not eat the toast's ten seconds.
    await page.goto("/unassigned");
    await page.goto(`/task/${taskId}`);
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();

    // No dialog for a Task with no run and nothing waiting on it: it goes on the press, with
    // Undo on the toast — and Undo means it.
    await page.getByRole("button", { name: `Delete ${taskTitle}` }).click();
    await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}$`));
    const toast = page.getByRole("status").filter({ hasText: `Deleted "${taskTitle}"` });
    await expect(toast).toBeVisible();
    await toast.getByRole("button", { name: "Undo" }).click();
    await page.goto(`/task/${taskId}`);
    await expect(page.getByRole("heading", { name: taskTitle })).toBeVisible();
    await expect(page.locator("[data-task-deleted]")).toHaveCount(0);

    // Deleted for real, the page says so and offers Restore, and nothing else acts on it.
    await page.getByRole("button", { name: `Delete ${taskTitle}` }).click();
    await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}$`));
    await page.goto(`/task/${taskId}`);
    await expect(page.locator("[data-task-deleted]")).toBeVisible();
    await expect(page.getByRole("button", { name: "Restore" })).toBeVisible();
    await expect(page.getByRole("button", { name: `Delete ${taskTitle}` })).toHaveCount(0);
  });
});
