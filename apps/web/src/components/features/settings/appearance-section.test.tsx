/// <reference types="bun-types" />
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { resetThemeStore } from "@/components/theme";
import { THEME_STORAGE_KEY } from "@/lib/theme-boot";
import { renderWithTrpc } from "@/test/trpc-harness";
import { AppearanceSection } from "./appearance-section";

/**
 * Choosing light or dark (spec F16).
 *
 * The assertions are about the two places the choice has to land, because a theme that only
 * reaches one of them is broken in a way that is easy to miss. It has to reach the *document*,
 * which is what makes the page change; and it has to reach `localStorage`, which is what the
 * pre-paint boot script reads on the next load — miss that and every reload flashes the old
 * theme before correcting itself.
 */

afterEach(cleanup);

beforeEach(() => {
  resetThemeStore();
  document.documentElement.className = "";
  try {
    localStorage.removeItem(THEME_STORAGE_KEY);
  } catch {
    // Storage is optional here for the same reason it is in the component.
  }
});

const HANDLERS = {
  "preference.getAppearance": () => ({
    workspaceId: "ws-1",
    userId: "ada",
    appearance: { theme: "dark" },
  }),
  "preference.setAppearance": (input: unknown) => ({
    workspaceId: "ws-1",
    userId: "ada",
    appearance: input,
  }),
};

describe("the appearance section", () => {
  it("offers all three answers, because following the machine is one of them", async () => {
    renderWithTrpc(<AppearanceSection />, HANDLERS);

    for (const name of ["Light", "Dark", "System"]) {
      expect(await screen.findByRole("radio", { name: new RegExp(name) })).toBeDefined();
    }
  });

  it("changes the document, so the page actually repaints", async () => {
    renderWithTrpc(<AppearanceSection />, HANDLERS);

    fireEvent.click(await screen.findByRole("radio", { name: /Light/ }));

    await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(false));
    // The browser's own chrome — scrollbars, form controls — follows this rather than the class.
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("caches the choice for the pre-paint script, so the next load does not flash", async () => {
    renderWithTrpc(<AppearanceSection />, HANDLERS);

    fireEvent.click(await screen.findByRole("radio", { name: /Light/ }));

    await waitFor(() => expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light"));
  });

  it("stores the choice against the account, so it follows the user to another browser", async () => {
    const { log } = renderWithTrpc(<AppearanceSection />, HANDLERS);

    fireEvent.click(await screen.findByRole("radio", { name: /System/ }));

    await waitFor(() => {
      const writes = log.calls.filter((c) => c.path === "preference.setAppearance");
      expect(writes.at(-1)?.input).toEqual({ theme: "system" });
    });
  });
});
