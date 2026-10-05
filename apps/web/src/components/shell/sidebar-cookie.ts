/**
 * The cookies that remember the sidebar: whether it is shown, and how wide. Their own module
 * because the server layout reads them, and importing a constant from a `"use client"` file would
 * pull that file's whole graph into the server bundle.
 */
export const SIDEBAR_COOKIE = "solow-sidebar";
export const SIDEBAR_WIDTH_COOKIE = "solow-sidebar-width";

/** Narrow enough to leave a board its columns, wide enough for a long Project name. */
export const SIDEBAR_MIN_WIDTH = 200;
export const SIDEBAR_MAX_WIDTH = 360;
export const SIDEBAR_DEFAULT_WIDTH = 240;

/** A stored or dragged width, made safe: anything unreadable is the default, anything else clamped. */
export function clampSidebarWidth(value: unknown): number {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, Math.round(n)));
}
