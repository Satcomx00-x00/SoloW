import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PATHS, SEED_WORKSPACE_A, SEED_WORKSPACE_B } from "../support/fixture.js";
import { seedIssue, seedTask } from "../support/seed.js";

/**
 * @critical isolation E2E (task TASK-026 — blocks merge).
 *
 * Two independent guarantees, both non-negotiable:
 *  · Principle II — concurrent Tasks work in separate worktrees and never observe each other's
 *    files.
 *  · Principle V — a user of one Workspace cannot reach another Workspace's Task, through the
 *    UI or through the API, and no data about it leaks in the refusal.
 */

const REPO_NAME = "e2e-fixture-repo";
const OTHER_WORKSPACE = SEED_WORKSPACE_B;
const OTHER_WORKSPACE_TASK_TITLE = "Add debounce to the keypad backlight driver";
// Seeded once, at module load — the session under test belongs to Workspace A, this Task
// belongs to B (issue #15: there is no `issue.create` any more, so this is test-only seeding
// via `seed-cli.ts`, the same as `packages/db/src/seed.ts` and every unit test's fixtures).
const OTHER_WORKSPACE_TASK = seedTask(OTHER_WORKSPACE, OTHER_WORKSPACE_TASK_TITLE).id;

type Page = import("@playwright/test").Page;

async function ensureRepository(page: Page): Promise<void> {
  await page.goto("/settings");
  // See the note in happy.spec.ts: decide only once the list has resolved, or a second copy of
  // the repository gets connected and the Repository selector becomes ambiguous.
  await expect(page.getByLabel("Connected repositories")).toBeVisible();
  const badge = page.getByText(`${REPO_NAME} · local_path`);
  if (await badge.isVisible()) return;
  await page.getByLabel("Name").last().fill(REPO_NAME);
  await page.getByLabel("Location").fill(PATHS.repo);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(badge).toBeVisible();
}

async function pickOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

async function createTask(page: Page, title: string, issue: string): Promise<void> {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await pickOption(page, "Issue", issue);
  await pickOption(page, "Agent profile", "Claude Code (subscription)");
  await pickOption(page, "Executor", "Local executor");
  await pickOption(page, "Repository", REPO_NAME);
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect(dialog).toBeHidden();
}

function cardIn(page: Page, column: string, title: string) {
  return page.getByLabel(`${column} column`).getByText(title, { exact: true });
}

/** Take a Task to the review gate and return its id — its worktree stays alive while it waits. */
async function launchToReview(page: Page, title: string): Promise<string> {
  await page
    .getByLabel("Backlog column")
    .locator("li", { hasText: title })
    .getByRole("button", { name: "Ready" })
    .click();
  await page
    .getByLabel("Ready column")
    .locator("li", { hasText: title })
    .getByRole("button", { name: "Launch" })
    .click();
  await expect(cardIn(page, "Review", title)).toBeVisible();

  await cardIn(page, "Review", title).click();
  await expect(page).toHaveURL(/\/task\/[0-9a-f-]+$/);
  const id = new URL(page.url()).pathname.split("/").pop() as string;
  await page.goto("/board");
  return id;
}

test.describe("@critical isolation", () => {
  test("concurrent Tasks never observe each other's worktree files (Principle II)", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Parallel work ${stamp}`;
    const titleA = `Task alpha ${stamp}`;
    const titleB = `Task beta ${stamp}`;

    await ensureRepository(page);
    await page.goto("/board");
    seedIssue(SEED_WORKSPACE_A, issueTitle);

    await createTask(page, titleA, issueTitle);
    await createTask(page, titleB, issueTitle);

    // Launches are staggered so two `git worktree add` calls do not contend for the repo lock;
    // both Tasks are still in flight together — each parked at its own review gate with its own
    // worktree live on disk, which is the state this assertion is about.
    const idA = await launchToReview(page, titleA);
    const idB = await launchToReview(page, titleB);
    expect(idA).not.toBe(idB);

    // Named by the agent: `claude --worktree gatecontrol-task-<id>` is what creates these.
    const pathA = join(PATHS.worktrees, `gatecontrol-task-${idA}`);
    const pathB = join(PATHS.worktrees, `gatecontrol-task-${idB}`);
    const filesA = readdirSync(pathA);
    const filesB = readdirSync(pathB);

    // Each worktree holds its own Task's marker and nothing of the other's.
    expect(filesA).toContain(`marker-gatecontrol-task-${idA}.txt`);
    expect(filesA).not.toContain(`marker-gatecontrol-task-${idB}.txt`);
    expect(filesB).toContain(`marker-gatecontrol-task-${idB}.txt`);
    expect(filesB).not.toContain(`marker-gatecontrol-task-${idA}.txt`);

    // And what each agent could actually see from inside its worktree was only its own file.
    expect(readFileSync(join(pathA, "visible.txt"), "utf8").trim()).toBe(
      `marker-gatecontrol-task-${idA}.txt`,
    );
    expect(readFileSync(join(pathB, "visible.txt"), "utf8").trim()).toBe(
      `marker-gatecontrol-task-${idB}.txt`,
    );
  });

  test("another Workspace's Task is unreachable by URL (Principle V)", async ({ page }) => {
    await page.goto(`/task/${OTHER_WORKSPACE_TASK}`);

    // The refusal is NOT_FOUND rather than FORBIDDEN by design: telling the caller the Task
    // exists would itself leak across the tenant boundary. (Filtered because Next.js keeps its
    // own empty `role="alert"` route announcer in the page.)
    await expect(page.getByRole("alert").filter({ hasText: "NOT_FOUND" })).toBeVisible();
    await expect(page.getByText(OTHER_WORKSPACE_TASK_TITLE)).toHaveCount(0);
  });

  test("another Workspace's Task is unreachable through the API (Principle V)", async ({
    request,
  }) => {
    const input = encodeURIComponent(JSON.stringify({ json: { id: OTHER_WORKSPACE_TASK } }));
    const res = await request.get(`/api/trpc/task.get?input=${input}`);

    expect(res.ok()).toBe(false);
    const body = await res.text();
    expect(body).toContain("NOT_FOUND");
    // Nothing about the other tenant's row comes back — not its title, not its Workspace id.
    expect(body).not.toContain(OTHER_WORKSPACE_TASK_TITLE);
    expect(body).not.toContain(OTHER_WORKSPACE);
  });

  test("the board only ever lists this Workspace's Tasks (Principle V)", async ({ page }) => {
    await page.goto("/board");
    await expect(page.getByLabel("Task board")).toBeVisible();
    await expect(page.getByText(OTHER_WORKSPACE_TASK_TITLE)).toHaveCount(0);
  });
});
