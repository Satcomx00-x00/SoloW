/**
 * The theme, before anything renders.
 *
 * Its own module, with no `"use client"`, because `app/layout.tsx` is a server component: a
 * constant imported from a client module arrives there as a client reference rather than as the
 * string it is, and the `<script>` would emit nothing. Splitting the two lines the server needs
 * away from the hook that needs the browser is what lets both sides import them honestly.
 */

/** The `localStorage` key the boot script and `components/theme.tsx` agree on. */
export const THEME_STORAGE_KEY = "solow.theme";

/**
 * The script that runs before the first paint.
 *
 * Inline and synchronous on purpose: anything deferred, imported or awaited paints first, and a
 * theme that arrives after the paint is a flash rather than a theme. The stored preference is
 * the record, but it comes over tRPC one round trip later — so the resolved choice is mirrored
 * into `localStorage` and read back here.
 *
 * Deliberately tiny and deliberately forgiving: a thrown `localStorage` read would otherwise
 * leave the page unstyled, so the whole body is wrapped and failure falls back to the default.
 * `dark` is that default, matching `DEFAULT_APPEARANCE` — an install that has never chosen looks
 * the way it always did rather than changing appearance on upgrade.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var t=localStorage.getItem(${JSON.stringify(
  THEME_STORAGE_KEY,
)});if(t!=="light"&&t!=="dark"&&t!=="system")t="dark";var d=t==="dark"||(t==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.classList.toggle("dark",d);document.documentElement.style.colorScheme=d?"dark":"light";}catch(e){document.documentElement.classList.add("dark");}})();`;
