import { existsSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
  EXECUTOR_PROFILE_NAME,
  HARNESS_PROFILE_NAME,
  PATHS,
  SEED_WORKSPACE_A,
} from "../support/fixture.js";
import { connectRepository, createTask, launchTask, openTask, trpc } from "../support/flows.js";
import { seedIssue } from "../support/seed.js";

/**
 * Workspace controls (spec F16), as an Owner meets them: the theme, what a new Task starts as,
 * a feature switched off and back on, the project picker, and emptying the Workspace.
 *
 * Every test that changes a per-user or per-Workspace setting puts it back in `afterEach`,
 * through the API rather than the UI — a failed assertion halfway through must not leave the
 * next spec running light, with defaults preset, or with Workflows switched off.
 */

const REPO_NAME = "e2e-fixture-repo";

// String form, as in `shell.spec.ts`: this project has no DOM types, and browser code belongs
// in a scope that visibly is not Node's.
const isDark = (page: Page) =>
  page.evaluate("document.documentElement.classList.contains('dark')") as Promise<boolean>;

/**
 * One of the three theme cards, by its hint. The label text alone is ambiguous: the section's
 * status line says "Light" or "Dark" too, and the radio itself is visually hidden in its card.
 */
const themeOption = (page: Page, hint: string) => page.locator("label").filter({ hasText: hint });

async function ensureRepository(page: Page): Promise<void> {
  await page.goto("/settings?section=repositories");
  await connectRepository(page, REPO_NAME, PATHS.repo);
}

