/**
 * The cookie that remembers whether the sidebar is shown. Its own module because the server
 * layout reads it, and importing a constant from a `"use client"` file would pull that file's
 * whole graph into the server bundle.
 */
export const SIDEBAR_COOKIE = "solow-sidebar";
