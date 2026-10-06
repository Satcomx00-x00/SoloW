import { expect, type Page, test } from "@playwright/test";
import { trpc } from "../support/flows.js";

/**
 * Navigation smoke (Decision 0029): the sidebar, the breadcrumb, the command palette and the
 * drawer, in a real browser against the real app — the parts of the shell that only work if the
 * routes, the queries and the layout all agree.
 *
 * Every test also fails on an uncaught page error, so a page that renders but throws on the way
 * (a hydration mismatch, a query shape the client no longer understands) is not a pass.
 */

function failOnPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  return errors;
}

const sidebar = (page: Page) => page.getByRole("complementary", { name: "Sidebar" });
const breadcrumb = (page: Page) => page.getByRole("navigation", { name: "Breadcrumb" });

/** Two local Projects for one test, named so they can only be this test's. */
async function twoProjects(page: Page, stamp: number): Promise<[string, string]> {
  const ids: string[] = [];
  for (const title of [`Nav A ${stamp}`, `Nav B ${stamp}`]) {
    const created = await trpc<{ id: string }>(page, "project.createLocal", { title }, "mutation");
    ids.push(created.id);
  }
  return ids as [string, string];
}

async function dropProjects(page: Page, ids: readonly string[]): Promise<void> {
  for (const projectId of ids) await trpc(page, "project.delete", { projectId }, "mutation");
}

test.describe("navigation", () => {
  test("every workspace page is one click from every other, and Settings leads back", async ({
    page,
  }) => {
    const errors = failOnPageErrors(page);
    await page.goto("/projects");
    await expect(sidebar(page)).toBeVisible();

    const workspace = sidebar(page).getByRole("navigation", { name: "Workspace" });
    for (const [name, path] of [
      ["Unassigned", "/unassigned"],
      ["Workflows", "/workflows"],
      ["History", "/history"],
    ] as const) {
      await workspace.getByRole("link", { name: new RegExp(`^${name}`) }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      // Exactly one row is filled, and it is the page you are on.
      await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(1);
      await expect(breadcrumb(page)).toContainText(name);
    }

    await sidebar(page).getByRole("link", { name: "Settings", exact: true }).click();
    await expect(page).toHaveURL(/\/settings/);
    const sections = sidebar(page).getByRole("navigation", { name: "Settings sections" });
    await expect(sections).toBeVisible();
    await sections.getByRole("link", { name: "Secrets" }).click();
    await expect(breadcrumb(page)).toContainText("Secrets");

    // Back to where you were before Settings — History — not to the front door.
    await sections.getByRole("link", { name: "Back to app" }).click();
    await expect(page).toHaveURL(/\/history$/);

    await sidebar(page).getByRole("link", { name: "All projects" }).click();
    await expect(page).toHaveURL(/\/projects$/);
    expect(errors).toEqual([]);
  });

  test("a Project opens with its sections, switches keeping the section, and is in the trail", async ({
    page,
  }) => {
    const errors = failOnPageErrors(page);
    const stamp = Date.now();
    await page.goto("/projects");
    const [a, b] = await twoProjects(page, stamp);
    try {
      await page.reload();
      const projects = sidebar(page).getByRole("navigation", { name: "Projects" });

      await projects.getByRole("link", { name: `Nav A ${stamp}` }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${a}$`));
      const sectionsOfA = projects.getByRole("list", { name: `Nav A ${stamp} sections` });
      await sectionsOfA.getByRole("link", { name: "Board" }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${a}/board$`));
      await expect(breadcrumb(page)).toContainText(`Projects`);
      await expect(breadcrumb(page)).toContainText(`Nav A ${stamp}`);
      await expect(breadcrumb(page)).toContainText("Board");

      await projects.getByRole("link", { name: `Nav B ${stamp}` }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${b}/board$`));
      await expect(projects.getByRole("list", { name: `Nav B ${stamp} sections` })).toBeVisible();
      await expect(projects.getByRole("list", { name: `Nav A ${stamp} sections` })).toHaveCount(0);

      // The trail's root leads back to the list of Projects.
      await breadcrumb(page).getByRole("link", { name: "Projects" }).click();
      await expect(page).toHaveURL(/\/projects$/);
      expect(errors).toEqual([]);
    } finally {
      await dropProjects(page, [a, b]);
    }
  });

  test("the command palette jumps straight to a Project's section", async ({ page }) => {
    const errors = failOnPageErrors(page);
    const stamp = Date.now();
    await page.goto("/history");
    const [a, b] = await twoProjects(page, stamp);
    try {
      await page.reload();
      await page.getByRole("button", { name: "Search" }).click();
      const palette = page.getByRole("dialog");
      await palette.getByRole("combobox").fill(`Nav B ${stamp}`);
      await palette.getByRole("option", { name: new RegExp(`Nav B ${stamp} › Issues`) }).click();
      await expect(page).toHaveURL(new RegExp(`/projects/${b}/issues$`));
      expect(errors).toEqual([]);
    } finally {
      await dropProjects(page, [a, b]);
    }
  });

  test("the sidebar hides with Ctrl+B, stays hidden across a reload, and comes back", async ({
    page,
  }) => {
    const errors = failOnPageErrors(page);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/projects");
    await expect(sidebar(page)).toBeVisible();

    await page.keyboard.press("Control+b");
    await expect(sidebar(page)).toHaveCount(0);
    await page.reload();
    // Server-rendered from the cookie: hidden on the first paint, not hidden a beat later.
    await expect(sidebar(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Show sidebar" }).click();
    await expect(sidebar(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("on a phone the sidebar is a drawer that closes once you have gone somewhere", async ({
    page,
  }) => {
    const errors = failOnPageErrors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/projects");

    await page.getByRole("button", { name: "Show sidebar" }).click();
    const drawer = page.getByRole("dialog", { name: "Navigation" });
    await expect(drawer).toBeVisible();
    await drawer.getByRole("link", { name: "History" }).click();
    await expect(page).toHaveURL(/\/history$/);
    await expect(drawer).toBeHidden();
    expect(errors).toEqual([]);
  });
});
