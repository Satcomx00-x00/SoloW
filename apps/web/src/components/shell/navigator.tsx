"use client";

import type { IssueStatus, TaskState } from "@solow/contracts";
import { Plus, Store, Trash2, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { WorkflowStoreDialog } from "@/components/features/workflows/workflow-store-dialog";
import { ImportWorkflowDialog } from "@/components/features/workflows/workflow-transfer";
import { Button } from "@/components/ui/button";
import { CreateDisclosure } from "@/components/ui/create-disclosure";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE, ISSUE_STATUSES } from "@/lib/issue-status";
import {
  PROJECT_SECTIONS,
  projectIdFromPath,
  projectSectionFor,
  projectSectionHref,
  SETTINGS_GROUPS,
  sectionFor,
  settingsHref,
  settingsSectionFor,
  settingsSectionsIn,
  taskIdFromPath,
  workflowIdFromPath,
} from "@/lib/navigation";
import { WHOLE_PAGE } from "@/lib/paged";
import { taskActionMessage } from "@/lib/task-errors";
import { BOARD_COLUMNS, STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { TaskNav } from "./task-nav";

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-2 font-medium text-2xs text-muted-foreground/70 uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

/**
 * A stacked bar of every state, proportional to how many rows are in it.
 *
 * The rows below give exact counts; this gives the shape — whether work is piling up in review
 * or everything is still sitting in the backlog — in one glance and without reading a number.
 * Hidden entirely when there is nothing to describe.
 */
function DistributionBar({
  segments,
  total,
}: {
  segments: Array<{ key: string; count: number; className: string }>;
  total: number;
}) {
  if (total === 0) return null;
  return (
    <div
      className="mx-3 mb-1 flex h-1.5 gap-px overflow-hidden rounded-full bg-muted/60"
      aria-hidden
    >
      {segments
        .filter((s) => s.count > 0)
        .map((s) => (
          <span
            key={s.key}
            className={cn("h-full", s.className)}
            style={{ width: `${(s.count / total) * 100}%` }}
          />
        ))}
    </div>
  );
}

/** One counted row: glyph, name, tally. Dimmed to near-silence when the count is zero. */
function CountRow({
  icon: Icon,
  label,
  count,
  tone,
  hint,
  href,
}: {
  icon: React.ComponentType<{ className?: string; strokeWidth?: number; "aria-hidden"?: boolean }>;
  label: string;
  count: number;
  tone: string;
  hint?: string;
  href?: string | undefined;
}) {
  const empty = count === 0;
  const body = (
    <>
      <Icon
        aria-hidden
        strokeWidth={2}
        className={cn("size-3.5 shrink-0", empty ? "text-current" : tone)}
      />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className={cn("font-mono text-xs tabular-nums", empty && "opacity-60")}>{count}</span>
    </>
  );
  const className = cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
    empty ? "text-muted-foreground/45" : "text-foreground/85 hover:bg-sidebar-accent/50",
  );
  return (
    <li>
      {href ? (
        <Link href={href} title={hint} className={className}>
          {body}
        </Link>
      ) : (
        <div title={hint} className={className}>
          {body}
        </div>
      )}
    </li>
  );
}

/**
 * Board context: live per-state task counts, for the Project the board is inside.
 *
 * Every row is a link, unlike before — this was the one counted list in the app whose rows did
 * not act on a click, next to Issues' identical shape where every row filters. A column here is
 * never hidden or reordered, so "filter" would only narrow to what is already the whole board;
 * what a click can usefully do is bring a column back into view on a lifecycle strip wide enough
 * to scroll off-screen. See the effect in `board.tsx` that reads `?column=`.
 */
