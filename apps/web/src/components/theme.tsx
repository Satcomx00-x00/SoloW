"use client";

import { type Theme, themeSchema } from "@solow/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { THEME_STORAGE_KEY } from "@/lib/theme-boot";
import { trpc } from "@/trpc/react";

/**
 * Light and dark, as something a user chooses (spec F16).
 *
 * The theme was a hard-coded `dark` on `<html>`. The tokens for both themes were already fully
 * authored in `globals.css` — `:root` is light, `.dark` overrides it, and `@custom-variant dark`
 * is wired to the class — so making it a choice is a matter of deciding *which class* goes on
 * the element, and of doing that before the first paint.
 *
 * **Two sources, deliberately.** The server preference (`preference.getAppearance`) is the truth:
 * it follows the user to another browser, and it is what Settings writes. But it arrives over
 * tRPC, one round trip after the page has already painted — so on its own it would mean a white
 * flash on every single load of a dark install. The resolved choice is therefore mirrored into
 * `localStorage` and read back by a synchronous script in `<head>` (`THEME_BOOT_SCRIPT`) before
 * anything renders. localStorage is the cache; the row is the record. They can disagree for
 * exactly one round trip after a change made in another browser, and the row wins.
 *
 * Everything here tolerates `localStorage` throwing — a private window, blocked site data, a
 * thumbnailer. A theme that could not be cached still renders; it just flashes once.
 */

/**
 * What actually goes on `<html>`, once `system` has been asked what it means.
 *
 * `system` is a real stored value rather than the absence of one (see `themeSchema`), so it has
 * to be resolved somewhere; doing it here keeps the one `matchMedia` read in one place.
 */
export function resolveTheme(theme: Theme): "light" | "dark" {
  if (theme !== "system") return theme;
  return typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

/** Put the resolved theme on the document. The single place that touches `<html>`'s class. */
function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const resolved = resolveTheme(theme);
  root.classList.toggle("dark", resolved === "dark");
  // Kept in step with the class so the browser's own chrome follows even before the stylesheet
  // that declares `color-scheme` has applied.
  root.style.colorScheme = resolved;
}

/** What the boot script already decided, so the first client render agrees with the paint. */
function cachedTheme(): Theme {
  try {
    const parsed = themeSchema.safeParse(localStorage.getItem(THEME_STORAGE_KEY));
    if (parsed.success) return parsed.data;
  } catch {
    // Unreadable storage is not an error worth surfacing: the default is a correct answer.
  }
  return "dark";
}

/**
 * Read and change the theme.
 *
 * Optimistic, and the optimism is the point: a theme that repainted only once the server had
 * acknowledged it would feel broken on a slow connection, and there is nothing to roll back to
 * if the write fails — the document is already the colour the user asked for. A failed write
 * means the choice does not follow them to another browser, which the Settings section reports.
 */
export function useTheme(): {
  theme: Theme;
  setTheme: (next: Theme) => void;
  saving: boolean;
  error: string | null;
} {
  const utils = trpc.useUtils();
  /*
   * Null until the cache has been read. Rendering still shows `dark` meanwhile (the server's
   * answer, so the markup agrees with itself), but nothing is *applied or cached* from that
   * placeholder: an effect that painted it would undo the boot script — a dark flash on every
   * load of a light install — and would overwrite the cache before a second `useTheme` on the
   * page (Settings' Appearance beside `ThemeSync`) had read it. Found by the e2e check that the
   * theme is on `<html>` at DOMContentLoaded, which CI's faster hydration made fail.
   */
  const [chosen, setLocal] = useState<Theme | null>(null);
  const theme: Theme = chosen ?? "dark";

  // After mount, never during render: the value comes from `localStorage`, which the server does
  // not have, so reading it while rendering would make the markup disagree with itself.
  useEffect(() => setLocal(cachedTheme()), []);

  const stored = trpc.preference.getAppearance.useQuery(
    {},
    {
      // The flag can be off, and the shell still has to render. A theme is the one preference
      // whose absence must never be an error on screen.
      retry: false,
    },
  );
  const save = trpc.preference.setAppearance.useMutation({
    onSettled: () => utils.preference.getAppearance.invalidate(),
  });

  /*
   * The row is the record, so a change made in another browser has to arrive here — but only
   * when it is genuinely *new*.
   *
   * Comparing the server's answer against the local value instead would fight every change the
   * user makes: `setTheme` repaints immediately and the refetch behind it takes a moment, so for
   * that moment the cached row still says the old theme and a naive "the row wins" rule drags
   * the page back to it before letting it go again. Comparing against the last value the server
   * gave narrows the rule to what it was for — an external change — and leaves a local one
   * alone. The first answer after mount is always adopted, which is the record winning on load.
   */
  const fromServer = stored.data?.appearance.theme;
  const lastFromServer = useRef<Theme | null>(null);
  useEffect(() => {
    if (!fromServer || lastFromServer.current === fromServer) return;
    lastFromServer.current = fromServer;
    setLocal(fromServer);
  }, [fromServer]);

  useEffect(() => {
    if (chosen === null) return;
    applyTheme(chosen);
    try {
      localStorage.setItem(THEME_STORAGE_KEY, chosen);
    } catch {
      // See the note on `cachedTheme` — an uncacheable theme still applies, it just flashes.
    }
  }, [chosen]);

  // `system` is not a fixed answer: the OS can change it while the page is open, and a console
  // left open overnight is exactly where that happens.
  useEffect(() => {
    if (chosen !== "system" || !window.matchMedia) return;
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [chosen]);

  const setTheme = useCallback(
    (next: Theme) => {
      setLocal(next);
      save.mutate({ theme: next });
    },
    [save.mutate],
  );

  return {
    theme,
    setTheme,
    saving: save.isPending,
    error: save.error ? save.error.message : null,
  };
}

/**
 * Applies the stored theme for the whole app, and renders nothing.
 *
 * A component rather than a call in the layout because the layout is a server component and this
 * needs the tRPC client. It sits beside the shell rather than wrapping it: nothing reads a theme
 * through context — the document's class is the state, and CSS is what consumes it.
 */
export function ThemeSync() {
  useTheme();
  return null;
}
