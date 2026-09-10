import { execFileSync } from "node:child_process";
import { expect, type Page, test } from "@playwright/test";
import { PATHS } from "../support/fixture.js";
import { connectRepository, createTask, openReview, openTask } from "../support/flows.js";

/**
 * The control check (@control): one pass through the product's main line, on this host, as a
 * person would do it — a Project, an Issue in it, a two-Step Workflow drawn on the canvas, a Task
 * launched through that Workflow, every Step's output read back, the change approved onto a
 * branch, the Issue closed, and everything it created removed again.
 *
 * It is not part of the CI suite (`playwright.config.ts` ignores `e2e/control/` unless
 * `SOLOW_CONTROL_CHECK=1`), and it is not a unit of anything: the point is the whole line, so
 * one test walks it end to end and each phase is a `test.step` so the report says where it broke.
 * Run it with `make control-check` before a commit to main that touches the loop.
 *
 * What is real: the SPA, tRPC, the DAL, the orchestrator's `runTaskLifecycle`, the Workflow
 * advance, the worktree manager and git. What is not: the harness, which is the deterministic
 * fixture runner every E2E uses — so "every Step's output" is that harness's, and the check is
 * that each Step ran, in order, in one worktree, and that its output is where the product says
 * it is.
 *
 * The Issue is created through the tRPC API rather than a form: a local Project's *New issue*
 * is provider-backed by design (`issueItemState`), and the only local-Issue form in the app is
 * the edit one. The API is the product's own surface — the one an MCP token or the OpenAPI
 * client uses — not a database seed.
 */

const REPO_NAME = "e2e-fixture-repo";

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: PATHS.repo, encoding: "utf8" }).trim();

/** One tRPC call over HTTP, the way the SPA makes it (superjson envelope, dev-owner session). */
async function trpc<T>(
  page: Page,
  path: string,
  input: unknown,
  kind: "query" | "mutation",
): Promise<T> {
  const url = `/api/trpc/${path}`;
  const res =
    kind === "query"
      ? await page.request.get(
          `${url}?input=${encodeURIComponent(JSON.stringify({ json: input }))}`,
        )
      : await page.request.post(url, { data: { json: input } });
  expect(res.ok(), `${path}: HTTP ${res.status()} ${await res.text()}`).toBe(true);
  const body = (await res.json()) as { result: { data: { json: T } } };
  return body.result.data.json;
}