function BoardNav({ projectId }: { projectId?: string | undefined }) {
  const tasks = trpc.task.list.useQuery(projectId ? { ...WHOLE_PAGE, projectId } : WHOLE_PAGE);
  const rows = tasks.data?.items ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, t) => {
    acc[t.state] = (acc[t.state] ?? 0) + 1;
    return acc;
  }, {});
  const boardHref = projectId ? projectSectionHref(projectId, "/board") : null;

  return (
    <nav className="pb-3" aria-label="Board lifecycle">
      <SectionLabel>Lifecycle</SectionLabel>
      <DistributionBar
        total={rows.length}
        segments={BOARD_COLUMNS.map((state) => ({
          key: state,
          count: counts[state] ?? 0,
          className: STATE_STYLE[state].barClassName,
        }))}
      />
      <ul className="space-y-px px-2 pt-2">
        {BOARD_COLUMNS.map((state: TaskState) => (
          <CountRow
            key={state}
            icon={STATE_STYLE[state].icon}
            label={STATE_LABELS[state]}
            count={counts[state] ?? 0}
            tone={STATE_STYLE[state].textClassName}
            hint={STATE_STYLE[state].hint}
            href={boardHref ? `${boardHref}?column=${state}` : undefined}
          />
        ))}
      </ul>
    </nav>
  );
}

/** Issues context: counts per status, each row filtering the list. */
function IssuesNav({
  projectId,
  unassigned,
}: {
  projectId?: string | undefined;
  unassigned?: boolean | undefined;
}) {
  const issues = trpc.issue.list.useQuery({
    ...WHOLE_PAGE,
    ...(projectId ? { projectId } : {}),
    ...(unassigned ? { unassigned: true } : {}),
  });
  const rows = issues.data?.items ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});
  const base = projectId ? projectSectionHref(projectId, "/issues") : "/unassigned";

  return (
    <nav className="pb-3" aria-label="Issue statuses">
      <SectionLabel>Status</SectionLabel>
      <DistributionBar
        total={rows.length}
        segments={ISSUE_STATUSES.map((status) => ({
          key: status,
          count: counts[status] ?? 0,
          className: ISSUE_STATUS_STYLE[status].text.replace("text-", "bg-"),
        }))}
      />
      <ul className="space-y-px px-2 pt-2">
        {/* Every link stays inside the surface it was opened from: a status row on a Project's
            issue list must not jump to a Workspace-wide one, or the filter would silently widen
            the set it was narrowing. */}
        <CountRow
          icon={AllIcon}
          label="All issues"
          count={rows.length}
          tone="text-foreground/70"
          href={base}
        />
        {ISSUE_STATUSES.map((status: IssueStatus) => (
          <CountRow
            key={status}
            icon={ISSUE_STATUS_STYLE[status].icon}
            label={ISSUE_STATUS_LABELS[status]}
            count={counts[status] ?? 0}
            tone={ISSUE_STATUS_STYLE[status].text}
            href={`${base}?status=${status}`}
          />
        ))}
      </ul>
    </nav>
  );
}

/** A neutral glyph for the unfiltered row, so it does not borrow a status's colour. */
function AllIcon({ className, strokeWidth }: { className?: string; strokeWidth?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      strokeWidth={strokeWidth}
      aria-hidden
    >
      <title>All</title>
      <path
        d="M4 6h16M4 12h16M4 18h10"
        stroke="currentColor"
        strokeWidth={strokeWidth ?? 2}
        strokeLinecap="round"
      />
    </svg>
  );
}

/**
 * Workflows context: the pipelines this Workspace has, and the one control that makes another.
 *
 * The list and the `New workflow` field used to be a 16rem column *inside* the page, beside the
 * canvas. That is the primary sidebar's job — it is the same shape as the Project section list
 * above it and the Settings list below — and having it in the page meant the canvas started a
 * third of the way across a screen that also had a sidebar on it.
 *
 * Each row is a `Link`, not a button: the selection belongs in the URL (`workflowIdFromPath`), so
 * a pipeline can be linked to, reopened by a reload, and read by the secondary sidebar without
 * this component having to tell it.
 *
 * The create field used to sit above the list, permanently expanded — the same inversion Settings
 * was built to fix: the first thing on screen was a blank field for a pipeline that did not exist
 * yet, while the pipelines you already had were pushed underneath it. `CreateDisclosure` puts the
 * list first and folds the field behind one button, open by default only while there is nothing
 * to list.
 */
