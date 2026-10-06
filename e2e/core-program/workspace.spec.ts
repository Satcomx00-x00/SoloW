import { expect, test } from "@playwright/test";
import {
  HARNESS_PROFILE_NAME,
  PATHS,
  SCRIPTED_LINKS,
  SEED_WORKSPACE_A,
} from "../support/fixture.js";
import {
  closeGate,
  connectRepository,
  createTask,
  gateButton,
  launchTask,
  launchToReview,
  openGate,
  openTask,
  openWorkspaceTab,
  sessionLog,
  taskIdOnPage,
} from "../support/flows.js";
import { seedIssue, seedIssueWithBrief } from "../support/seed.js";

/**
 * The Task page's own interactions — the frame around the run, not the run itself (which
 * `happy.spec.ts` covers): the four tabs and the pick in the URL, the rail beside the evidence
 * with the decision at its foot, Explain on a criterion answered by the Task's harness, the
 * held Stop, and a delete that is undone from its toast.
 */

const REPO_NAME = "e2e-fixture-repo";

async function ensureRepository(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

test.describe("the Task page", () => {
  // Each of these walks a real run and several page loads on the e2e `next dev`, which on a
  // loaded host costs 2–4 s a request: the delete-and-undo case measured 3.9 min passing, past
  // the runner's 180 s default. The budget follows the walk, as in `subtasks.spec.ts`.
  test.describe.configure({ timeout: 6 * 60_000 });

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
    for (const name of ["Board", "Brief", "Changes"]) {
      await expect(tabs.getByRole("tab", { name, exact: true })).toBeVisible();
    }
    // At the gate the page opens on the board, where the gate is.
    await expect(tabs.getByRole("tab", { name: "Board" })).toHaveAttribute("aria-selected", "true");

    await openWorkspaceTab(page, "Brief");
    await expect(page).toHaveURL(/[?&]tab=brief/);
    await page.reload();
    await expect(tabs.getByRole("tab", { name: "Brief", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    // Manual activation: → moves the focus to Changes; Brief stays on screen until Enter.
    await tabs.getByRole("tab", { name: "Brief", exact: true }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(tabs.getByRole("tab", { name: "Changes" })).toBeFocused();
    await expect(tabs.getByRole("tab", { name: "Brief", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.keyboard.press("Enter");
    await expect(tabs.getByRole("tab", { name: "Changes" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  test("keeps the dossier in the left pane, and the decision on the board and under the change", async ({
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
    for (const name of ["Status", "Repository", "Links", "Dependencies", "Run"]) {
      await expect(rail.getByRole("region", { name })).toBeVisible();
    }
    // The branch, with its copy button on it; the harness, named on the page.
    await expect(rail.getByRole("region", { name: "Repository" })).toContainText(
      `solow-task-${taskId}`,
    );
    await expect(rail.getByRole("button", { name: "Copy branch name" })).toBeVisible();
    await expect(rail.getByRole("region", { name: "Run" })).toContainText(HARNESS_PROFILE_NAME);
    // The gate is a card on the board that opens a dialog, and a strip under the change that
    // opens the same one.
    const gate = await openGate(page);
    await expect(gate.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(gate.getByRole("button", { name: "Reject", exact: true })).toBeVisible();
    await closeGate(page);
    await openWorkspaceTab(page, "Changes");
    await expect(page.locator("[data-gate-strip]")).toBeVisible();
    await expect(await gateButton(page, "Approve")).toBeVisible();
  });

  test("lists what the run opened outside SoloW — the merge request and the pipeline, as links", async ({
    page,
  }) => {
    // F10 FR-12a. The harness opens the merge request; SoloW opens none. What is under test is
    // that the URLs its shell printed are read back out of the Session log and offered as doors,
    // so a reviewer never has to scroll a transcript for one and copy it out of a `<pre>`.
    const stamp = Date.now();
    const issueTitle = `Latch sticks ${stamp}`;
    const taskTitle = `Ship the latch fix ${stamp} [opens-mr]`;
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

    const rail = page.getByRole("complementary", { name: "About this task" });
    const links = rail.getByRole("region", { name: "Links" });

    // Named the way the forge names them, and pointing at the resource itself.
    const mr = links.getByRole("link", { name: /Merge request !42/ });
    await expect(mr).toBeVisible();
    await expect(mr).toHaveAttribute("href", SCRIPTED_LINKS.mergeRequest);
    await expect(mr).toHaveAttribute("target", "_blank");
    const pipeline = links.getByRole("link", { name: /Pipeline #1204/ });
    await expect(pipeline).toBeVisible();
    await expect(pipeline).toHaveAttribute("href", SCRIPTED_LINKS.pipeline);

    // The proposal before the pipeline, whatever order the shell printed them in.
    await expect(links.getByRole("link").first()).toHaveAttribute(
      "href",
      SCRIPTED_LINKS.mergeRequest,
    );

    // And the negative: `git push` offers to open a merge request on every push to a new
    // branch. Nothing opened that one, so it is not among the things this run did.
    await expect(links.locator(`a[href="${SCRIPTED_LINKS.offer}"]`)).toHaveCount(0);
    await expect(links.getByRole("link")).toHaveCount(2);

    // The evidence is still where it was — the links are a reading of the log, not a
    // replacement for it.
    await expect
      .poll(() => sessionLog(page, taskIdOnPage(page)))
      .toContain("glab mr create --fill --yes");
  });

  test("says a run that opened nothing opened nothing, rather than showing an empty box", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Hinge drips ${stamp}`;
    const taskTitle = `Wipe the hinge ${stamp}`;
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

    const links = page
      .getByRole("complementary", { name: "About this task" })
      .getByRole("region", { name: "Links" });
    await expect(links).toContainText("opened nothing outside this app");
    await expect(links.getByRole("link")).toHaveCount(0);
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

    // With criteria to verify, the gate's chip says how many — and opens the brief.
    const tabs = page.getByRole("tablist", { name: "Task" });
    await page
      .locator('[data-board-kind="gate"]')
      .getByRole("button", { name: /0\/2 criteria/ })
      .click();
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
    // The steer box and its held Stop sit under the board while the run is going.
    await expect(page.getByLabel("Message the harness")).toBeEnabled();
    await expect.poll(() => sessionLog(page, taskIdOnPage(page))).toContain("harness edited");

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
