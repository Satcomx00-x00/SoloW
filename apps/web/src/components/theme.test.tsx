/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import type { Theme } from "@solow/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { THEME_STORAGE_KEY } from "@/lib/theme-boot";
import { renderWithTrpc } from "@/test/trpc-harness";
import { resetThemeStore, resolveTheme, useTheme } from "./theme";

/**
 * The theme's two sources, and what happens when they disagree (spec F16).
 *
 * `appearance-section.test.tsx` covers the happy press. These cover the rules the module's own
 * comment makes promises about: the stored row wins on load over the `localStorage` cache, a
 * local press is not dragged back by a stale row, storage that throws never stops a theme from
 * applying, and `system` keeps following the machine while the page is open.
 */

/** A `matchMedia` whose answer the test flips, dispatching `change` the way a browser does. */
function fakeMatchMedia(initiallyDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: initiallyDark,
    addEventListener: (_: string, fn: () => void) => listeners.add(fn),
    removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
  };
  const original = window.matchMedia;
  window.matchMedia = (() => query) as unknown as typeof window.matchMedia;
  return {
    listeners,
    setDark(dark: boolean) {
      query.matches = dark;
      for (const fn of listeners) fn();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

function appearance(theme: Theme) {
  return { workspaceId: "ws-1", userId: "ada", appearance: { theme } };
}

function Probe() {
  const { theme, setTheme, error } = useTheme();
  return (
    <div>
      <output aria-label="theme">{theme}</output>
      <output aria-label="error">{error ?? ""}</output>
      <button onClick={() => setTheme("light")} type="button">
        Light
      </button>
    </div>
  );
}

const isDark = () => document.documentElement.classList.contains("dark");

let media: ReturnType<typeof fakeMatchMedia> | null = null;

beforeEach(() => {
  resetThemeStore();
  document.documentElement.className = "";
  document.documentElement.style.colorScheme = "";
  localStorage.removeItem(THEME_STORAGE_KEY);
});

afterEach(() => {
  cleanup();
  media?.restore();
  media = null;
});

describe("resolveTheme", () => {
  it("passes a fixed choice straight through", () => {
    expect(resolveTheme("light")).toBe("light");
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("asks the machine what `system` means", () => {
    media = fakeMatchMedia(true);
    expect(resolveTheme("system")).toBe("dark");
    media.setDark(false);
    expect(resolveTheme("system")).toBe("light");
  });

  it("reads `system` as light where the browser cannot answer", () => {
    const original = window.matchMedia;
    // An embedded webview or a thumbnailer: no media queries at all.
    (window as { matchMedia?: unknown }).matchMedia = undefined;
    try {
      expect(resolveTheme("system")).toBe("light");
    } finally {
      window.matchMedia = original;
    }
  });
});

describe("useTheme", () => {
  it("keeps a press made before the page's first read of the row answered — on every hook", async () => {
    // Settings a moment after opening it: the row's first read is still out when Light is
    // pressed, and it answers afterwards with the value from before the press.
    let reads = 0;
    renderWithTrpc(
      <>
        <Probe />
        <Probe />
      </>,
      {
        "preference.getAppearance": () =>
          reads++ === 0
            ? new Promise((resolve) => setTimeout(() => resolve(appearance("dark")), 300))
            : appearance("light"),
        "preference.setAppearance": () => appearance("light"),
      },
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Light" })[0] as HTMLElement);

    await new Promise((resolve) => setTimeout(resolve, 500));
    await waitFor(() => {
      // Both hooks — the one pressed and the shell's — agree, and so do the page and its cache.
      expect(screen.getAllByLabelText("theme").map((el) => el.textContent)).toEqual([
        "light",
        "light",
      ]);
      expect(isDark()).toBe(false);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    });
  });

  it("never paints or caches its placeholder before reading the cache — no dark flash on a light install", async () => {
    // What the boot script left: a light install, painted light before any of this ran.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    document.documentElement.classList.remove("dark");
    const paintedDark: boolean[] = [];
    const observer = new MutationObserver(() => paintedDark.push(isDark()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    const writes = spyOn(localStorage, "setItem");
    try {
      // Two hooks on one page, as in Settings: Appearance beside the shell's ThemeSync.
      renderWithTrpc(
        <>
          <Probe />
          <Probe />
        </>,
        { "preference.getAppearance": () => new Promise(() => {}) },
      );
      await waitFor(() =>
        expect(screen.getAllByLabelText("theme").map((el) => el.textContent)).toEqual([
          "light",
          "light",
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(paintedDark).not.toContain(true);
      expect(writes.mock.calls.filter(([, value]) => value === "dark")).toEqual([]);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
    } finally {
      observer.disconnect();
      writes.mockRestore();
    }
  });

  it("lets the stored row win over the cache on load, and re-caches what it said", async () => {
    // Another browser chose dark since this one last cached light.
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderWithTrpc(<Probe />, { "preference.getAppearance": () => appearance("dark") });

    // All three inside the wait: the label, the class and the cache are written by separate
    // effects, and on a loaded machine the label can be read before the cache write has run.
    await waitFor(() => {
      expect(screen.getByLabelText("theme").textContent).toBe("dark");
      expect(isDark()).toBe(true);
      expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
    });
  });

  it("paints from the cache while the row is still on its way", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderWithTrpc(<Probe />, { "preference.getAppearance": () => new Promise(() => {}) });

    await waitFor(() => expect(screen.getByLabelText("theme").textContent).toBe("light"));
    expect(isDark()).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("falls back to dark when the cache holds something that is not a theme", async () => {
    localStorage.setItem(THEME_STORAGE_KEY, "sepia");
    renderWithTrpc(<Probe />, { "preference.getAppearance": () => new Promise(() => {}) });

    await waitFor(() => expect(isDark()).toBe(true));
    expect(screen.getByLabelText("theme").textContent).toBe("dark");
  });

  it("keeps a local press even while the row still says the old theme", async () => {
    // The refetch behind a press takes a moment; for that moment the row is stale, and a naive
    // "the row wins" rule would drag the page straight back.
    renderWithTrpc(<Probe />, {
      "preference.getAppearance": () => appearance("dark"),
      "preference.setAppearance": () => appearance("dark"),
    });
    await waitFor(() => expect(isDark()).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => expect(isDark()).toBe(false));
    // Give the invalidation's refetch time to land, then check the press survived it.
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(isDark()).toBe(false);
    expect(screen.getByLabelText("theme").textContent).toBe("light");
  });

  it("still applies a theme when storage throws on every read and write", async () => {
    const get = spyOn(localStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    const set = spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    try {
      renderWithTrpc(<Probe />, { "preference.getAppearance": () => appearance("light") });

      await waitFor(() => expect(screen.getByLabelText("theme").textContent).toBe("light"));
      expect(isDark()).toBe(false);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });

  it("follows the machine while `system` is chosen and the page stays open", async () => {
    media = fakeMatchMedia(false);
    renderWithTrpc(<Probe />, { "preference.getAppearance": () => appearance("system") });
    await waitFor(() => expect(screen.getByLabelText("theme").textContent).toBe("system"));
    expect(isDark()).toBe(false);

    act(() => media?.setDark(true));

    expect(isDark()).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
  });

  it("stops listening to the machine once a fixed theme is chosen", async () => {
    media = fakeMatchMedia(false);
    renderWithTrpc(<Probe />, {
      "preference.getAppearance": () => appearance("system"),
      "preference.setAppearance": () => appearance("light"),
    });
    await waitFor(() => expect(media?.listeners.size).toBe(1));

    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => expect(media?.listeners.size).toBe(0));
    act(() => media?.setDark(true));
    expect(isDark()).toBe(false);
  });

  it("says when the choice could not be stored, without undoing it", async () => {
    renderWithTrpc(<Probe />, {
      "preference.getAppearance": () => appearance("dark"),
      "preference.setAppearance": () => {
        throw new Error("Appearance is turned off for this Workspace");
      },
    });
    await waitFor(() => expect(isDark()).toBe(true));

    fireEvent.click(screen.getByRole("button", { name: "Light" }));

    await waitFor(() => expect(screen.getByLabelText("error").textContent).toContain("turned off"));
    // Nothing to roll back to: the document is already the colour the user asked for.
    expect(isDark()).toBe(false);
  });
});
