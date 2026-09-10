import { execFileSync } from "node:child_process";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { PATHS } from "../support/fixture.js";
import { connectRepository, createTask, openReview, openTask } from "../support/flows.js";

/**
 * The branching control check (@control): the Workflow features that decide *where* a Task goes
 * next, drawn on the canvas as a person would and then driven through by the run loop —
 *
 *   Implement ─(produced changes? yes)→ Review ─(needs another pass? yes)→ Implement
 *                                              └────────────(no)────────→ Verify
 *   Verify ─(reported `blocked`? yes)→ Escalate [a human approves] → Ship → the review gate
 *
 * All three condition kinds, a backward branch that loops exactly once, a Step routed to a person
 * by the harness's own outcome, an intermediate approval that releases one gate and not the
 * pipeline behind it, then the final approval. The harness is the fixture runner, scripted
 * through markers in the Step prompts (`e2e/support/orchestrator.ts`): it answers the Review
 * question *yes* the first time and *no* the second, and reports `blocked` from Verify — through
 * the same `task_complete` widget a real harness sends, so the scanner, the completion record,
 * the decision carry-over and the branch evaluation are all production code.
 *
 * What is checked at the end is the Session log's own `workflow_decision` records, read back
 * through the API: the exact sequence of advances, each condition's reading, and the outcome
 * the rule read — the run explaining itself, which is what those records are for.
 */

const REPO_NAME = "e2e-fixture-repo";

const git = (args: string[]) =>
  execFileSync("git", args, { cwd: PATHS.repo, encoding: "utf8" }).trim();

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

