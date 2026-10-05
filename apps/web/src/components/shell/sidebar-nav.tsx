"use client";

import { useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronsUpDown, LogOut, type LucideIcon, Settings } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Fragment, type ReactNode, Suspense, useCallback, useEffect, useRef } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { signOut } from "@/lib/auth-client";
import {
  PROJECT_SECTIONS,
  projectSectionHref,
  SETTINGS_GROUPS,
  settingsHref,
  settingsSectionFor,
  settingsSectionsIn,
  WORKSPACE_SECTIONS,
  workflowIdFromPath,
} from "@/lib/navigation";
import { STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { useWorkspaceEvents } from "@/lib/workspace-events";
import { trpc } from "@/trpc/react";
import { SidebarHideButton, useSidebar } from "./sidebar";
import { type Place, usePlace } from "./use-place";

/** How many recently opened Tasks the sidebar keeps in view. */
const RECENT_LIMIT = 5;

const PROJECTS = WORKSPACE_SECTIONS.find((s) => s.href === "/projects");

/**
 * The brand mark: a control barrier with its arm raised. Two uprights and a crossbar was the
 * obvious "gate", but at 16px it just reads as the letter H — the shape has to survive being
 * tiny in the corner of the sidebar, which is the only place it ever appears.
 */
function Mark() {
  return (
    <span
      className="flex size-6 shrink-0 items-center justify-center rounded-md bg-primary/12 text-primary ring-1 ring-primary/25 ring-inset"
      aria-hidden
    >
      <svg viewBox="0 0 20 20" className="size-3.5" fill="none">
        <title>SoloW</title>
        {/* The post, and the arm lifted to let one thing through. */}
        <path d="M5 3.5v13" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" />
        <path
          d="M6.5 12.5 17 6"
          stroke="currentColor"
          strokeWidth="2.25"
          strokeLinecap="round"
          opacity="0.85"
        />
        <circle cx="5" cy="10" r="1.15" fill="currentColor" />
      </svg>
    </span>
  );
}

function GroupLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-1 font-medium text-2xs text-muted-foreground-subtle uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

/**
 * One row. Every destination in the sidebar is drawn by this, so "where am I" always looks the
 * same: a filled row and `aria-current`, never a colour on one list and a bar on another.
 */
function NavItem({
  href,
  label,
  icon: Icon,
  leading,
  active,
  open = false,
  depth = 0,
  trailing,
  title,
}: {
  href: string;
  label: string;
  icon?: LucideIcon | undefined;
  /** Drawn in place of an icon — a Project's initial, a Task's state glyph. */
  leading?: ReactNode;
  active: boolean;
  /**
   * A parent whose child is the current page: named in full strength but not filled, so exactly
   * one row in the sidebar is ever filled.
   */
  open?: boolean;
  /** 1 for a row nested under another. */
  depth?: 0 | 1;
  trailing?: ReactNode;
  title?: string | undefined;
}) {
  return (
    <li>
      <Link
        href={href}
        title={title}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 items-center gap-2.5 rounded-md pr-2 text-sm transition-colors",
          depth === 1 ? "pl-7" : "pl-2",
          active
            ? "bg-sidebar-accent font-medium text-foreground"
            : open
              ? "font-medium text-foreground hover:bg-sidebar-accent/50"
              : "text-foreground/75 hover:bg-sidebar-accent/50 hover:text-foreground",
        )}
      >
        {Icon ? <Icon aria-hidden strokeWidth={2} className="size-3.5 shrink-0" /> : leading}
        <span className="min-w-0 flex-1 truncate">{label}</span>
        {trailing}
      </Link>
    </li>
  );
}

function Count({ value }: { value: number }) {
  return <span className="font-mono text-muted-foreground text-xs tabular-nums">{value}</span>;
}

/**
 * Tasks waiting on your review, in the review colour — the one count in the sidebar that is asking
 * for something. The number is hidden from screen readers and said in words instead, because a
 * bare "2" folded into a link's name ("Board 2") says nothing about what is waiting.
 */
function ReviewCount({ value }: { value: number }) {
  return (
    <span className="flex shrink-0 items-center gap-1 font-medium font-mono text-state-review text-xs tabular-nums">
      <span aria-hidden className="size-1.5 rounded-full bg-current" />
      <span aria-hidden>{value}</span>
      <span className="sr-only">, {value === 1 ? "1 task" : `${value} tasks`} awaiting review</span>
    </span>
  );
}

