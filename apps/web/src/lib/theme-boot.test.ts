/// <reference types="bun-types" />

import { describe, expect, it } from "bun:test";
import { THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "./theme-boot";

/**
 * The pre-paint script, run as the browser runs it: a string evaluated before anything else.
 *
 * It is a string rather than a function precisely so nothing can import, defer or bundle it —
 * which also means no type checker ever reads its body. These run it against a stand-in
 * `document`, `localStorage` and `matchMedia`, so a typo inside the template fails here instead
 * of shipping as an unstyled first paint on every load.
 */

type Stored = string | null | Error;

function boot(stored: Stored, osDark = false) {
  const classes = new Set<string>();
  const root = {
    classList: {
      toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)),
      add: (name: string) => classes.add(name),
    },
    style: { colorScheme: "" },
  };
  const reads: string[] = [];
  const storage = {
    getItem: (key: string) => {
      reads.push(key);
      if (stored instanceof Error) throw stored;
      return stored;
    },
  };
  const window = { matchMedia: () => ({ matches: osDark }) };
  new Function("localStorage", "window", "document", THEME_BOOT_SCRIPT)(storage, window, {
    documentElement: root,
  });
  return { dark: classes.has("dark"), colorScheme: root.style.colorScheme, reads };
}

describe("THEME_BOOT_SCRIPT", () => {
  it("reads the key the hook writes", () => {
    expect(boot("light").reads).toEqual([THEME_STORAGE_KEY]);
  });

  it("paints a stored light theme light, and a stored dark one dark", () => {
    expect(boot("light")).toMatchObject({ dark: false, colorScheme: "light" });
    expect(boot("dark")).toMatchObject({ dark: true, colorScheme: "dark" });
  });

  it("asks the machine when the stored choice is `system`", () => {
    expect(boot("system", true)).toMatchObject({ dark: true, colorScheme: "dark" });
    expect(boot("system", false)).toMatchObject({ dark: false, colorScheme: "light" });
  });

  it("paints dark for an install that never chose, as it always looked", () => {
    expect(boot(null)).toMatchObject({ dark: true, colorScheme: "dark" });
  });

  it("paints dark for a value that is not a theme, rather than following the machine", () => {
    expect(boot("sepia", false)).toMatchObject({ dark: true, colorScheme: "dark" });
  });

  it("still paints dark when storage refuses to be read", () => {
    // A private window or blocked site data throws on the read itself.
    expect(boot(new Error("SecurityError")).dark).toBe(true);
  });
});
