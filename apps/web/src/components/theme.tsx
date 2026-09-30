"use client";

import { type Theme, themeSchema } from "@solow/contracts";
import { useCallback, useEffect, useSyncExternalStore } from "react";
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

/*
 * One theme per page, shared by every `useTheme` — the shell's `ThemeSync` and Settings'
 * Appearance are both mounted at once, and while each kept its own state they could disagree:
 * the section repainted light on a press while the shell, which never saw the press, adopted a
 * stale "dark" from the server and painted and cached it right back. Module state behind
 * `useSyncExternalStore` rather than a context, for the reason `ThemeSync` gives: nothing reads a
 * theme through the tree — the document's class is the state.
 *
 * `chosen` is null until the cache has been read. Rendering shows `dark` meanwhile (the server's
 * answer, so the markup agrees with itself), but nothing is *applied or cached* from that
 * placeholder: painting it would undo the boot script — a dark flash on every load of a light
 * install — and overwrite the cache before it was read.
 */
const store = {
  chosen: null as Theme | null,
  /** The last answer the server gave, so only a genuinely new one is adopted. */
  lastFromServer: null as Theme | null,
  /** A press not yet confirmed by the server; answers that disagree predate it. */
  pending: null as Theme | null,
  listeners: new Set<() => void>(),
};

function choose(next: Theme): void {
  if (store.chosen === next) return;
  store.chosen = next;
  for (const listener of store.listeners) listener();
}

function subscribe(listener: () => void): () => void {
  store.listeners.add(listener);
  return () => store.listeners.delete(listener);
}

/** For tests: every render in a test file shares this module, and a test must start clean. */
export function resetThemeStore(): void {
  store.chosen = null;
  store.lastFromServer = null;
  store.pending = null;
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
  const chosen = useSyncExternalStore(
    subscribe,
    () => store.chosen,
    () => null,
  );
  const theme: Theme = chosen ?? "dark";

  // After mount, never during render: the value comes from `localStorage`, which the server does
  // not have, so reading it while rendering would make the markup disagree with itself. Only the
  // first hook to mount reads it; the rest share what it read.
  useEffect(() => {
    if (store.chosen === null) choose(cachedTheme());
  }, []);

  const stored = trpc.preference.getAppearance.useQuery(
    {},
    {
      // The flag can be off, and the shell still has to render. A theme is the one preference
      // whose absence must never be an error on screen.
      retry: false,
    },
  );
  const save = trpc.preference.setAppearance.useMutation({
    onSettled: async () => {
      // Cancelled first: a press made before the page's first read of the row answered would
      // otherwise have this invalidation join that read — which began before the write — and the
      // row would never be read again (the same React Query behaviour `SplitTaskButton` notes).
      await utils.preference.getAppearance.cancel();
      void utils.preference.getAppearance.invalidate();
    },
    onError: () => {
      // The row keeps its old value, and the page keeps the press — nothing to wait for.
      store.pending = null;
    },
  });

  /*
   * The row is the record, so a change made in another browser has to arrive here — but only
   * when it is genuinely *new*, and never one that predates a press still being saved.
   *
   * Comparing the server's answer against the local value would fight every change the user
   * makes: `setTheme` repaints immediately and the refetch behind it takes a moment, so for that
   * moment the row still says the old theme. Comparing against the last value the server gave
   * narrows the rule to an external change; and while a press is pending, an answer that
   * disagrees with it came from a read begun before it — the first read of a page opened a moment
   * ago is the common case — so it is not adopted. The first answer after mount wins otherwise,
   * which is the record winning on load.
   */
  const fromServer = stored.data?.appearance.theme;
  useEffect(() => {
    if (!fromServer) return;
    if (store.pending !== null) {
      if (fromServer !== store.pending) return;
      store.pending = null;
    }
    if (store.lastFromServer === fromServer) return;
    store.lastFromServer = fromServer;
    choose(fromServer);
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
      store.pending = next;
      choose(next);
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