function Wip() {
  return (
    <span
      // The row's own name already says "(work in progress)" to a screen reader via `title`.
      aria-hidden
      className="shrink-0 rounded border px-1 text-[9px] text-muted-foreground uppercase leading-[1.5]"
    >
      WIP
    </span>
  );
}

/** A Project's initial in a tinted square: tells two Projects apart before their names are read. */
function ProjectGlyph({ title, active }: { title: string; active: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-[4px] font-semibold text-[9px] uppercase",
        active ? "bg-primary/20 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {title.trim().charAt(0) || "·"}
    </span>
  );
}

/**
 * The Workspace's name, and the account-level actions that used to sit as loose icons at the foot
 * of the rail: the Workspace's own settings, and signing out. Signing out is only offered with a
 * real session — under the local dev-owner stand-in there is nothing to sign out of.
 */
function WorkspaceMenu({ workspaceName, signedIn }: { workspaceName: string; signedIn: boolean }) {
  const router = useRouter();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`${workspaceName} — workspace menu`}
        className="flex h-11 w-full shrink-0 items-center gap-2 border-b px-3 text-left transition-colors hover:bg-sidebar-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset data-[state=open]:bg-sidebar-accent/60"
      >
        <Mark />
        <span className="min-w-0 flex-1 truncate font-semibold text-sm">{workspaceName}</span>
        <ChevronsUpDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuLabel className="truncate text-muted-foreground text-xs">
          {workspaceName}
        </DropdownMenuLabel>
        <DropdownMenuItem onSelect={() => router.push(settingsHref("workspace"))}>
          <Settings aria-hidden />
          Workspace settings
        </DropdownMenuItem>
        {signedIn && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={async () => {
                await signOut();
                router.replace("/sign-in");
                router.refresh();
              }}
            >
              <LogOut aria-hidden />
              Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Every Project, with the open one's sections nested under it.
 *
 * This is what the Project switcher used to be — a popover behind the navigator's title — laid
 * out flat, because a list of a handful of names is cheaper to read than to search. Picking
 * another Project keeps the section you are in, so going from one board to the next is one
 * click; from a page that is not a section (a Task) it opens the Project's overview.
 */
function ProjectsGroup({ place }: { place: Place }) {
  const projects = trpc.project.list.useQuery({});
  const counts = trpc.workspace.counts.useQuery();
  const list = projects.data ?? [];
  const review = new Map(counts.data?.reviewByProject.map((r) => [r.projectId, r.tasks]));
  const keepSection = place.projectSection && !place.taskId && !place.issueId;
  const sectionPath = keepSection ? (place.projectSection?.path ?? "") : "";

  return (
    <nav aria-label="Projects">
      <GroupLabel>Projects</GroupLabel>
      <ul className="space-y-px px-2">
        <NavItem
          href="/projects"
          label="All projects"
          icon={PROJECTS?.icon}
          active={place.pathname === "/projects"}
        />
        {list.map((project) => {
          const open = project.id === place.projectId;
          return (
            <ProjectRow
              key={project.id}
              id={project.id}
              title={project.title}
              open={open}
              href={projectSectionHref(project.id, sectionPath)}
              place={place}
              awaitingReview={review.get(project.id) ?? 0}
            />
          );
        })}
      </ul>
    </nav>
  );
}

function ProjectRow({
  id,
  title,
  open,
  href,
  place,
  awaitingReview,
}: {
  id: string;
  title: string;
  open: boolean;
  href: string;
  place: Place;
  awaitingReview: number;
}) {
  // On the Project while it is folded; on its Board once open, which is where the Tasks are —
  // never both, so one review is not counted twice on screen.
  const badge = awaitingReview > 0 ? <ReviewCount value={awaitingReview} /> : undefined;
  return (
    <>
      <NavItem
        href={open ? projectSectionHref(id, "") : href}
        label={title}
        leading={<ProjectGlyph title={title} active={open} />}
        active={false}
        open={open}
        title={title}
        trailing={open ? undefined : badge}
      />
      {open && (
        <li>
          <ul aria-label={`${title} sections`} className="space-y-px">
            {PROJECT_SECTIONS.map((s) => (
              <NavItem
                key={s.path || "overview"}
                href={projectSectionHref(id, s.path)}
                label={s.label}
                icon={s.icon}
                depth={1}
                active={place.projectSection?.path === s.path}
                trailing={s.wip ? <Wip /> : s.path === "/board" ? badge : undefined}
              />
            ))}
          </ul>
        </li>
      )}
    </>
  );
}

/** The Workspace-wide destinations: Unassigned, Workflows (with its pipelines while open), History. */
function WorkspaceGroup({ place }: { place: Place }) {
  const counts = trpc.workspace.counts.useQuery();
  const unassignedCount = counts.data?.unassignedIssues ?? 0;
  const rows = WORKSPACE_SECTIONS.filter((s) => s.href !== "/projects" && s.href !== "/settings");

  return (
    <nav aria-label="Workspace">
      <GroupLabel>Workspace</GroupLabel>
      <ul className="space-y-px px-2">
        {rows.map((s) => {
          const here = place.section?.href === s.href;
          const nests = s.href === "/workflows" && here;
          return (
            <Fragment key={s.href}>
              <NavItem
                href={s.href}
                label={s.label}
                icon={s.icon}
                active={here && !nests}
                open={nests}
                title={s.wip ? `${s.label} (work in progress)` : undefined}
                trailing={
                  s.wip ? (
                    <Wip />
                  ) : s.href === "/unassigned" && unassignedCount > 0 ? (
                    <Count value={unassignedCount} />
                  ) : undefined
                }
              />
              {nests && <WorkflowList pathname={place.pathname} />}
            </Fragment>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The pipelines, nested under Workflows while it is open — the same shape as a Project's sections,
 * so the sidebar has one way of saying "inside this".
 *
 * Creating, importing and deleting moved out to the page header and the inspector: the sidebar is
 * for going places, and a create form in it was the reason it read differently on this one route.
 */
function WorkflowList({ pathname }: { pathname: string }) {
  const workflows = trpc.workflow.list.useQuery({});
  const list = workflows.data ?? [];
  // `/workflows` alone opens the first pipeline (see `WorkflowsView`), so that is the one lit.
  const current = workflowIdFromPath(pathname) ?? list[0]?.id ?? null;
  if (list.length === 0) return null;
  return (
    <li>
      <ul aria-label="Workflows" className="space-y-px">
        {list.map((w) => (
          <NavItem
            key={w.id}
            href={`/workflows/${w.id}`}
            label={w.name}
            depth={1}
            active={w.id === current}
            title={`${w.name} · ${w.stepCount === 1 ? "1 step" : `${w.stepCount} steps`}`}
          />
        ))}
      </ul>
    </li>
  );
}

function RecentTasks({ excludeTaskId }: { excludeTaskId: string | null }) {
  const recents = trpc.preference.getRecentTasks.useQuery({});
  const ids = (recents.data?.taskIds ?? [])
    .filter((id) => id !== excludeTaskId)
    .slice(0, RECENT_LIMIT);
  if (ids.length === 0) return null;
  return (
    <nav aria-label="Recent tasks">
      <GroupLabel>Recent</GroupLabel>
      <ul className="space-y-px px-2">
        {ids.map((id) => (
          <RecentTaskRow key={id} taskId={id} />
        ))}
      </ul>
    </nav>
  );
}

/**
 * One recalled Task, by itself: title, and the same lifecycle glyph and colour the board and the
 * state badge already use for it — the point of the list is to say "here is one waiting on you"
 * as readily as "here is one you were just in", and a bare title cannot say which.
 *
 * A dangling id — the Task was deleted since it was recorded — renders nothing rather than a
 * broken row; it ages out of the stored list on its own the next time five newer Tasks are
 * visited.
 */
function RecentTaskRow({ taskId }: { taskId: string }) {
  const task = trpc.task.get.useQuery({ id: taskId });
  if (!task.data) return null;
  const t = task.data;
  const style = STATE_STYLE[t.state];
  return (
    <NavItem
      href={`/task/${t.id}`}
      label={t.title}
      title={t.title}
      active={false}
      leading={
        <style.icon
          aria-hidden
          strokeWidth={2}
          className={cn("size-3.5 shrink-0", style.textClassName)}
        />
      }
    />
  );
}

/**
 * Settings takes the whole sidebar over while it is open, with a way back to where you were.
 *
 * Its sixteen sections would otherwise either push the app's own destinations off screen or sit
 * under them where nobody scrolls; and Settings is a place you visit and leave, so trading the
 * app's list for its own while you are in it costs nothing you were using.
 */
function SettingsNav() {
  const params = useSearchParams();
  const handle = useSidebar();
  const active = settingsSectionFor(params.get("section"));

  return (
    <nav aria-label="Settings sections" className="pb-3">
      <div className="px-2 pt-2">
        <Link
          href={handle?.lastAppPath ?? "/projects"}
          className="flex h-7 items-center gap-2 rounded-md px-2 text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
        >
          <ArrowLeft aria-hidden className="size-3.5 shrink-0" />
          Back to app
        </Link>
      </div>
      {SETTINGS_GROUPS.map(({ name }) => (
        <div key={name}>
          <GroupLabel>{name}</GroupLabel>
          <ul className="space-y-px px-2">
            {settingsSectionsIn(name).map((s) => (
              <NavItem
                key={s.id}
                href={settingsHref(s.id)}
                label={s.label}
                icon={s.icon}
                active={s.id === active.id}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * Record a Task as visited, once per Task rather than once per render.
 *
 * `recordedTaskId` is the guard, not `taskId` alone: the mutation object tRPC hands back is a new
 * value on every render (React Query's own contract), so keying the effect on it as well would
 * fire a write on every re-render, not once per navigation.
 */
function useRecordVisit(taskId: string | null) {
  const utils = trpc.useUtils();
  const recordVisit = trpc.preference.recordRecentTask.useMutation({
    onSuccess: () => utils.preference.getRecentTasks.invalidate(),
  });
  const recordedTaskId = useRef<string | null>(null);
  useEffect(() => {
    if (!taskId || recordedTaskId.current === taskId) return;
    recordedTaskId.current = taskId;
    recordVisit.mutate({ taskId });
  }, [taskId, recordVisit.mutate]);
}

/**
 * Keep the sidebar's counts current without polling.
 *
 * They change for two kinds of reason, and each has a signal already: work done elsewhere arrives
 * on the Workspace socket (a mirror pass that wrote Issues, a Task changing state), and work done
 * here is a mutation finishing in this tab. Either one re-reads `workspace.counts` — a single
 * `count()` query, cheap enough not to work out which mutations could have moved it.
 */
function useLiveCounts() {
  const utils = trpc.useUtils();
  const queryClient = useQueryClient();

  const onEvent = useCallback(
    (event: { kind: string; scope?: string }) => {
      if (event.kind === "status" || (event.kind === "mirror" && event.scope === "issues")) {
        void utils.workspace.counts.invalidate();
      }
    },
    [utils],
  );
  useWorkspaceEvents(onEvent);

  useEffect(
    () =>
      queryClient.getMutationCache().subscribe((event) => {
        if (event.type === "updated" && event.action.type === "success") {
          void utils.workspace.counts.invalidate();
        }
      }),
    [queryClient, utils],
  );
}

export function SidebarNav({
  workspaceName,
  signedIn,
}: {
  workspaceName: string;
  signedIn: boolean;
}) {
  const place = usePlace();
  const inSettings = place.section?.href === "/settings";
  useRecordVisit(place.taskId);
  useLiveCounts();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <WorkspaceMenu workspaceName={workspaceName} signedIn={signedIn} />
      <ScrollArea className="min-h-0 flex-1">
        {inSettings ? (
          <Suspense fallback={null}>
            <SettingsNav />
          </Suspense>
        ) : (
          <div className="pb-3">
            <ProjectsGroup place={place} />
            <WorkspaceGroup place={place} />
            <RecentTasks excludeTaskId={place.taskId} />
          </div>
        )}
      </ScrollArea>
      <div className="flex shrink-0 items-center gap-1 border-t px-2 py-1.5">
        {inSettings ? (
          <span className="flex-1" />
        ) : (
          <ul className="min-w-0 flex-1">
            <NavItem href="/settings" label="Settings" icon={Settings} active={false} />
          </ul>
        )}
        <SidebarHideButton />
      </div>
    </div>
  );
}