function WorkflowsNav() {
  const pathname = usePathname();
  const router = useRouter();
  const utils = trpc.useUtils();
  const workflows = trpc.workflow.list.useQuery({});
  const [name, setName] = useState("");
  const active = workflowIdFromPath(pathname);

  const create = trpc.workflow.create.useMutation({
    onSuccess: (created) => {
      utils.workflow.list.invalidate();
      setName("");
      // Straight onto the new pipeline: it is empty, and the next thing anyone does is add a
      // Step to it — which happens on the canvas.
      router.push(`/workflows/${created.id}`);
    },
  });
  const remove = trpc.workflow.delete.useMutation({
    onSuccess: (_result, deleted) => {
      utils.workflow.list.invalidate();
      if (deleted.id === active) router.push("/workflows");
    },
  });

  const list = workflows.data ?? [];
  // The flag being off is the page's story to tell, in full, with the command that turns it on.
  // The sidebar just has nothing to list.
  const failed = workflows.error !== null;

  return (
    <div className="pb-3">
      <nav aria-label="Workflows">
        <SectionLabel>Pipelines</SectionLabel>
        <ul className="space-y-px px-2" aria-label="Workflows">
          {list.map((w) => {
            const current = w.id === active;
            return (
              <li key={w.id} className="group/row flex items-center gap-1">
                <Link
                  href={`/workflows/${w.id}`}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "min-w-0 flex-1 rounded-md px-2 py-1.5 transition-colors",
                    current
                      ? "bg-sidebar-accent text-foreground"
                      : "text-foreground/75 hover:bg-sidebar-accent/50 hover:text-foreground",
                  )}
                >
                  <span className={cn("block truncate text-sm", current && "font-medium")}>
                    {w.name}
                  </span>
                  <span className="block text-2xs text-muted-foreground tabular-nums">
                    {w.stepCount === 1 ? "1 step" : `${w.stepCount} steps`} · v{w.version}
                  </span>
                </Link>
                <ConfirmAction
                  title={`Delete “${w.name}”?`}
                  description="Its steps go with it. Refused while a task is still on it; finished tasks are simply unbound."
                  confirmLabel="Delete workflow"
                  onConfirm={() => remove.mutate({ id: w.id })}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete ${w.name}`}
                      // Revealed on hover or on focus, never on neither: a delete button beside
                      // every row is a permanent invitation, and one that only appears on hover
                      // is unreachable from the keyboard.
                      className="opacity-0 transition-opacity focus-visible:opacity-100 group-hover/row:opacity-100"
                    >
                      <Trash2 aria-hidden />
                    </Button>
                  }
                />
              </li>
            );
          })}
        </ul>
        {!workflows.isLoading && !failed && list.length === 0 && (
          <p className="px-3 pt-1 text-muted-foreground text-xs leading-relaxed">
            None yet. A workflow chains harnesses: one plans, another implements, a third reviews.
          </p>
        )}
        {remove.error && (
          <p className="px-3 pt-1 text-2xs text-state-failed" role="alert">
            {taskActionMessage(remove.error.message)}
          </p>
        )}
      </nav>

      <div className="px-2">
        <CreateDisclosure
          defaultOpen={!workflows.isLoading && list.length === 0}
          label="New workflow"
        >
          <form
            className="space-y-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              create.mutate({ name });
            }}
          >
            <Label htmlFor="new-workflow-name" className="sr-only">
              Workflow name
            </Label>
            <Input
              className="h-8 text-xs"
              disabled={failed}
              id="new-workflow-name"
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Plan, build, review"
              required
              value={name}
            />
            <Button
              className="w-full"
              disabled={!name || failed || create.isPending}
              size="sm"
              type="submit"
            >
              <Plus aria-hidden />
              Create
            </Button>
            {create.error && (
              <p className="font-mono text-2xs text-state-failed" role="alert">
                {create.error.message}
              </p>
            )}
          </form>
          {/* The other way a pipeline comes into being: someone else's, as a file. It sits under
              the create form rather than beside the list because importing *is* creating one. */}
          <ImportWorkflowDialog
            trigger={
              <Button
                className="w-full"
                disabled={failed}
                size="sm"
                type="button"
                variant="outline"
              >
                <Upload aria-hidden />
                Import from file
              </Button>
            }
          />
          {/* And the third: a ready-made one from the catalog, which is also how Spec Kit,
              Superpowers and OpenSpec arrive as pipelines. */}
          <WorkflowStoreDialog
            installed={list}
            trigger={
              <Button
                className="w-full"
                disabled={failed}
                size="sm"
                type="button"
                variant="outline"
              >
                <Store aria-hidden />
                Browse the store
              </Button>
            }
          />
        </CreateDisclosure>
      </div>
    </div>
  );
}

/**
 * Settings context: every configuration section, grouped, with the current one marked.
 *
 * It used to be four hard-coded anchors — a second, shorter opinion about what Settings contains
 * than the page itself held. Five sections had no entry at all, including the two the command
 * palette links straight to, so the only way to reach Feature flags or MCP was to know they were
 * somewhere down the scroll. The list is `SETTINGS_SECTIONS` now, which is the same list the page
 * renders from, and the two cannot disagree again.
 *
 * Marking the current row is the other half. The page shows one group at a time, so without it
 * the sidebar would be the only thing on screen that could say where you are, and it did not.
 */
function SettingsNav() {
  const params = useSearchParams();
  const active = settingsSectionFor(params.get("section"));

  return (
    <nav className="pb-3" aria-label="Settings sections">
      {SETTINGS_GROUPS.map(({ name }) => (
        <div key={name}>
          <SectionLabel>{name}</SectionLabel>
          <ul className="space-y-px px-2">
            {settingsSectionsIn(name).map((s) => {
              const current = s.id === active.id;
              return (
                <li key={s.id}>
                  <Link
                    href={settingsHref(s.id)}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                      current
                        ? "bg-sidebar-accent font-medium text-foreground"
                        : "text-foreground/75 hover:bg-sidebar-accent/50 hover:text-foreground",
                    )}
                  >
                    <s.icon aria-hidden strokeWidth={2} className="size-3.5 shrink-0" />
                    <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

/**
 * The Project switcher, and the sections inside the Project it names.
 *
 * At the very top of the sidebar, because that is where the top of the hierarchy belongs. It used
 * to sit in a toolbar above the project *table*, which said a Project was a property of that one
 * screen — when the board, the issue list and the workflows are equally inside it. Switching here
 * keeps you on the same section of the new Project rather than dumping you on its overview, which
 * is what someone comparing two projects' boards actually wants.
 */
function ProjectNav({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const projects = trpc.project.list.useQuery({});
  const active = projectSectionFor(pathname);

  return (
    <>
      <div className="px-2 pt-2.5">
        <Select
          value={projectId}
          onValueChange={(id) => router.push(projectSectionHref(id, active?.path ?? ""))}
        >
          <SelectTrigger className="h-8 w-full text-xs" aria-label="Project">
            <SelectValue placeholder="Project" />
          </SelectTrigger>
          <SelectContent>
            {(projects.data ?? []).map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <nav aria-label="Project sections">
        <SectionLabel>In this project</SectionLabel>
        <ul className="space-y-px px-2">
          {PROJECT_SECTIONS.map((s) => {
            const href = projectSectionHref(projectId, s.path);
            const current = active?.path === s.path;
            return (
              <li key={s.path || "overview"}>
                <Link
                  href={href}
                  aria-current={current ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                    current
                      ? "bg-sidebar-accent font-medium text-foreground"
                      : "text-foreground/75 hover:bg-sidebar-accent/50 hover:text-foreground",
                  )}
                >
                  <s.icon aria-hidden strokeWidth={2} className="size-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{s.label}</span>
                  {s.wip && (
                    // Said in the row rather than only as a colour, so it survives a screen
                    // reader — the section is live but not finished (F03).
                    <span className="shrink-0 rounded border px-1 text-[9px] text-muted-foreground uppercase">
                      WIP
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}

/**
 * The last few Tasks you were on, most recent first (spec F03 follow-on).
 *
 * A Task page has nothing that plays this role. The board and the issue list both leave it the
 * moment you navigate away, so a Task left five minutes ago — to check an Issue, glance at
 * Settings, or open a second Task — was otherwise gone until you re-found it by hand, the one
 * structural gap none of the other sidebar variants have: every one of them is *some* list you
 * can always get back to, and a Task is the one navigable thing in the app that is not on one.
 *
 * Server-persisted (`preference.getRecentTasks`, the same `ui_preference` mechanism the task
 * pane's saved width uses) rather than kept in `localStorage`, so it survives a cleared cache and
 * reads the same on another device signed into the same account.
 *
 * Shown above whatever the route's own content is, on every screen — not filed under Tasks or
 * the board, because leaving a Task is exactly the moment you are looking at something else.
 * Absent entirely once there is nothing to recall, and the Task you are *currently* on is
 * filtered out: linking to where you already are is not a memory aid.
 */
function RecentTasksNav({ excludeTaskId }: { excludeTaskId: string | null }) {
  const recents = trpc.preference.getRecentTasks.useQuery({});
  const ids = (recents.data?.taskIds ?? []).filter((id) => id !== excludeTaskId);
  if (ids.length === 0) return null;
  return (
    <nav aria-label="Recent tasks">
      <SectionLabel>Recent</SectionLabel>
      <ul className="space-y-px px-2 pb-1">
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
 * visited; the DAL that returns it is undisturbed either way.
 */
function RecentTaskRow({ taskId }: { taskId: string }) {
  const task = trpc.task.get.useQuery({ id: taskId });
  if (!task.data) return null;
  const t = task.data;
  const style = STATE_STYLE[t.state];
  return (
    <li>
      <Link
        href={`/task/${t.id}`}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-foreground/75 text-sm transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
      >
        <style.icon
          aria-hidden
          strokeWidth={2}
          className={cn("size-3.5 shrink-0", style.textClassName)}
        />
        <span className="min-w-0 flex-1 truncate">{t.title}</span>
      </Link>
    </li>
  );
}

/** VS-Code-style navigator: the context panel next to the activity bar. */
export function Navigator({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const projectId = projectIdFromPath(pathname);
  const taskId = taskIdFromPath(pathname);
  const projectSection = projectSectionFor(pathname);
  const section = sectionFor(pathname);
  const isSettings = section?.href === "/settings";
  const isUnassigned = section?.href === "/unassigned";
  const isWorkflows = section?.href === "/workflows";

  // The Project's name is the sidebar's title when you are inside one: the Workspace is already
  // named in the breadcrumb, and repeating it here would spend the most prominent line in the
  // sidebar on the thing you are least often choosing between.
  const project = trpc.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );

  // A Task page is titled by the Task: its route is flat, so nothing else on the sidebar could
  // say which one is open.
  const task = trpc.task.get.useQuery({ id: taskId ?? "" }, { enabled: taskId !== null });

  /**
   * Record this Task as visited, once per Task rather than once per render.
   *
   * `recordedTaskId` is the guard, not `taskId` alone: the mutation object tRPC hands back is a
   * new value on every render (React Query's own contract), so keying the effect on it as well
   * would fire a write on every keystroke of a component two levels up re-rendering, not once per
   * navigation. The ref remembers what was last recorded across those renders; only a genuine
   * change of Task clears it.
   */
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

  const title = taskId
    ? (task.data?.title ?? "Task")
    : projectId
      ? (project.data?.title ?? "Project")
      : (section?.label ?? workspaceName);
  const caption = taskId
    ? "Task"
    : projectId
      ? (projectSection?.caption ?? "Project")
      : (section?.caption ?? "Workspace");

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-11 shrink-0 flex-col justify-center border-b px-3">
        <span className="truncate font-semibold text-sm leading-tight">{title}</span>
        <span className="truncate text-muted-foreground text-xs leading-tight">{caption}</span>
      </div>
      <ScrollArea className="flex-1">
        <RecentTasksNav excludeTaskId={taskId} />
        {taskId ? (
          <TaskNav taskId={taskId} />
        ) : projectId ? (
          <>
            <ProjectNav projectId={projectId} />
            {/*
              The counts *below* the section list, never instead of it.

              A sidebar that swapped its whole body per section made the Project's other sections
              disappear the moment you entered one — you could reach a board and then had no way
              back to the table except the breadcrumb. The sections stay put; the counts are extra
              detail for the section you are actually in.
            */}
            {projectSection?.path === "/board" && <BoardNav projectId={projectId} />}
            {projectSection?.path === "/issues" && <IssuesNav projectId={projectId} />}
          </>
        ) : isSettings ? (
          // `useSearchParams` inside `SettingsNav` needs a boundary above it, and this is the
          // narrowest place to put one — the rest of the shell stays statically renderable.
          <Suspense fallback={null}>
            <SettingsNav />
          </Suspense>
        ) : isWorkflows ? (
          <WorkflowsNav />
        ) : isUnassigned ? (
          <IssuesNav unassigned />
        ) : null}
      </ScrollArea>
    </aside>
  );
}