test.describe("workspace controls", () => {
  // Each of these walks several Tasks through real runs and page loads, and on the e2e
  // `next dev` a page load costs 5–10 s and a tRPC batch 1–3 s: the runner's 180 s default
  // cut them off while still passing. The budget follows the walk, as the control check's does.
  test.describe.configure({ timeout: 6 * 60_000 });

  test.afterEach(async ({ page }) => {
    await trpc(page, "preference.setAppearance", { theme: "dark" }, "mutation");
    await trpc(
      page,
      "preference.setTaskDefaults",
      { harnessProfileId: null, executorProfileId: null },
      "mutation",
    );
    await trpc(page, "flag.set", { key: "ff-workflows", enabled: true }, "mutation");
  });

  test("the theme changes on the press, is painted before the first frame, and follows you to another browser", async ({
    page,
    browser,
  }) => {
    // What the class was when the document finished parsing — before React, before any
    // request. A theme applied later than this is a flash, whatever the page looks like after.
    await page.addInitScript(
      "document.addEventListener('DOMContentLoaded', () => { window.__darkAtParse = document.documentElement.classList.contains('dark'); });",
    );
    await page.goto("/settings?section=appearance");
    // A fresh install looks the way it always did.
    expect(await isDark(page)).toBe(true);

    await themeOption(page, "Always light").click();
    await expect.poll(() => isDark(page)).toBe(false);
    // Stored before the reload: until it is, the server still says dark, and the row wins.
    await expect
      .poll(
        async () =>
          (
            await trpc<{ appearance: { theme: string } }>(
              page,
              "preference.getAppearance",
              {},
              "query",
            )
          ).appearance.theme,
      )
      .toBe("light");

    await page.reload();
    expect(await page.evaluate("window.__darkAtParse")).toBe(false);
    await expect(page.getByRole("radio", { name: /Light/ })).toBeChecked();

    // Another browser has none of this one's cache: the stored preference is what reaches it.
    const other = await browser.newContext();
    const elsewhere = await other.newPage();
    await elsewhere.goto("/projects");
    await expect.poll(() => isDark(elsewhere), { timeout: 30_000 }).toBe(false);
    await other.close();

    // System follows the machine, live.
    await page.emulateMedia({ colorScheme: "light" });
    await themeOption(page, "Follow this machine").click();
    await expect.poll(() => isDark(page)).toBe(false);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(page)).toBe(true);
  });

  test("a new Task opens on the harness and executor chosen as defaults", async ({ page }) => {
    const stamp = Date.now();
    const issueTitle = `Defaults ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);

    // Before: nothing chosen, and the form asks.
    await page.goto(`/issues/${issue.id}`);
    await page.getByLabel("Tasks for this issue").getByRole("button", { name: "New task" }).click();
    let dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog.getByRole("combobox", { name: "Harness profile" })).not.toContainText(
      HARNESS_PROFILE_NAME,
    );
    await page.keyboard.press("Escape");

    await page.goto("/settings?section=task-defaults");
    await page.getByRole("combobox", { name: "Default harness profile" }).click();
    await page.getByRole("option", { name: HARNESS_PROFILE_NAME }).click();
    await page.getByRole("combobox", { name: "Default executor" }).click();
    await page.getByRole("option", { name: EXECUTOR_PROFILE_NAME }).click();
    await expect(page.getByText("2 of 2 set")).toBeVisible();

    await page.goto(`/issues/${issue.id}`);
    await page.getByLabel("Tasks for this issue").getByRole("button", { name: "New task" }).click();
    dialog = page.getByRole("dialog", { name: "New task" });
    await expect(dialog.getByRole("combobox", { name: "Harness profile" })).toContainText(
      HARNESS_PROFILE_NAME,
    );
    await expect(dialog.getByRole("combobox", { name: "Executor" })).toContainText(
      EXECUTOR_PROFILE_NAME,
    );

    // A default, not a lock: the Task is created without touching either picker.
    const title = `Created on defaults ${stamp}`;
    await dialog.getByLabel("Title").fill(title);
    await dialog.getByRole("button", { name: "Create task" }).click();
    await expect(dialog).toBeHidden();
    await openTask(page, issue.id, title);
    const run = page.getByRole("complementary", { name: "About this task" }).getByRole("region", {
      name: "Run",
    });
    await expect(run).toContainText(HARNESS_PROFILE_NAME);
    await expect(run).toContainText(EXECUTOR_PROFILE_NAME);
  });

  test("a feature switched off says who can turn it back on, and the link does", async ({
    page,
  }) => {
    // Flags ship on: a fresh Workspace has Workflows without anyone enabling it.
    await page.goto("/workflows");
    await expect(page.getByRole("alert").filter({ hasText: "not enabled" })).toHaveCount(0);

    await page.goto("/settings?section=flags");
    const toggle = page.getByRole("checkbox", { name: "Workflows", exact: true });
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    await page.goto("/workflows");
    const alert = page.getByRole("alert").filter({ hasText: "Workflows are not enabled here" });
    await expect(alert).toContainText("Someone turned this feature off");
    await expect(alert).toContainText("bun run flag enable ff-workflows");
    await alert.getByRole("link", { name: /Turn it back on/ }).click();
    await expect(page).toHaveURL(/section=flags/);

    await page.getByRole("checkbox", { name: "Workflows", exact: true }).click();
    await page.goto("/workflows");
    await expect(page.getByRole("alert").filter({ hasText: "not enabled" })).toHaveCount(0);
  });

  test("the project picker switches project and keeps you on the same section", async ({
    page,
  }) => {
    const stamp = Date.now();
    const ids: string[] = [];
    for (const name of [`Picker A ${stamp}`, `Picker B ${stamp}`]) {
      await page.goto("/projects");
      await page.getByRole("button", { name: "Create a project" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Create a project" });
      await dialog.getByLabel("Project name").fill(name);
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+/);
      ids.push(new URL(page.url()).pathname.split("/")[2] ?? "");
    }
    const [a, b] = ids as [string, string];

    await page.goto(`/projects/${a}/board`);
    await page.getByRole("button", { name: `Picker A ${stamp} — switch project` }).click();
    await page.getByPlaceholder("Find a project…").fill(`Picker B ${stamp}`);
    await page.getByRole("option", { name: new RegExp(`Picker B ${stamp}`) }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${b}/board$`));
    await expect(
      page.getByRole("button", { name: `Picker B ${stamp} — switch project` }),
    ).toBeVisible();

    // A search that matches nothing says so; the way to make a project is always there.
    await page.getByRole("button", { name: `Picker B ${stamp} — switch project` }).click();
    await page.getByPlaceholder("Find a project…").fill(`no such project ${stamp}`);
    await expect(page.getByText("No project matches.")).toBeVisible();
    await page.getByPlaceholder("Find a project…").fill("");
    await page.getByRole("option", { name: "New or adopted project…" }).click();
    await expect(page).toHaveURL(/\/projects$/);

    for (const id of ids) await trpc(page, "project.delete", { projectId: id }, "mutation");
  });

  test("resetting work data empties the workspace's work and keeps its setup", async ({ page }) => {
    const stamp = Date.now();
    const issueTitle = `Before the reset ${stamp}`;
    const taskTitle = `Doomed ${stamp}`;
    await ensureRepository(page);
    const issue = seedIssue(SEED_WORKSPACE_A, issueTitle, REPO_NAME);
    await createTask(page, {
      title: taskTitle,
      issueId: issue.id,
      issue: issueTitle,
      repository: REPO_NAME,
    });
    const taskId = await openTask(page, issue.id, taskTitle);
    await launchTask(page);
    const worktree = join(PATHS.worktrees, `solow-task-${taskId}`);
    await expect.poll(() => existsSync(worktree), { timeout: 60_000 }).toBe(true);
    // Settled at the gate, so the reset is not racing a live harness.
    await expect(page.getByRole("main").getByRole("button", { name: "Open review" })).toBeVisible({
      timeout: 120_000,
    });

    const { name } = await trpc<{ name: string }>(page, "workspace.get", {}, "query");
    await page.goto("/settings?section=danger-zone");

    // The factory reset is guarded the same way; it is opened and backed out of, never run here.
    await page.getByRole("button", { name: "Erase everything" }).click();
    let dialog = page.getByRole("dialog", { name: "Factory reset" });
    await expect(dialog.getByRole("button", { name: "Erase everything" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();

    await page.getByRole("button", { name: "Reset work data" }).click();
    dialog = page.getByRole("dialog", { name: "Reset work data" });
    const confirm = dialog.getByRole("button", { name: "Reset work data" });
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${name} to confirm`).fill(`${name} nearly`);
    await expect(confirm).toBeDisabled();
    await dialog.getByLabel(`Type ${name} to confirm`).fill(name);
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(
      page.getByRole("status").filter({ hasText: /Removed [\d,]+ rows across/ }),
    ).toBeVisible();

    // The work is gone — row and worktree...
    await page.goto(`/task/${taskId}`);
    await expect(page.getByRole("heading", { name: taskTitle })).toHaveCount(0);
    await expect.poll(() => existsSync(worktree), { timeout: 60_000 }).toBe(false);
    // ...and the setup is not: the repository and the profiles a new Task needs are all still here.
    const repos = await trpc<{ items: { name: string }[] }>(page, "repository.list", {}, "query");
    expect(repos.items.map((r) => r.name)).toContain(REPO_NAME);
    const harnesses = await trpc<{ items: { name: string }[] }>(
      page,
      "profile.agent.list",
      {},
      "query",
    );
    expect(harnesses.items.map((p) => p.name)).toContain(HARNESS_PROFILE_NAME);
  });
});
