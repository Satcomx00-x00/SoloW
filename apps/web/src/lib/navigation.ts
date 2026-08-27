import {
  Blocks,
  Bot,
  Columns3,
  FlaskConical,
  FolderGit2,
  Inbox,
  KeyRound,
  type LucideIcon,
  PanelBottom,
  PlugZap,
  Server,
  Settings,
  Table2,
  UserRound,
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

/**
 * The sections of Settings, grouped — the second half of "the shape of the app, in one file".
 *
 * This list used to exist twice and agree nowhere: nine `<Card id="…">` stacked into a single
 * 3,000-line column by `settings.tsx`, and a hard-coded four of them in the sidebar. So five
 * sections — including the two the command palette links straight to — had no entry in the
 * navigation at all, and reaching Feature flags meant scrolling past every MCP token and executor
 * form in the Workspace. One registry, read by both, is what stops the two drifting again.
 *
 * The **group** is what turns the page from a pile into a page. A person arrives knowing the kind
 * of thing they came to change — "where the work comes from", "what runs it" — not the name of the
 * card that holds it, and a group is small enough to read in one screen. It is also the unit the
 * page renders: one group at a time, so no section is behind a scroll of unrelated forms.
 *
 * The order inside a group is the order things are set up in, and that is deliberate: a Secret,
 * then the Agent Profile that spends it, then somewhere to execute it.
 */
export interface SettingsSection {
  /** Also the `id` of the card it renders, so an in-page anchor points at the right form. */
  id: string;
  label: string;
  /** One line for the picker: what this section decides. */
  caption: string;
  group: SettingsGroup;
  icon: LucideIcon;
}

export type SettingsGroup = "Connections" | "Agents" | "Extensions" | "Interface";

/** The groups in the order they are listed, each with the sentence its pane opens on. */
export const SETTINGS_GROUPS: readonly { name: SettingsGroup; caption: string }[] = [
  {
    name: "Connections",
    caption: "Where the work comes from, and where an agent is allowed to write.",
  },
  {
    name: "Agents",
    caption: "A credential, the agent that spends it, and the machine it runs on.",
  },
  { name: "Extensions", caption: "What can reach SoloW from outside." },
  { name: "Interface", caption: "How this app looks, and what it lets you try early." },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "integrations",
    label: "Integrations",
    caption: "The GitHub, GitLab and Gitea accounts this Workspace reads work from",
    group: "Connections",
    icon: PlugZap,
  },
  {
    id: "repositories",
    label: "Repositories",
    caption: "The checkouts an agent is allowed to work in",
    group: "Connections",
    icon: FolderGit2,
  },
  {
    id: "provider-identity",
    label: "Your provider logins",
    caption: "Which account is you on each provider — what @me resolves to",
    group: "Connections",
    icon: UserRound,
  },
  {
    id: "secrets",
    label: "Secrets",
    caption: "Write-only credentials, never shown again after they are set",
    group: "Agents",
    icon: KeyRound,
  },
  {
    id: "agent-profiles",
    label: "Agent profiles",
    caption: "Which agent runs, how it authenticates, how many at once",
    group: "Agents",
    icon: Bot,
  },
  {
    id: "executor-profiles",
    label: "Executors",
    caption: "Where an agent's commands actually run",
    group: "Agents",
    icon: Server,
  },
  {
    id: "mcp",
    label: "MCP",
    caption: "Tokens that let an outside agent drive this Workspace",
    group: "Extensions",
    icon: Blocks,
  },
  {
    id: "status-bar",
    label: "Status bar",
    caption: "What the bar along the bottom shows, and in what order",
    group: "Interface",
    icon: PanelBottom,
  },
  {
    id: "flags",
    label: "Feature flags",
    caption: "Unfinished work, switchable on for this Workspace",
    group: "Interface",
    icon: FlaskConical,
  },
];

/**
 * The section an id names, falling back to the first one.
 *
 * A fallback rather than a null: `/settings` with no parameter is an address people type, and it
 * has to open on something. An unknown id falls back too — a stale bookmark should land on a
 * settings page, not on an error.
 */
export function settingsSectionFor(id: string | null | undefined): SettingsSection {
  const first = SETTINGS_SECTIONS[0];
  if (!first) throw new Error("SETTINGS_SECTIONS is empty");
  if (!id) return first;
  // Tolerates a leading `#`: `/settings#secrets` was the address for months and is still in
  // people's history and in older docs.
  const wanted = id.replace(/^#/, "");
  return SETTINGS_SECTIONS.find((s) => s.id === wanted) ?? first;
}

/** The sections of one group, in setup order. */
export function settingsSectionsIn(group: SettingsGroup): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((s) => s.group === group);
}

/** The address of one settings section. */
export function settingsHref(id: string): string {
  return `/settings?section=${id}`;
}