/** `within` scopes the combobox (a card on the canvas); the options open in a portal, page-wide. */
async function pickOption(
  page: Page,
  within: Page | Locator,
  label: string | RegExp,
  option: string | RegExp,
) {
  await within.getByRole("combobox", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function enableFlag(page: Page, label: string) {
  await page.goto("/settings?section=flags");
  const flag = page.getByRole("checkbox", { name: label, exact: true });
  await expect(flag).toBeVisible();
  if ((await flag.getAttribute("data-state")) !== "checked") await flag.click();
  await expect(flag).toHaveAttribute("data-state", "checked");
}

/**
 * One card on the canvas, by the Step's name — through the exact label of its prompt button,
 * because a `hasText` filter is a case-insensitive substring and "review" is in more than one
 * prompt.
 */
function card(page: Page, name: string): Locator {
  return page.locator(".react-flow__node", {
    has: page.getByRole("button", { name: `Edit the prompt for ${name}`, exact: true }),
  });
}

type Decision = {
  kind: "workflow_decision";
  stepName: string;
  signal: string;
  status: string;
  nextStepName: string | null;
  condition: { when: { kind: string }; holds: boolean } | null;
  outcome: string | null;
  producedChanges: boolean;
};

test.describe("branching control check — conditions, a loop, and a gate in the middle", () => {
  // Five cards have to fit at an editable zoom (cards go compact below 0.72), so a wide window.
  test.use({ viewport: { width: 2560, height: 1440 } });

  test("implement ⇄ review loop, outcome-routed escalation, two approvals — and the log explains every move @control", async ({
    page,
  }) => {
    test.setTimeout(900_000);
    const stamp = Date.now();
    const issueTitle = `Branching issue ${stamp}`;
    const workflowName = `Branching pipeline ${stamp}`;
    const taskTitle = `Branching task ${stamp}`;
    const STEPS = ["Implement", "Review", "Verify", "Escalate", "Ship"] as const;

    let issueId = "";
    let workflowId = "";
    let taskId = "";

    await test.step("Workflows and harness widgets are on; a repository is connected", async () => {
      await enableFlag(page, "Workflows");
      // The scripted harness reports through a widget; widgets are read only with this on.
      await enableFlag(page, "Agent widgets");
      await page.goto("/settings?section=repositories");
      await connectRepository(page, REPO_NAME, PATHS.repo);
    });

    await test.step("an Issue to work on", async () => {
      const list = await trpc<{ items: { id: string; name: string }[] }>(
        page,
        "repository.list",
        {},
        "query",
      );
      const repo = list.items.find((r) => r.name === REPO_NAME);
      expect(repo).toBeDefined();
      const issue = await trpc<{ id: string }>(
        page,
        "issue.create",
        { title: issueTitle, repositoryId: repo?.id },
        "mutation",
      );
      issueId = issue.id;
    });

    await test.step("draw five Steps on the canvas", async () => {
      await page.goto("/workflows");
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

      // Cards, in order; each card's fields only exist above the compact zoom.
      const field = async (name: string) => {
        const box = page.getByRole("textbox", { name, exact: true });
        await expect(async () => {
          if (!(await box.isVisible())) await page.getByRole("button", { name: "Zoom In" }).click();
          await expect(box).toBeVisible({ timeout: 1_000 });
        }).toPass();
        return box;
      };
      const prompts: Record<(typeof STEPS)[number], string> = {
        Implement: "Implement what the issue asks. If this is a later pass, address the review.",
        Review: "Review the implementation. Do not modify any file. [decide:yes x1]",
        Verify: "Verify the change. Do not modify any file. [outcome:blocked]",
        Escalate: "A person decides how to proceed with a blocked verification.",
        Ship: "Ready the change for integration.",
      };
      for (const [i, name] of STEPS.entries()) {
        if (i === 0) {
          await page.getByRole("main").getByRole("button", { name: "Add the first step" }).click();
        } else {
          await page.getByRole("button", { name: `Add a step after ${STEPS[i - 1]}` }).click();
        }
        const box = await field(`Name of step ${i + 1}`);
        await box.fill(name);
        await box.blur();
        await expect(page.getByRole("button", { name: `Add a step after ${name}` })).toBeVisible();
        await page.getByRole("button", { name: `Edit the prompt for ${name}` }).click();
        await page.getByRole("textbox", { name: `Prompt for ${name}` }).fill(prompts[name]);
        await page.getByRole("button", { name: "Save prompt" }).click();
      }
    });

    await test.step("set each Step's gate, and the three branches", async () => {
      // Every Step but Escalate advances on the harness's own signal; Escalate waits for a person.
      const gate = async (name: string, gateLabel: string, advanceLabel: string) => {
        await pickOption(page, card(page, name), "Gate", gateLabel);
        await pickOption(page, card(page, name), "Finished when", advanceLabel);
      };
      for (const name of ["Implement", "Review", "Verify", "Ship"]) {
        await gate(name, "Automatic", "Harness says done");
      }

      // A branch is turned on from the card's toolbar, which shows on hover; then its condition
      // and its two exits are the card's own fields.
      const branch = async (name: string) => {
        const node = card(page, name);
        await node.getByRole("textbox", { name: /^Name of step/ }).hover();
        await page.getByRole("button", { name: `Branch ${name} on a condition` }).click();
        await expect(node.getByRole("combobox", { name: "Condition", exact: true })).toBeVisible();
        return node;
      };

      const implement = await branch("Implement");
      await pickOption(page, implement, "Condition", "Step produced changes");
      await pickOption(page, implement, "If yes", "Review");
      await pickOption(page, implement, "If no", "End of pipeline");

      const review = await branch("Review");
      await pickOption(page, review, "Condition", "The harness decides");
      await review
        .getByRole("textbox", { name: "Question the harness answers" })
        .fill("Does the implementation need another pass?");
      await review.getByRole("textbox", { name: "Question the harness answers" }).blur();
      await pickOption(page, review, "If yes", "Implement");
      await pickOption(page, review, "If no", "Verify");

      const verify = await branch("Verify");
      await pickOption(page, verify, "Condition", "Harness reported an outcome");
      await pickOption(page, verify, "When the harness reports", "Blocked — could not finish");
      await pickOption(page, verify, "If yes", "Escalate");
      await pickOption(page, verify, "If no", "Ship");

      // The canvas draws the two exits of every branch, including the one that goes back.
      const edge = (label: string) => page.getByRole("img", { name: label, exact: true });
      await expect(edge("If yes: Implement → Review")).toBeVisible();
      await expect(edge("If no: Implement → the end")).toBeVisible();
      await expect(edge("If yes: Review → Implement")).toBeVisible();
      await expect(edge("If no: Review → Verify")).toBeVisible();
      await expect(edge("If yes: Verify → Escalate")).toBeVisible();
      await expect(edge("If no: Verify → Ship")).toBeVisible();

      // And the API holds exactly that.
      await expect
        .poll(async () => {
          const wf = await trpc<{
            steps: {
              id: string;
              name: string;
              gate: string;
              advanceOn: string;
              branch: {
                when: { kind: string; is?: string };
                thenStepId: string | null;
                elseStepId: string | null;
              } | null;
            }[];
          }>(page, "workflow.get", { id: workflowId }, "query");
          const byId = new Map(wf.steps.map((s) => [s.id, s.name]));
          return wf.steps.map((s) => ({
            name: s.name,
            gate: `${s.gate}/${s.advanceOn}`,
            branch: s.branch
              ? `${s.branch.when.kind}${s.branch.when.is ? `=${s.branch.when.is}` : ""}: ${s.branch.thenStepId ? byId.get(s.branch.thenStepId) : "end"} | ${s.branch.elseStepId ? byId.get(s.branch.elseStepId) : "end"}`
              : null,
          }));
        })
        .toEqual([
          {
            name: "Implement",
            gate: "auto/agent-signal",
            branch: "produced-changes: Review | end",
          },
          {
            name: "Review",
            gate: "auto/agent-signal",
            branch: "agent-decides: Implement | Verify",
          },
          { name: "Verify", gate: "auto/agent-signal", branch: "outcome=blocked: Escalate | Ship" },
          { name: "Escalate", gate: "human/review", branch: null },
          { name: "Ship", gate: "auto/agent-signal", branch: null },
        ]);
    });

    await test.step("a Task launched through it", async () => {
      await createTask(page, {
        title: taskTitle,
        issueId,
        issue: issueTitle,
        repository: REPO_NAME,
      });
      taskId = await openTask(page, issueId, taskTitle);
      const main = page.getByRole("main");
      await main.getByRole("button", { name: "Move to Ready" }).click();
      await expect(page.locator('[data-task-state="ready"]').first()).toBeVisible();
      await main.getByRole("button", { name: "Move to Running" }).click();
      const launch = page.getByRole("dialog", { name: new RegExp(`Launch ${taskTitle}`) });
      await launch.getByText(workflowName, { exact: true }).click();
      await launch.getByRole("button", { name: "Launch" }).click();
      await expect(page.locator('[data-task-state="running"]').first()).toBeVisible();
    });

    await test.step("the run loops once, gets routed to Escalate by the outcome, and waits for a person there", async () => {
      const progress = page.getByRole("region", { name: "Workflow progress" });
      // Implement → Review (yes) → Implement → Review (no) → Verify (blocked) → Escalate, whose
      // human gate holds the Task at the review the operator opens.
      await expect(progress).toContainText("Step 4 of 5", { timeout: 120_000 });
      await expect(
        page.getByRole("main").getByRole("button", { name: "Open review" }),
      ).toBeVisible();
      await openReview(page);
      const tabs = page.getByRole("tablist", { name: "Workflow steps" });
      await expect(tabs.getByRole("tab", { name: "Escalate" })).toHaveAttribute(
        "aria-current",
        "step",
      );
    });

    await test.step("approving at Escalate releases that gate only — Ship still runs, then asks again", async () => {
      await page.getByRole("main").getByRole("button", { name: "Approve" }).click();
      const progress = page.getByRole("region", { name: "Workflow progress" });
      await expect(progress).toContainText("Step 5 of 5", { timeout: 120_000 });
      // Not Done: the approval was spent on Escalate's gate, not on the integration.
      await expect(page.locator('[data-task-state="done"]')).toHaveCount(0);
      await expect(
        page.getByRole("main").getByRole("button", { name: "Open review" }),
      ).toBeVisible();
      await openReview(page);
      await page.getByRole("main").getByRole("button", { name: "Approve" }).click();
      await expect(page.locator('[data-task-state="done"]').first()).toBeVisible();
      const branch = `solow-task-${taskId}`;
      await expect.poll(() => git(["branch", "--list", branch])).toContain(branch);
    });

    await test.step("the Session log explains every move, in order", async () => {
      const sessions = await trpc<{ id: string }[]>(
        page,
        "session.listForTask",
        { taskId },
        "query",
      );
      expect(sessions.length).toBeGreaterThan(0);
      const detail = await trpc<{ events: { payload: Decision | { kind: string } }[] }>(
        page,
        "session.get",
        { sessionId: sessions[0]?.id },
        "query",
      );
      const decisions = detail.events
        .map((e) => e.payload)
        .filter((p): p is Decision => p.kind === "workflow_decision");

      const moves = decisions
        .filter((d) => d.status === "advanced")
        .map((d) => `${d.stepName} → ${d.nextStepName}`);
      expect(moves).toEqual([
        "Implement → Review",
        "Review → Implement",
        "Implement → Review",
        "Review → Verify",
        "Verify → Escalate",
        "Escalate → Ship",
      ]);
      // Each condition read what the harness reported: changes both times, yes then no, blocked.
      expect(
        decisions
          .filter((d) => d.stepName === "Implement")
          .map((d) => `${d.condition?.when.kind}:${d.condition?.holds}`),
      ).toEqual(["produced-changes:true", "produced-changes:true"]);
      expect(
        decisions.filter((d) => d.stepName === "Review").map((d) => d.condition?.holds),
      ).toEqual([true, false]);
      const verify = decisions.find((d) => d.stepName === "Verify");
      expect(verify?.outcome).toBe("blocked");
      expect(verify?.condition?.holds).toBe(true);
      // Escalate moved on a review — a person's decision — and never on the harness's signal.
      const escalate = decisions.filter((d) => d.stepName === "Escalate");
      expect(escalate.at(-1)?.signal).toBe("review");
      expect(escalate.at(-1)?.status).toBe("advanced");
      expect(escalate.some((d) => d.signal === "agent-signal" && d.status === "advanced")).toBe(
        false,
      );
      // And the last Step completed only once a review landed.
      expect(decisions.at(-1)?.stepName).toBe("Ship");
      expect(decisions.at(-1)?.status).toBe("completed");
    });

    await test.step("cleanup", async () => {
      await page.goto(`/task/${taskId}`);
      await page.getByRole("button", { name: `Delete ${taskTitle}` }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete task" }).click();
      await expect(page).not.toHaveURL(new RegExp(`/task/${taskId}$`));
      await page.goto(`/issues/${issueId}`);
      await page.getByRole("button", { name: "Delete issue" }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete issue" }).click();
      await expect(page).not.toHaveURL(new RegExp(`/issues/${issueId}$`));
      await page.goto(`/workflows/${workflowId}`);
      await page.getByRole("button", { name: `Delete ${workflowName}`, exact: true }).click();
      await page.getByRole("alertdialog").getByRole("button", { name: "Delete workflow" }).click();
      await expect(page.getByRole("link", { name: new RegExp(workflowName) })).toHaveCount(0);
      const branch = `solow-task-${taskId}`;
      await expect.poll(() => git(["worktree", "list"])).not.toContain(branch);
      git(["branch", "-D", branch]);
    });
  });
});