async function pickOption(page: Page, label: string | RegExp, option: string | RegExp) {
  // Exact: "Gate" is also a substring of "Permissions for Investigate".
  await page.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

test.describe("control check — the main line of the product, end to end", () => {
  // The canvas is contextual: a Step card only shows its fields above a zoom level, and the
  // fit-to-view zoom depends on how much room the canvas has. A laptop-sized window, not
  // Playwright's 1280×720 default, so a two-Step pipeline fits at an editable zoom.
  test.use({ viewport: { width: 1920, height: 1080 } });

  test("project → issue → two-step workflow → task through it → every step's output → approve → close → cleanup @control", async ({
    page,
  }) => {
    // The whole line, on a cold dev server that compiles each route on first visit.
    test.setTimeout(600_000);
    const stamp = Date.now();
    const projectTitle = `Control check ${stamp}`;
    const issueTitle = `Control issue ${stamp}`;
    const workflowName = `Control pipeline ${stamp}`;
    const taskTitle = `Control task ${stamp}`;
    const stepNames = ["Investigate", "Implement"] as const;

    let projectId = "";
    let issueId = "";
    let workflowId = "";
    let taskId = "";

    await test.step("a repository is connected", async () => {
      await page.goto("/settings?section=repositories");
      await connectRepository(page, REPO_NAME, PATHS.repo);
    });

    await test.step("Workflows are switched on, from Settings", async () => {
      // Feature flags ship off, and a Workflow is what this check is for. The switch is the
      // product's own (Settings → Feature flags), not a database write.
      await page.goto("/settings?section=flags");
      const flag = page.getByRole("checkbox", { name: "Workflows" });
      await expect(flag).toBeVisible();
      if ((await flag.getAttribute("data-state")) !== "checked") await flag.click();
      await expect(flag).toHaveAttribute("data-state", "checked");
    });

    await test.step("create a local Project and register the repository under it", async () => {
      await page.goto("/projects");
      await page.getByRole("button", { name: "Create a project" }).first().click();
      const dialog = page.getByRole("dialog", { name: "Create a project" });
      await dialog.getByLabel("Project name").fill(projectTitle);
      await dialog.getByRole("button", { name: "Create" }).click();
      await expect(page).toHaveURL(/\/projects\/[0-9a-f-]+/);
      projectId = new URL(page.url()).pathname.split("/")[2] ?? "";
      expect(projectId).not.toBe("");

      await page.getByRole("button", { name: "Repositories" }).click();
      const repos = page.getByRole("dialog", { name: "Repositories" });
      await pickOption(page, "Attach a repository", new RegExp(`^${REPO_NAME} `));
      await expect(repos.getByText(REPO_NAME, { exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(repos).toBeHidden();
    });

    await test.step("create an Issue on that repository — it lands in the Project", async () => {
      const list = await trpc<{ items: { id: string; name: string }[] }>(
        page,
        "repository.list",
        {},
        "query",
      );
      const repo = list.items.find((r) => r.name === REPO_NAME);
      expect(repo, "the connected repository is listed by the API").toBeDefined();
      const issue = await trpc<{ id: string; title: string }>(
        page,
        "issue.create",
        { title: issueTitle, description: "Created by the control check.", repositoryId: repo?.id },
        "mutation",
      );
      issueId = issue.id;
      expect(issue.title).toBe(issueTitle);

      // Membership is a standing rule of a local Project: an Issue on a registered repository
      // is in it the moment it exists, no sync involved.
      await page.goto(`/projects/${projectId}`);
      await expect(page.getByText(issueTitle).first()).toBeVisible();
    });

    await test.step("draw a two-step Workflow on the canvas", async () => {
      await page.goto("/workflows");
      // The create form opens by itself once the list has loaded empty, so a click read off the
      // loading state can land after that and close it again. Ask for the field, and only
      // toggle when it is not there — retried, because the list settling is what decides.
      const toggle = page.getByRole("button", { name: "New workflow" });
      const nameField = page.getByRole("textbox", { name: "Workflow name" });
      await expect(async () => {
        if (!(await nameField.isVisible())) await toggle.click();
        await expect(nameField).toBeVisible({ timeout: 1_000 });
      }).toPass();
      await nameField.fill(workflowName);
      await page.getByRole("button", { name: "Create", exact: true }).click();
      await expect(page).toHaveURL(/\/workflows\/[0-9a-f-]+$/);
      workflowId = new URL(page.url()).pathname.split("/").pop() ?? "";

      // Step 1 — its harness finishing is what moves the Task on; nobody has to approve it.
      await page.getByRole("main").getByRole("button", { name: "Add the first step" }).click();
      const name1 = page.getByRole("textbox", { name: "Name of step 1" });
      await expect(name1).toBeVisible();
      await name1.fill(stepNames[0]);
      await name1.blur();
      // The rename is written on blur; the insert button after the Step carries the new name.
      await expect(
        page.getByRole("button", { name: `Add a step after ${stepNames[0]}` }),
      ).toBeVisible();
      await pickOption(page, "Gate", "Automatic");
      await pickOption(page, "Finished when", "Harness says done");
      await page.getByRole("button", { name: `Edit the prompt for ${stepNames[0]}` }).click();
      await page
        .getByRole("textbox", { name: `Prompt for ${stepNames[0]}` })
        .fill("Investigate the issue and say what you found. Do not change any file.");
      await page.getByRole("button", { name: "Save prompt" }).click();

      // Step 2 — the last Step: whatever its gate, the run ends at the review a person opens.
      await page.getByRole("button", { name: `Add a step after ${stepNames[0]}` }).click();
      const name2 = page.getByRole("textbox", { name: "Name of step 2" });
      // Adding a card re-fits the view; if that lands below the editable zoom, zoom in — what a
      // person does when the cards go compact.
      await expect(async () => {
        if (!(await name2.isVisible())) await page.getByRole("button", { name: "Zoom In" }).click();
        await expect(name2).toBeVisible({ timeout: 1_000 });
      }).toPass();
      await name2.fill(stepNames[1]);
      await name2.blur();
      await page.getByRole("button", { name: `Edit the prompt for ${stepNames[1]}` }).click();
      await page
        .getByRole("textbox", { name: `Prompt for ${stepNames[1]}` })
        .fill("Carry out what the investigation in the handoff above proposes.");
      await page.getByRole("button", { name: "Save prompt" }).click();

      // What the API holds, not what the canvas drew: two Steps, in order, with the gates set.
      await expect
        .poll(async () => {
          const wf = await trpc<{ steps: { name: string; gate: string; advanceOn: string }[] }>(
            page,
            "workflow.get",
            { id: workflowId },
            "query",
          );
          return wf.steps.map((st) => `${st.name}:${st.gate}:${st.advanceOn}`);
        })
        .toEqual([`${stepNames[0]}:auto:agent-signal`, `${stepNames[1]}:human:review`]);
    });

    await test.step("create the Task under the Issue", async () => {
      await createTask(page, {
        title: taskTitle,
        issueId,
        issue: issueTitle,
        repository: REPO_NAME,
      });
      taskId = await openTask(page, issueId, taskTitle);
    });

    await test.step("launch it through the Workflow", async () => {
      const main = page.getByRole("main");
      await main.getByRole("button", { name: "Move to Ready" }).click();
      await expect(page.locator('[data-task-state="ready"]').first()).toBeVisible();
      await main.getByRole("button", { name: "Move to Running" }).click();
      // Now that the Workspace has a Workflow, a launch asks which one first (spec F03).
      const launch = page.getByRole("dialog", { name: new RegExp(`Launch ${taskTitle}`) });
      // The row is the label of a visually hidden radio; clicking its title is the gesture.
      await launch.getByText(workflowName, { exact: true }).click();
      await expect(launch.getByRole("radio", { name: new RegExp(workflowName) })).toBeChecked();
      await launch.getByRole("button", { name: "Launch" }).click();
      await expect(page.locator('[data-task-state="running"]').first()).toBeVisible();
    });

    await test.step("the run walks both Steps, and each Step's output is on its own tab", async () => {
      const progress = page.getByRole("region", { name: "Workflow progress" });
      await expect(progress).toBeVisible();
      const tabs = page.getByRole("tablist", { name: "Workflow steps" });
      for (const name of stepNames) await expect(tabs.getByRole("tab", { name })).toBeVisible();

      // Step 1's harness finishes → the advance moves the cursor → Step 2's harness runs in the
      // same worktree. The last Step does not end the run: it offers the review gate.
      await expect(progress).toContainText("Step 2 of 2");
      await expect(
        page.getByRole("main").getByRole("button", { name: "Open review" }),
      ).toBeVisible();

      // Every Step's transcript, read back one Step at a time — the terminal is scoped to the
      // selected tab. Both ran the fixture harness in the one worktree the Task owns.
      for (const name of stepNames) {
        const tab = tabs.getByRole("tab", { name });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await expect(page.getByText(/harness edited solow-task-/).first()).toBeVisible();
      }
      // And the run's own tab lands on the Step the cursor ended on.
      await expect(tabs.getByRole("tab", { name: stepNames[1] })).toHaveAttribute(
        "aria-current",
        "step",
      );
    });

    await test.step("review the change and approve it onto a branch", async () => {
      await openReview(page);
      const changed = page.getByRole("list", { name: "Changes" });
      await expect(changed.getByTitle(`marker-solow-task-${taskId}.txt`)).toBeVisible();
      await page.getByRole("main").getByRole("button", { name: "Approve" }).click();
      await expect(page.locator('[data-task-state="done"]').first()).toBeVisible();

      const branch = `solow-task-${taskId}`;
      await expect.poll(() => git(["branch", "--list", branch])).toContain(branch);
      await expect
        .poll(() => git(["show", "--name-only", "--format=", branch]))
        .toContain(`marker-solow-task-${taskId}.txt`);
    });

    await test.step("close the Issue", async () => {
      await page.goto(`/issues/${issueId}`);
      await page.getByRole("button", { name: /^Status: .*Change it$/ }).click();
      await page.getByRole("menuitem", { name: "Closed" }).click();
      await expect(page.getByRole("button", { name: /^Status: Closed/ })).toBeVisible();
    });

    await test.step("remove everything the check created", async () => {
      // The Task first: an Issue with Tasks refuses to go, and a Workflow a Task follows too.
      await page.goto(`/task/${taskId}`);
      await page.getByRole("button", { name: `Delete ${taskTitle}` }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
      await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}$`));

      await page.goto(`/issues/${issueId}`);
      await page.getByRole("button", { name: "Delete issue" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete issue" }).click();
      await expect(page).not.toHaveURL(new RegExp(`/issues/${issueId}$`));

      await page.goto(`/workflows/${workflowId}`);
      // The sidebar's own control for the pipeline; the inspector's is behind a panel that may
      // still be loading the Steps.
      await page.getByRole("button", { name: `Delete ${workflowName}`, exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete workflow" }).click();
      await expect(page.getByRole("link", { name: new RegExp(workflowName) })).toHaveCount(0);

      await page.goto(`/projects/${projectId}`);
      await page.getByRole("button", { name: "Delete", exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete project" }).click();
      await expect(page).toHaveURL(/\/projects$/);
      await expect(page.getByText(projectTitle)).toHaveCount(0);

      // The branch the approval wrote is the one thing outside the database; take it too — once
      // the worktree that held it is gone, which the lifecycle's cleanup step does after Done.
      const branch = `solow-task-${taskId}`;
      await expect.poll(() => git(["worktree", "list"])).not.toContain(branch);
      git(["branch", "-D", branch]);
      expect(git(["branch", "--list", branch])).toBe("");

      // Nothing left behind that names this run.
      const workflows = await trpc<{ name: string }[]>(page, "workflow.list", {}, "query");
      expect(workflows.map((w) => w.name)).not.toContain(workflowName);
      const issues = await trpc<{ items: { title: string }[] }>(page, "issue.list", {}, "query");
      expect(issues.items.map((i) => i.title)).not.toContain(issueTitle);
    });
  });
});
