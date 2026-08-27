import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { PATHS, SEED_WORKSPACE_A, SEED_WORKSPACE_B } from "../support/fixture.js";
import {
  connectRepository,
  createTask,
  launchTask,
  launchToReview,
  openTask,
} from "../support/flows.js";
import { seedIssue, seedTask } from "../support/seed.js";

/**
 * @critical isolation E2E (task TASK-026 — blocks merge).
 *
 * Two independent guarantees, both non-negotiable:
 *  · Principle II — concurrent Tasks work in separate worktrees and never observe each other's
 *    files.
 *  · Principle V — a user of one Workspace cannot reach another Workspace's work, through the
 *    UI or through the API, and no data about it leaks in the refusal.
 *
 * Driven through today's journey (Create menu → Issue page → Task page — see
 * `support/flows.ts`); the assertions themselves are unchanged, because the principles are.
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

/** `git` inside one of the fixture repositories — how a branch's existence is checked for real. */
const gitIn = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

async function ensureRepository(page: Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

/** Both fixture repositories connected, for the multi-repository Task (issue #7). */
async function ensureBothRepositories(page: Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
  await connectRepository(page, REPO2_NAME, PATHS.repo2);
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
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);

    await createTask(page, { title: titleA, issue: issueTitle, repository: REPO_NAME });
    await createTask(page, { title: titleB, issue: issueTitle, repository: REPO_NAME });

    /*
     * Launches are staggered so two `git worktree add` calls do not contend for the repo lock;
     * both Tasks are still in flight together afterwards. "In flight" today means the agent has
     * declared and the run holds the gate open with the worktree live on disk — the Task never
     * enters review on its own, and it does not need to for this assertion: the worktrees are
     * the subject, and they exist from the launch until a decision.
     */
    const idA = await openTask(page, issue.id, titleA);
    await launchTask(page);
    const idB = await openTask(page, issue.id, titleB);
    await launchTask(page);
    expect(idA).not.toBe(idB);

    // Named by the agent: `claude --worktree solow-task-<id>` is what creates these.
    const pathA = join(PATHS.worktrees, `solow-task-${idA}`);
    const pathB = join(PATHS.worktrees, `solow-task-${idB}`);
    const filesA = readdirSync(pathA);
    const filesB = readdirSync(pathB);

    // Each worktree holds its own Task's marker and nothing of the other's.
    expect(filesA).toContain(`marker-solow-task-${idA}.txt`);
    expect(filesA).not.toContain(`marker-solow-task-${idB}.txt`);
    expect(filesB).toContain(`marker-solow-task-${idB}.txt`);
    expect(filesB).not.toContain(`marker-solow-task-${idA}.txt`);

    // And what each agent could actually see from inside its worktree was only its own file.
    expect(readFileSync(join(pathA, "visible.txt"), "utf8").trim()).toBe(
      `marker-solow-task-${idA}.txt`,
    );
    expect(readFileSync(join(pathB, "visible.txt"), "utf8").trim()).toBe(
      `marker-solow-task-${idB}.txt`,
    );
  });

  test("a multi-Repository Task gets one isolated worktree per Repository (issue #7)", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Cross-repository work ${stamp}`;
    const title = `Task spanning two repos ${stamp}`;

    await ensureBothRepositories(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);

    await createTask(page, {
      title,
      issue: issueTitle,
      repository: REPO_NAME,
      alsoWorksIn: [REPO2_NAME],
    });
    const id = await openTask(page, issue.id, title);
    await launchToReview(page);

    // The primary worktree is the one the agent made, at exactly the path a single-Repository
    // Task has always used. The secondary is a sibling SoloW provisioned, named for the
    // attachment — no Owner-authored text ever reaches the path.
    const primary = join(PATHS.worktrees, `solow-task-${id}`);
    const siblings = readdirSync(PATHS.worktrees).filter((entry) => entry.startsWith(`${id}--`));
    expect(siblings).toHaveLength(1);
    const secondary = join(PATHS.worktrees, siblings[0] as string);

    // Each worktree holds only its own Repository's content: the marker the agent wrote is in
    // the primary and nowhere else, and the second Repository's file is only in the secondary.
    expect(readdirSync(primary)).toContain(`marker-solow-task-${id}.txt`);
    expect(readdirSync(primary)).toContain("README.md");
    expect(readdirSync(primary)).not.toContain("LIB.md");
    expect(readdirSync(secondary)).toContain("LIB.md");
    expect(readdirSync(secondary)).not.toContain("README.md");
    expect(readdirSync(secondary)).not.toContain(`marker-solow-task-${id}.txt`);

    // ...and the review page presents the change grouped per `(repository, branch)`, not as one
    // flat list (issue #70 AC-1) — in the Changes column of the split pane, which is on screen
    // without a click. Anchored on the repository name rather than matched loosely, so one group
    // can never stand in for the other; the branch follows it in the same label because that is
    // what a group *is*.
    await expect(page.getByLabel(new RegExp(`^Changes in ${REPO_NAME} on `))).toBeVisible();
    await expect(page.getByLabel(new RegExp(`^Changes in ${REPO2_NAME} on `))).toBeVisible();

    // The consequence of the single decision, stated before it is taken (AC-2/AC-3). One
    // approval, two repositories — the reviewer must be able to read that without scrolling.
    await expect(page.getByText(/Approving covers 2 repositories, 2 branches/)).toBeVisible();

    // Approve once, and both branches exist afterwards. This is the claim that makes "one
    // decision, all consequences" true rather than merely displayed.
    await page.getByRole("button", { name: "Approve" }).click();
    const branch = `solow-task-${id}`;
    await expect
      .poll(() => gitIn(PATHS.repo, ["branch", "--list", branch]), { timeout: 20_000 })
      .toContain(branch);
    await expect
      .poll(() => gitIn(PATHS.repo2, ["branch", "--list"]), { timeout: 20_000 })
      .toContain(id);
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

  test("the issue lists only ever show this Workspace's work (Principle V)", async ({ page }) => {
    /*
     * This used to assert against the flat `/board`, which no longer exists — boards live inside
     * Projects now, and the fixture repository belongs to none. The principle is about listing
     * surfaces, not about the board specifically, so it moves to the listing surface a
     * project-less Workspace actually has: `/unassigned`. Workspace B's issue is seeded fresh
     * here rather than at module load, so the assertion cannot pass by the seed having failed.
     */
    const foreign = `Foreign issue ${Date.now()}`;
    seedIssue(OTHER_WORKSPACE, foreign);

    await page.goto("/unassigned");
    await expect(page.getByText(/issues?$/).first()).toBeVisible();
    await expect(page.getByText(foreign)).toHaveCount(0);
    await expect(page.getByText(OTHER_WORKSPACE_TASK_TITLE)).toHaveCount(0);
  });
});
