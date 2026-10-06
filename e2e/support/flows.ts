import { expect, type Locator, type Page } from "@playwright/test";
import { EXECUTOR_PROFILE_NAME, HARNESS_PROFILE_NAME } from "./fixture.js";

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
 * written down here: a Task is created from its Issue's own page, opened from that same page,
 * advanced with the Task page's own lifecycle arrows, and reviewed behind the gate the operator
 * opens — there is no flat `/board` any more, no shell-wide Create menu, and no Task enters
 * review on its own.
 */

/** Connect one local fixture repository through Settings, once — safe to call repeatedly. */
export async function connectRepository(page: Page, name: string, location: string): Promise<void> {
  // Wait for the list to actually resolve before deciding. Reading visibility straight after
  // navigating would answer "not there yet" while the query is still in flight, and every test
  // that did so would connect another copy of the same repository.
  const connected = page.getByLabel("Connected repositories");
  await expect(connected).toBeVisible();
  const row = connected.getByText(name, { exact: true });
  if (await row.isVisible()) return;
  // The form sits behind a disclosure, closed by default once a Repository already exists — open
  // it before reaching for fields inside it, which is why "Name"/"Location" alone are not enough
  // once this is not the first connection of the run.
  const toggle = page.getByRole("button", { name: "Connect a repository" });
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.getByLabel("Name").last().fill(name);
  await page.getByLabel("Location").fill(location);
  await page.getByRole("button", { name: "Connect repository" }).click();
  await expect(row).toBeVisible();
}

/** One tRPC call over HTTP, the way the SPA makes it (superjson envelope, dev-owner session). */
export async function trpc<T>(
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

async function pickOption(page: Page, label: string, option: string): Promise<void> {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option }).click();
}

/**
 * Create a Task from the Issue it belongs to.
 *
 * The shell header's Create menu used to be the entry point, and it was removed: creating work
 * now happens where the thing being created lives, so the Issue's own page is the surface that
 * offers "New task". `issueId` is required rather than optional for exactly that reason — there
 * is no route-independent way in, so a caller that cannot say which Issue has no journey to
 * drive, and making it optional would let a call site silently keep the old assumption.
 */
export async function createTask(
  page: Page,
  opts: {
    title: string;
    /** The Issue whose page the Task is cut from — its id, since that is what the route takes. */
    issueId: string;
    issue: string;
    repository: string;
    harnessProfile?: string;
    /** Repositories ticked under Advanced → "Also works in": each gets its own worktree. */
    alsoWorksIn?: readonly string[];
  },
): Promise<void> {
  await page.goto(`/issues/${opts.issueId}`);
  await page.getByLabel("Tasks for this issue").getByRole("button", { name: "New task" }).click();

  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByLabel("Title").fill(opts.title);
  // Repository before Issue, still explicitly, even though the page's own button presets both:
  // the Issue picker narrows to the chosen Repository (issue #15) and picking a Repository
  // clears any already-picked Issue, so the order has to hold whatever arrived preset — and the
  // flow stays readable without the reader having to know what the preset does.
  await pickOption(page, "Repository", opts.repository);
  await pickOption(page, "Issue", opts.issue);
  await pickOption(page, "Harness profile", opts.harnessProfile ?? HARNESS_PROFILE_NAME);
  await pickOption(page, "Executor", EXECUTOR_PROFILE_NAME);
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
  // Scoped to the page: the sidebar offers the same moves, and one gesture must press one button.
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Move to Ready" }).click();
  await expect(page.locator('[data-task-state="ready"]').first()).toBeVisible();
  await main.getByRole("button", { name: "Move to Running" }).click();
  await expect(page.locator('[data-task-state="running"]').first()).toBeVisible();
}

/**
 * Open the review gate once the harness has declared it is finished.
 *
 * The click is the point, not a detour: a run finishing no longer moves the Task to review on
 * its own — the harness declares, the page shows "Open review", and the transition is the
 * operator's (Principle I is a gate a human opens, not a conveyor).
 */
export async function openReview(page: Page): Promise<void> {
  await (await gateButton(page, "Open review")).click();
  await expect(page.locator('[data-task-state="review"]').first()).toBeVisible();
  // The gate stays open on the review it just opened; close it so the page is the spec's again.
  await closeGate(page);
}

