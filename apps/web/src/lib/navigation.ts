import {
  Blocks,
  BookOpen,
  Bot,
  Building2,
  CircleDot,
  Columns3,
  Eraser,
  FileJson,
  FlaskConical,
  FolderGit2,
  FolderKanban,
  History,
  Inbox,
  KeyRound,
  type LucideIcon,
  PanelBottom,
  Plug,
  PlugZap,
  Server,
  Settings,
  Sparkles,
  SunMoon,
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
 *  - `WORKSPACE_SECTIONS` — the things that exist without a Project: the Project list itself,
 *    the unassigned escape hatch, Workflows, History and Settings.
 *  - `PROJECT_SECTIONS` — everything inside one, resolved against a Project id.
 *
 * **Workflows is in the first list, not the second.** It sat under `/projects/:id/workflows` for
 * a while, which read as "a Project has workflows" — but `workflow.list` takes no Project and
 * never did, and a Workflow's Steps name Harness Profiles, so the same pipeline was being drawn
 * identically under every Project in the Workspace. A route that implies a scope the query does
 * not have is a route that lies; it is a top-level destination now, which is also what
 * docs/features/F03-workflow-designer.md said all along.
 *
 * Search is deliberately in neither: the search surface is the command palette, which a button
 * opens rather than a route — a nav list holding it would have to lie about `href`.
 *
 * The sidebar (`components/shell/sidebar-nav.tsx`) draws both lists in one column, Projects first
 * with the open one's sections nested under it — see Decision 0029 for why the activity rail and
 * the per-route navigator it replaced were taken out.
 */
export interface Section {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * True for a section whose UI is live but not functionally complete — see
   * docs/features/F03-workflow-designer.md. Renderers read this to show a WIP marker instead of
   * letting the section pass for finished work.
   */
  wip?: boolean;
}

/**
 * Destinations that exist with no Project selected, in sidebar order.
 *
 * `/projects` is first, and is a destination again. It was left out on the argument that the
 * navigator's title picked the Project (spec F16), but that made the front door of the app — where
 * `/` redirects, and where a Project is created — the one page nothing in the chrome linked to;
 * the only way back to it was a "New or adopted project…" entry inside the switcher. The sidebar
 * now lists the Projects themselves under this entry, so choosing one is still a single click.
 */
export const WORKSPACE_SECTIONS: readonly Section[] = [
  { href: "/projects", label: "Projects", icon: FolderKanban },
  { href: "/unassigned", label: "Unassigned", icon: Inbox },
  // Deliberately not "…in this project": a Workflow names Harness Profiles and Steps, never a
  // Project, so nothing about this entry may imply a scope the data does not have.
  { href: "/workflows", label: "Workflows", icon: Workflow, wip: true },
  { href: "/history", label: "History", icon: History },
  { href: "/settings", label: "Settings", icon: Settings },
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
  icon: LucideIcon;
  wip?: boolean;
}

export const PROJECT_SECTIONS: readonly ProjectSection[] = [
  { path: "", label: "Planning", icon: Table2 },
  { path: "/board", label: "Board", icon: Columns3 },
  { path: "/issues", label: "Issues", icon: CircleDot },
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

/**
 * The Workflow a path has open, or null on `/workflows` itself.
 *
 * Same reasoning as `projectIdFromPath`: the selection is in the URL rather than in a component's
 * state, so the primary sidebar's list, the canvas and the secondary sidebar's inspector all read
 * one answer — and a reload or a shared link lands on the same pipeline.
 */
export function workflowIdFromPath(pathname: string): string | null {
  return /^\/workflows\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** The Task a path has open, or null. The route is flat on purpose — see `sectionFor`. */
export function taskIdFromPath(pathname: string): string | null {
  return /^\/task\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** The Issue a path has open, or null. Flat for the same reason a Task's route is. */
export function issueIdFromPath(pathname: string): string | null {
  return /^\/issues\/([^/]+)/.exec(pathname)?.[1] ?? null;
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
  /*
   * A Task is work inside a Project, but its route is flat (`/task/:id`) because a Task outlives
   * the Project view it was opened from. Matching it here would answer "Projects" for every Task,
   * including one whose Issue is in no Project at all — so it matches nothing, and the sidebar and
   * breadcrumb ask the server which Project holds it instead.
   */
  if (pathname.startsWith("/task/")) return null;
  return (
    WORKSPACE_SECTIONS.find((s) => pathname === s.href || pathname.startsWith(`${s.href}/`)) ?? null
  );
}

/**
 * Every destination the command palette can offer, flattened.
 *
 * The static half only — the workspace destinations. The palette cannot know which Projects exist
 * without asking the server.
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
 * then the Harness Profile that spends it, then somewhere to execute it.
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

export type SettingsGroup = "Workspace" | "Connections" | "Harnesses" | "Extensions" | "Interface";

/** The groups in the order they are listed, each with the sentence its pane opens on. */
export const SETTINGS_GROUPS: readonly { name: SettingsGroup; caption: string }[] = [
  {
    name: "Workspace",
    caption: "The tenant everything else here belongs to.",
  },
  {
    name: "Connections",
    caption: "Where the work comes from, and where a harness is allowed to write.",
  },
  {
    name: "Harnesses",
    caption: "A credential, the harness that spends it, and the machine it runs on.",
  },
  { name: "Extensions", caption: "What can reach SoloW from outside." },
  { name: "Interface", caption: "How this app looks, and what it lets you try early." },
];

export const SETTINGS_SECTIONS: readonly SettingsSection[] = [
  {
    id: "workspace",
    label: "Workspace",
    caption: "Its name, and what it still needs before it can run anything",
    group: "Workspace",
    icon: Building2,
  },
  {
    id: "danger-zone",
    label: "Reset",
    caption: "Empty this Workspace — its work, or everything but the account",
    group: "Workspace",
    icon: Eraser,
  },
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
    caption: "The checkouts a harness is allowed to work in",
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
    group: "Harnesses",
    icon: KeyRound,
  },
  {
    id: "agent-profiles",
    label: "Harness profiles",
    caption: "Which harness runs, how it authenticates, how many at once",
    group: "Harnesses",
    icon: Bot,
  },
  {
    id: "harness-configs",
    label: "Harness configs",
    caption: "The harness's own settings JSON, stored here instead of in your home directory",
    group: "Harnesses",
    icon: FileJson,
  },
  {
    id: "executor-profiles",
    label: "Executors",
    caption: "Where a harness's commands actually run",
    group: "Harnesses",
    icon: Server,
  },
  {
    id: "task-defaults",
    label: "New task defaults",
    caption: "The harness and executor a new Task starts with",
    group: "Harnesses",
    icon: Sparkles,
  },
  {
    id: "mcp-servers",
    label: "MCP servers",
    caption: "Tools every harness can call — or only the Steps that name them",
    group: "Harnesses",
    icon: Plug,
  },
  {
    id: "skills",
    label: "Skills",
    caption: "Playbooks a harness reads before it works, written here or kept in a directory",
    group: "Harnesses",
    icon: BookOpen,
  },
  {
    id: "mcp",
    // "MCP access", not "MCP": the *servers* a harness loads live under Harnesses, and a section
    // called MCP beside them would read as the same thing from the other side.
    label: "MCP access",
    caption: "Tokens that let an outside harness drive this Workspace",
    group: "Extensions",
    icon: Blocks,
  },
  {
    id: "appearance",
    label: "Appearance",
    caption: "Light, dark, or whatever this machine is set to",
    group: "Interface",
    icon: SunMoon,
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
