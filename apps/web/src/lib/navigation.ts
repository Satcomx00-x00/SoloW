import { Columns3, Inbox, type LucideIcon, Settings } from "lucide-react";

/**
 * The top-level sections of the app, in rail order.
 *
 * One list rather than three: the activity rail, the breadcrumb and the command palette all
 * describe the same places, and when they were spelled out separately the palette offered
 * destinations the rail did not have.
 *
 * Search is deliberately *not* here. In VS Code it is a rail icon that opens a panel; here the
 * search surface is the command palette, so the rail entry opens that instead of navigating —
 * a different kind of thing, and a nav list that contained it would have to lie about `href`.
 */
export interface Section {
  href: string;
  label: string;
  /** What the navigator's header says underneath the section name. */
  caption: string;
  icon: LucideIcon;
}

export const SECTIONS: readonly Section[] = [
  { href: "/board", label: "Board", caption: "Task board", icon: Columns3 },
  { href: "/issues", label: "Issues", caption: "Work to be done", icon: Inbox },
  {
    href: "/settings",
    label: "Settings",
    caption: "Profiles, repositories, secrets",
    icon: Settings,
  },
];

/** The section a path belongs to, or null on a path outside the sectioned app (e.g. sign-in). */
export function sectionFor(pathname: string): Section | null {
  // A Task lives under the board conceptually, so `/task/…` keeps the board rail lit.
  if (pathname.startsWith("/task/")) return SECTIONS[0] ?? null;
  return SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? null;
}
