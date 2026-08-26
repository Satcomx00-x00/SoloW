import {
  Columns3,
  FolderGit2,
  Inbox,
  type LucideIcon,
  Settings,
  Table2,
  Workflow,
} from "lucide-react";

/**
 * The shape of the app, in one file.
 *
 * **A Project is the top level.** Everything that is work — a board, an issue list, a workflow —
 * is read inside one, and the routes say so: `/projects/:id/board`, not `/board`. That is not
 * decoration. The board used to be a peer of Projects in a flat rail of five, which told a
 * newcomer that a Project was one more view of the same pile rather than the container the pile
 * lives in; the whole point of F23 is that planning sits above execution
 * ([Decision 0006](../../../docs/decisions/0006-issue-task-separation.md)), and a flat rail said
 * the opposite every time the app opened.
 *
 * Two lists, because there are genuinely two kinds of destination:
 *
 *  - `WORKSPACE_SECTIONS` — the few things that exist without a Project: the Project list itself,
 *    the unassigned escape hatch, and Settings.
 *  - `PROJECT_SECTIONS` — everything inside one, resolved against a Project id.
 *
 * Search is deliberately in neither. In VS Code it is a rail icon that opens a panel; here the
 * search surface is the command palette, so the rail entry opens that instead of navigating — a
 * different kind of thing, and a nav list holding it would have to lie about `href`.
 */
export interface Section {
  href: string;
  label: string;
  /** What the navigator's header says underneath the section name. */
  caption: string;
  icon: LucideIcon;
  /**
   * True for a section whose UI is live but not functionally complete — see
   * docs/features/F03-workflow-designer.md. Renderers read this to show a WIP marker instead of
   * letting the section pass for finished work.
   */
  wip?: boolean;
}

/** Destinations that exist with no Project selected. */
export const WORKSPACE_SECTIONS: readonly Section[] = [
  {
    href: "/projects",
    label: "Projects",
    // The hub, not a view: this is where a session starts and where a Project is adopted.
    caption: "Everything starts here",
    icon: FolderGit2,
  },
  {
    href: "/unassigned",
    label: "Unassigned",
    caption: "Issues in no project",
    icon: Inbox,
  },
  {
    href: "/settings",
    label: "Settings",
    caption: "Profiles, repositories, secrets",
    icon: Settings,
  },
];

/**
 * The sections *inside* a Project, in the order the work moves through them: plan it, run it,
 * read what came back.
 *
 * `path` is a suffix appended to `/projects/:id`; the overview is the empty string, so the
 * Project's own URL is its table rather than a redirect to a child.
 */
export interface ProjectSection {
  path: string;
  label: string;
  caption: string;
  icon: LucideIcon;
  wip?: boolean;
}

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  { path: "", label: "Planning", caption: "The project table", icon: Table2 },
  { path: "/board", label: "Board", caption: "Agent runs, by state", icon: Columns3 },
  { path: "/issues", label: "Issues", caption: "Work in this project", icon: Inbox },
  {
    path: "/workflows",
    label: "Workflows",
    caption: "Repeatable multi-agent pipelines",
    icon: Workflow,
    wip: true,
  },
];

/** The href for one section of one Project. */
export function projectSectionHref(projectId: string, path: string): string {
  return `/projects/${projectId}${path}`;
}

/**
 * The Project a path is inside, or null.
 *
 * Read from the URL rather than held in a store, so a reload, a shared link and a back button all
 * land on the same Project — the alternative is a selection that only exists in memory and
 * silently resets to "some project" on every refresh.
 */
export function projectIdFromPath(pathname: string): string | null {
  const match = /^\/projects\/([^/]+)/.exec(pathname);
  const id = match?.[1];
  // `/projects` alone is the list, not a Project — and it must not resolve to one, or the hub
  // would render as a project whose id is the word "projects".
  return id && id !== "new" ? id : null;
}

/** Which project section a path is in. Longest match wins, so `/issues` beats the empty overview. */
export function projectSectionFor(pathname: string): ProjectSection | null {
  const projectId = projectIdFromPath(pathname);
  if (!projectId) return null;
  const rest = pathname.slice(`/projects/${projectId}`.length);
  return (
    [...PROJECT_SECTIONS]
      .sort((a, b) => b.path.length - a.path.length)
      .find((s) => (s.path === "" ? rest === "" : rest.startsWith(s.path))) ?? null
  );
}

/** The workspace section a path belongs to, or null on a path outside them (e.g. sign-in). */
export function sectionFor(pathname: string): Section | null {
  // A Task is work inside a Project, but its route is flat (`/task/:id`) because a Task outlives
  // the Project view it was opened from. It lights the Projects rail entry, which is the nearest
  // true statement about where it belongs.
  if (pathname.startsWith("/task/")) return WORKSPACE_SECTIONS[0] ?? null;
  return (
    WORKSPACE_SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? null
  );
}

/**
 * Every destination the command palette can offer, flattened.
 *
 * The palette cannot know which Projects exist without asking the server, so this is the static
 * half — the workspace destinations — and the palette adds one entry per Project itself.
 */
export const SECTIONS = WORKSPACE_SECTIONS;
