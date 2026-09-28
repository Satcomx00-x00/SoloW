import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  EXECUTOR_PROFILE_NAME,
  HARNESS_PROFILE_NAME,
  PATHS,
  SEED_WORKSPACE_A,
} from "../support/fixture.js";
import {
  connectRepository,
  createTask,
  launchTask,
  launchToReview,
  openReview,
  openTask,
  trpc,
} from "../support/flows.js";
import { seedIssue } from "../support/seed.js";

/**
 * Sub-tasks (issue #56), driven the way an operator splits work: from the rail of a Task page.
 *
 * `isolation.spec.ts` already holds the @critical half — a child gets a worktree of its own. This
 * file is the rest of the contract a person relies on: what the child inherits, that its brief
 * carries the parent's transcript up to the fork point (and says nothing when there is none),
 * where it is listed, and that deleting a parent takes its sub-tasks to History and restoring it
 * brings them back.
 */

const REPO_NAME = "e2e-fixture-repo";

type Launch = { home: string | null; prompt: string };

/** What the fixture harness was launched with for this Task (see `support/orchestrator.ts`). */
const launchOf = (taskId: string): Launch =>
  JSON.parse(readFileSync(join(PATHS.harnessRuns, `solow-task-${taskId}.json`), "utf8"));

async function ensureRepository(page: Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

const rail = (page: Page) => page.getByRole("complementary", { name: "About this task" });

/** Split the Task on screen from its rail and return the child's id, read off the rail's link. */
async function split(page: Page, title: string, opts: { fork?: boolean } = {}): Promise<string> {
  await rail(page).getByRole("button", { name: "Split into sub-task" }).click();
  const dialog = page.getByRole("dialog", { name: "Split into a sub-task" });
  await dialog.getByPlaceholder("What this piece is for").fill(title);
  if (opts.fork === false) {
    await dialog.getByRole("checkbox", { name: "Start from this task's transcript" }).uncheck();
  }
  await dialog.getByRole("button", { name: "Create sub-task" }).click();
  await expect(dialog).toBeHidden();
  const link = rail(page).getByRole("region", { name: "Sub-tasks" }).getByRole("link", {
    name: title,
  });
  return ((await link.getAttribute("href")) ?? "").split("/").pop() as string;
}

test.describe("sub-tasks", () => {
  // Each of these walks several Tasks through real runs and page loads, and on the e2e
  // `next dev` a page load costs 5–10 s and a tRPC batch 1–3 s: the runner's 180 s default
  // cut them off while still passing. The budget follows the walk, as the control check's does.
  test.describe.configure({ timeout: 6 * 60_000 });

  test("a split off a run Task inherits its setup and is briefed with the parent's transcript", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Too big ${stamp}`;
    const parentTitle = `Do all of it ${stamp}`;
    const childTitle = `Just the first part ${stamp}`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: parentTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const parentId = await openTask(page, issue.id, parentTitle);
    await launchToReview(page);
    const parentBrief = launchOf(parentId).prompt;

    const childId = await split(page, childTitle);
    // Listed under its parent with its state — a new sub-task waits in the backlog.
    await expect(
      rail(page).getByRole("region", { name: "Sub-tasks" }).getByRole("link", { name: childTitle }),
    ).toContainText("Backlog");

    await page.goto(`/task/${childId}`);
    await expect(page.getByRole("heading", { name: childTitle })).toBeVisible();

    // AC-2: nobody restated the harness, executor, repository or Issue — they came from the parent.
    type Setup = {
      issueId: string;
      agentProfileId: string;
      executorProfileId: string;
      repositories: { repositoryId: string }[];
    };
    const setupOf = async (id: string) => {
      const t = await trpc<Setup>(page, "task.get", { id }, "query");
      return {
        issueId: t.issueId,
        agentProfileId: t.agentProfileId,
        executorProfileId: t.executorProfileId,
        repositories: t.repositories.map((r) => r.repositoryId),
      };
    };
    expect(await setupOf(childId)).toEqual(await setupOf(parentId));
    const run = rail(page).getByRole("region", { name: "Run" });
    await expect(run).toContainText(HARNESS_PROFILE_NAME);
    await expect(run).toContainText(EXECUTOR_PROFILE_NAME);
    await page.goto(`/issues/${issue.id}`);
    await expect(
      page.getByLabel("Tasks for this issue").getByRole("link", { name: childTitle, exact: true }),
    ).toBeVisible();

    // AC-3: the child's harness starts from the parent's transcript, not a cold prompt. The
    // parent's run said "harness edited solow-task-<parent>"; that line reaches the child's brief.
    await page.goto(`/task/${childId}`);
    await launchTask(page);
    await expect(
      page.locator('[data-task-state="running"], [data-task-state="review"]').first(),
    ).toBeVisible();
    await expect
      .poll(() => launchOf(childId).prompt, { timeout: 60_000 })
      .toContain("# Where this came from");
    const childBrief = launchOf(childId).prompt;
    expect(childBrief).toContain(`harness edited solow-task-${parentId}`);
    expect(childBrief).toContain(childTitle);
    // Settled at the gate, so the run does not hold a concurrency slot the next spec needs.
    await openReview(page);

    // AC-4: the parent was only read — its own record of the launch is exactly what it was.
    expect(launchOf(parentId).prompt).toBe(parentBrief);
    expect(parentBrief).not.toContain("# Where this came from");
  });

  test("a split with the transcript turned off, or off a Task that never ran, starts cold", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Cold splits ${stamp}`;
    const ranTitle = `Ran once ${stamp}`;
    const idleTitle = `Never ran ${stamp}`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: ranTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    await createTask(page, {
      title: idleTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });

    // Opted out: the parent has a transcript, and the operator chose not to carry it.
    await openTask(page, issue.id, ranTitle);
    await launchToReview(page);
    const optedOut = await split(page, `Opted out ${stamp}`, { fork: false });

    // Nothing to carry: the option is offered disabled, with the reason beside it.
    await openTask(page, issue.id, idleTitle);
    await rail(page).getByRole("button", { name: "Split into sub-task" }).click();
    const dialog = page.getByRole("dialog", { name: "Split into a sub-task" });
    await expect(
      dialog.getByRole("checkbox", { name: "Start from this task's transcript" }),
    ).toBeDisabled();
    await expect(dialog).toContainText("has not run yet");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    const fromIdle = await split(page, `From the idle one ${stamp}`);

    for (const id of [optedOut, fromIdle]) {
      await page.goto(`/task/${id}`);
      await launchTask(page);
      await expect.poll(() => launchOf(id).prompt, { timeout: 60_000 }).toBeTruthy();
      expect(launchOf(id).prompt).not.toContain("# Where this came from");
      await openReview(page);
    }
  });

  test("deleting a parent takes its sub-tasks to History, and restoring it brings them back", async ({
    page,
  }) => {
    const stamp = Date.now();
    const issueTitle = `Subtree ${stamp}`;
    const parentTitle = `Parent ${stamp}`;
    const childTitle = `Child ${stamp}`;
    const grandchildTitle = `Grandchild ${stamp}`;

    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: parentTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const parentId = await openTask(page, issue.id, parentTitle);
    const childId = await split(page, childTitle);
    await page.goto(`/task/${childId}`);
    const grandchildId = await split(page, grandchildTitle);

    // Two levels of breadcrumb on the grandchild: where it came from, all the way up.
    await page.goto(`/task/${grandchildId}`);
    const crumbs = page.getByRole("navigation", { name: "Split from" });
    await expect(crumbs.getByRole("link", { name: parentTitle })).toBeVisible();
    await expect(crumbs.getByRole("link", { name: childTitle })).toBeVisible();

    // Delete the root. None of them ever ran, so it goes on the press with no dialog. Where the
    // delete lands is the unassigned list, visited once first for the reason `workspace.spec.ts`
    // gives: under the e2e `next dev` its first compile takes long enough that the page's own
    // push back to it arrives in the middle of whatever the test does next.
    await page.goto("/unassigned");
    await page.goto(`/task/${parentId}`);
    await page.getByRole("button", { name: `Delete ${parentTitle}` }).click();
    await page.waitForURL((url) => !url.pathname.startsWith("/task/"));

    // The whole subtree went, under one timestamp — the shared `deletedAt` is what lets a
    // restore bring back exactly these Tasks. Read through the API: one request per Task instead
    // of a page load each, on a dev server where a page load costs seconds.
    const deletedAt = async (id: string) =>
      (
        await trpc<{ deletedAt: string | null }>(
          page,
          "task.get",
          { id, includeDeleted: true },
          "query",
        )
      ).deletedAt;
    const when = await deletedAt(parentId);
    expect(when).not.toBeNull();
    expect(await deletedAt(childId)).toBe(when);
    expect(await deletedAt(grandchildId)).toBe(when);
    await page.goto(`/issues/${issue.id}`);
    const live = page.getByLabel("Tasks for this issue");
    for (const title of [parentTitle, childTitle, grandchildTitle]) {
      await expect(live.getByRole("link", { name: title, exact: true })).toHaveCount(0);
    }

    // Restoring the root, from its page in History, restores exactly what went with it — and
    // the parent's rail lists its sub-task again.
    await page.goto(`/task/${parentId}`);
    await expect(page.locator("[data-task-deleted]")).toBeVisible();
    await page.getByRole("button", { name: "Restore" }).click();
    await expect(page.locator("[data-task-deleted]")).toHaveCount(0);
    expect(await deletedAt(childId)).toBeNull();
    expect(await deletedAt(grandchildId)).toBeNull();
    await expect(
      rail(page).getByRole("region", { name: "Sub-tasks" }).getByRole("link", { name: childTitle }),
    ).toBeVisible();
  });
});