/**
 * The gate's dialog — Approve, Request changes, Reject, Retry, Launch, Open review.
 *
 * The gate is a card at the foot of the current Step on the board, a strip under the brief and
 * the change, and a button in the left pane; all three open the same dialog. This opens it (or
 * finds it open) and returns it.
 */
export async function openGate(page: Page): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  if (await dialog.isVisible()) return dialog;
  // The left pane's gate button, rather than the card: the card can be panned off screen, where
  // a click lands on the canvas instead.
  await page.locator("[data-gate-open]").click();
  await expect(dialog).toBeVisible();
  return dialog;
}

/** One of the gate's own buttons, the gate opened first. */
export async function gateButton(page: Page, name: string): Promise<Locator> {
  return (await openGate(page)).getByRole("button", { name, exact: true });
}

/** Close whatever dialog the board has open. */
export async function closeGate(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  if (!(await dialog.isVisible())) return;
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
}

/**
 * Wait for a Workflow gate the run opened itself.
 *
 * Under a Workflow the only way past a human-decided Step is a review decision, so the run puts
 * the Task into review when the harness finishes (F03 FR-10: a Run that reaches a Gate *requests*
 * the decision) — there is no "Open review" to click; the gate card is on the board already.
 */
export async function awaitWorkflowGate(page: Page): Promise<void> {
  await expect(page.locator('[data-task-state="review"]').first()).toBeVisible({
    timeout: 120_000,
  });
  await expect(page.locator('[data-board-kind="gate"]')).toHaveCount(1);
}

/**
 * The page's own views (Board · Brief · Changes). The page opens on the board in every state, so
 * a spec that wants the brief or the change has to say so — exactly as a person would.
 */
export async function openWorkspaceTab(
  page: Page,
  name: "Board" | "Brief" | "Changes",
): Promise<void> {
  const tab = page.getByRole("tablist", { name: "Task" }).getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

/**
 * The terminal: a real shell in the Task's worktree, opened from the left pane's Terminal
 * button. Idempotent: a pane already open stays open.
 */
export async function openTerminal(page: Page): Promise<void> {
  const button = page.getByRole("button", { name: "Terminal", exact: true });
  if ((await button.getAttribute("aria-expanded")) !== "true") await button.click();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
}

/** The Task the page is on, from its URL. */
export function taskIdOnPage(page: Page): string {
  return new URL(page.url()).pathname.split("/").pop() as string;
}

/**
 * What the harness said and did in the Task's newest Session, as one string — its turns, the
 * operator's, the notices, and every tool call with its input — read from the Session log
 * through the API, optionally one Workflow Step's worth.
 *
 * The page no longer draws the harness's log (its terminal is a real shell), so a spec that
 * needs to know what the run did reads the record itself. Poll it: the log is written as the
 * run goes.
 */
export async function sessionLog(
  page: Page,
  taskId: string,
  workflowStepId?: string,
): Promise<string> {
  const sessions = await trpc<Array<{ id: string }>>(
    page,
    "session.listForTask",
    { taskId },
    "query",
  );
  const latest = sessions[0];
  if (!latest) return "";
  const detail = await trpc<{ events: Array<{ payload: Record<string, unknown> }> }>(
    page,
    "session.get",
    { sessionId: latest.id, ...(workflowStepId ? { workflowStepId } : {}) },
    "query",
  );
  return detail.events
    .map(({ payload }) => {
      if (typeof payload.text === "string") return payload.text;
      if (payload.kind === "tool_call")
        return `${payload.name} ${JSON.stringify(payload.input ?? {})}`;
      return "";
    })
    .join("\n");
}

/** The whole run-up: launch, wait out the harness, open the gate. */
export async function launchToReview(page: Page): Promise<void> {
  await launchTask(page);
  await openReview(page);
}

/**
 * A Step's header on the Task page's board — the node that names the Step and opens its dialog.
 * Its `data-step-status` is where the run is (`running`, `waiting` at the gate, `done`), which the
 * header strip's tabs used to carry before the board became the only place the Steps are drawn.
 */
export function stepHeader(page: Page, name: string): Locator {
  return page.getByRole("button", { name: new RegExp(`^Step\\. ${name}\\b`) });
}

/** Scope the board to one Step, the way the page offers it: its header, then its dialog's button. */
export async function showStepOnBoard(page: Page, name: string): Promise<void> {
  await stepHeader(page, name).click();
  await page.getByRole("button", { name: "Show this step on the board" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
}
