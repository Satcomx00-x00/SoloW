import { expect, test } from "@playwright/test";

/**
 * The shell scrolls in exactly one place.
 *
 * This is a layout guarantee no unit test can hold: it needs a real layout engine, and the whole
 * failure is geometric. SoloW is a SPA whose shell is pinned to `100dvh` with a single
 * scrolling `<main>` — an activity bar, a sidebar, a header and a status bar that must all stay
 * put while the content moves under them. A second, page-level scrollbar breaks every one of
 * those: the status bar scrolls away, the header leaves with it, and the reader is given two
 * scroll positions to keep track of for one column of content.
 *
 * The regression that produced this file: every Radix `Select` renders a hidden native
 * `<select>` at `position: absolute` for form compatibility, and nothing between it and `<html>`
 * established a containing block — so the *initial* containing block did. Its static position
 * sat deep inside the scrolled column, which stretched the **document** to 1524px inside an
 * 820px viewport, and Chrome painted a page scrollbar beside `<main>`'s own. Settings showed it
 * first because it holds more of those controls in one column than any other screen, but the
 * cause was in the shell and every page was one long form away from it.
 *
 * Asserted as "the document does not scroll" rather than "no element is positioned wrongly",
 * because that is the property that actually matters and it holds however the next such element
 * arrives.
 */
test.describe("the shell", () => {
  /** The densest form in the product, and the screen the defect was reported on. */
  const DENSE = "/settings?section=agent-profiles";

  test("scrolls in one place — the document itself never does", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 780 });
    await page.goto(DENSE);
    // The content has to have arrived, or an empty page would pass this trivially.
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();

    /*
     * Passed as a string rather than as an arrow function.
     *
     * This package typechecks without the DOM lib on purpose — a spec file runs in Node, and
     * letting it reach for `document` in that scope is a mistake worth failing on. The one place
     * browser code is legitimate is inside `evaluate`, which is a different scope entirely, and
     * the string form is how that distinction stays visible.
     */
    const doc = (await page.evaluate(
      "({ scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight })",
    )) as { scrollHeight: number; clientHeight: number };

    // Equal, not merely close: `100dvh` is exact, and a document even slightly taller than its
    // own viewport is a scrollbar.
    expect(doc.scrollHeight).toBe(doc.clientHeight);
  });

  test("keeps the status bar and header in place while the content scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 780 });
    await page.goto(DENSE);
    await expect(page.getByRole("heading", { name: "Agents", level: 1 })).toBeVisible();

    // The consequence a user actually feels, and the reason the assertion above is worth having.
    await page.locator("main").evaluate("el => { el.scrollTop = el.scrollHeight; }");

    expect(await page.evaluate("window.scrollY")).toBe(0);
    await expect(page.getByRole("banner")).toBeVisible();
    await expect(page.getByRole("contentinfo")).toBeVisible();
  });
});
