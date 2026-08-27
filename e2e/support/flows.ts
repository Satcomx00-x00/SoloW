import { expect, type Page } from "@playwright/test";

/**
 * The user journeys the E2E suite drives, as one shared vocabulary.
 *
 * These lived as near-identical private helpers in each spec file, and that duplication is how
 * the suite rotted without anyone noticing: the app moved the board under `/projects/:id` and
 * put the review gate behind an explicit "Open review" click, and two separate copies of the
 * same board-era helpers kept describing a product that no longer existed. One copy, imported by
 * every spec, fails loudly in one place the next time the shape of the app moves.
 *
 * The journey they encode is today's real one, verified by hand in a live browser before it was
 * written down here: a Task is created from the header's Create menu, opened from its Issue's
 * page, advanced with the Task page's own lifecycle arrows, and reviewed behind the gate the
 * operator opens — there is no flat `/board` any more, and no Task enters review on its own.
 */

/** Connect one local fixture repository through Settings, once — safe to call repeatedly. */
export async function connectRepository(page: Page, name: string, location: string): Promise<void> {
  // Wait for the list to actually resolve before deciding. Reading visibility straight after
  // navigating would answer "not there yet" while the query is still in flight, and every test
  // that did so would connect another copy of the same repository.
  await expect(page.getByLabel("Connected repositories")).toBeVisible();
  const badge = page.getByText(`${name} · local_path`);
  if (await badge.isVisible()) return;
  await page.getByLabel("Name").last().fill(name);
  await page.getByLabel("Location").fill(location);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(badge).toBeVisible();
}

async function pickOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

/**
 * Create a Task through the header's Create menu — the one entry point that exists on every
 * page, which is what replaced the board's own "New task" button.
 */
export async function createTask(
  page: Page,
  opts: {
    title: string;
    issue: string;
    repository: string;
    agentProfile?: string;
    /** Repositories ticked under Advanced → "Also works in": each gets its own worktree. */
    alsoWorksIn?: readonly string[];
  },
): Promise<void> {
  await page.getByRole("button", { name: "Create", exact: true }).click();
  await page.getByRole("menuitem", { name: /New task/ }).click();

  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(opts.title);
  // Repository before Issue: the Issue picker narrows to the chosen Repository (issue #15),
  // and picking a Repository resets any already-picked Issue — so Repository has to go first.
  await pickOption(page, "Repository", opts.repository);
  await pickOption(page, "Issue", opts.issue);
  await pickOption(page, "Agent profile", opts.agentProfile ?? "Claude Code (subscription)");
  await pickOption(page, "Executor", "Local executor");
  if (opts.alsoWorksIn && opts.alsoWorksIn.length > 0) {
    // A second repository is the exception, so the form folds it away — the disclosure has to
    // be opened before the checkboxes exist on screen.
    await dialog.getByText("Advanced", { exact: true }).click();
    for (const name of opts.alsoWorksIn) {
      await dialog.getByRole("checkbox", { name, exact: true }).click();
    }
  }
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
}

/**
 * Open a Task from its Issue's page and return its id.
 *
 * Through the Issue rather than a board: the Issue page is the one surface that lists a Task
 * wherever it lives, project or not — and the fixture repository belongs to no project, so for
 * this suite it is the only one.
 */
export async function openTask(page: Page, issueId: string, title: string): Promise<string> {
  await page.goto(`/issues/${issueId}`);
  await page
    .getByLabel("Tasks for this issue")
    .getByRole("link", { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(/\/task\/[0-9a-f-]+$/);
  return new URL(page.url()).pathname.split("/").pop() as string;
}

/**
 * Launch the Task from its own page: Backlog → Ready → Running, on the lifecycle arrows.
 *
 * `Move to Running` *is* the launch — `task.move` routes the transition into `running` through
 * the same start path the old board button used: same session, same concurrency cap.
 */
export async function launchTask(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Move to Ready" }).click();
  await expect(page.locator('[data-task-state="ready"]').first()).toBeVisible();
  await page.getByRole("button", { name: "Move to Running" }).click();
  await expect(page.locator('[data-task-state="running"]').first()).toBeVisible();
}

/**
 * Open the review gate once the agent has declared it is finished.
 *
 * The click is the point, not a detour: a run finishing no longer moves the Task to review on
 * its own — the agent declares, the page shows "Open review", and the transition is the
 * operator's (Principle I is a gate a human opens, not a conveyor).
 */
export async function openReview(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open review" }).click();
  await expect(page.locator('[data-task-state="review"]').first()).toBeVisible();
}

/** The whole run-up: launch, wait out the agent, open the gate. */
export async function launchToReview(page: Page): Promise<void> {
  await launchTask(page);
  await openReview(page);
}
