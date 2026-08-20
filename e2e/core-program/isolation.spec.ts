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
/** The second Repository a multi-repository Task attaches (issue #7). */
// Deliberately not a name with `e2e-fixture-repo` as a prefix: Playwright matches an accessible
// name by substring, so a second repository called `…-repo-2` would make every existing
// `Repository` selection in this suite — and in happy.spec.ts — ambiguous.
const REPO2_NAME = "e2e-shared-lib";
const OTHER_WORKSPACE = SEED_WORKSPACE_B;
const OTHER_WORKSPACE_TASK_TITLE = "Add debounce to the keypad backlight driver";
// Seeded once, at module load — the session under test belongs to Workspace A, this Task
// belongs to B (issue #15: there is no `issue.create` any more, so this is test-only seeding
// via `seed-cli.ts`, the same as `packages/db/src/seed.ts` and every unit test's fixtures).
const OTHER_WORKSPACE_TASK = seedTask(OTHER_WORKSPACE, OTHER_WORKSPACE_TASK_TITLE).id;

type Page = import("@playwright/test").Page;

async function connectRepository(page: Page, name: string, location: string): Promise<void> {
  // See the note in happy.spec.ts: decide only once the list has resolved, or a second copy of
  // the repository gets connected and the Repository selector becomes ambiguous.
  await expect(page.getByLabel("Connected repositories")).toBeVisible();
  const badge = page.getByText(`${name} · local_path`);
  if (await badge.isVisible()) return;
  await page.getByLabel("Name").last().fill(name);
  await page.getByLabel("Location").fill(location);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(badge).toBeVisible();
}

async function ensureRepository(page: Page): Promise<void> {
  await page.goto("/settings");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

/** Both fixture repositories connected, for the multi-repository Task (issue #7). */
async function ensureBothRepositories(page: Page): Promise<void> {
  await page.goto("/settings");
  await connectRepository(page, REPO_NAME, PATHS.repo);
  await connectRepository(page, REPO2_NAME, PATHS.repo2);
}

async function pickOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

async function createTask(
  page: Page,
  title: string,
  issue: string,
  /** Repositories to tick under "Also works in" — each becomes its own worktree and branch. */
  alsoWorksIn: readonly string[] = [],
): Promise<void> {
  await page.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(title);
  await pickOption(page, "Issue", issue);
  await pickOption(page, "Agent profile", "Claude Code (subscription)");
  await pickOption(page, "Executor", "Local executor");
  await pickOption(page, "Repository", REPO_NAME);
  for (const name of alsoWorksIn) {
    await dialog.getByRole("checkbox", { name, exact: true }).click();
  }
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

  test("a multi-Repository Task gets one isolated worktree per Repository (issue #7)", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Cross-repository work ${stamp}`;
    const title = `Task spanning two repos ${stamp}`;

    await ensureBothRepositories(page);
    await page.goto("/board");
    seedIssue(SEED_WORKSPACE_A, issueTitle);

    await createTask(page, title, issueTitle, [REPO2_NAME]);
    const id = await launchToReview(page, title);

    // The primary worktree is the one the agent made, at exactly the path a single-Repository
    // Task has always used. The secondary is a sibling GateControl provisioned, named for the
    // attachment — no Owner-authored text ever reaches the path.
    const primary = join(PATHS.worktrees, `gatecontrol-task-${id}`);
    const siblings = readdirSync(PATHS.worktrees).filter((entry) => entry.startsWith(`${id}--`));
    expect(siblings).toHaveLength(1);
    const secondary = join(PATHS.worktrees, siblings[0] as string);

    // Each worktree holds only its own Repository's content: the marker the agent wrote is in
    // the primary and nowhere else, and the second Repository's file is only in the secondary.
    expect(readdirSync(primary)).toContain(`marker-gatecontrol-task-${id}.txt`);
    expect(readdirSync(primary)).toContain("README.md");
    expect(readdirSync(primary)).not.toContain("LIB.md");
    expect(readdirSync(secondary)).toContain("LIB.md");
    expect(readdirSync(secondary)).not.toContain("README.md");
    expect(readdirSync(secondary)).not.toContain(`marker-gatecontrol-task-${id}.txt`);

    // ...and the review page presents the change grouped per Repository, not as one flat list.
    await page.goto(`/task/${id}`);
    await page.getByRole("tab", { name: "Changes" }).click();
    // Exact, so a substring match can never make one group stand in for the other.
    await expect(page.getByLabel(`Changes in ${REPO_NAME}`, { exact: true })).toBeVisible();
    await expect(page.getByLabel(`Changes in ${REPO2_NAME}`, { exact: true })).toBeVisible();
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
