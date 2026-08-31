"use client";

import type {
  ProjectFieldDto,
  ProjectFieldValue,
  ProjectFilter,
  ProjectViewConfig,
} from "@solow/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG, PROJECT_TITLE_KEY } from "@solow/contracts";
import {
  FILTER_ME,
  formatProjectFilter,
  isPriorityFieldName,
  normaliseFilterKey,
  parseProjectFilter,
  priorityFromLabel,
  priorityFromLabels,
  withPriorityLabel,
} from "@solow/core";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarRange,
  Columns3,
  FolderGit2,
  FolderSync,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Table2,
  Tags,
  Trash2,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CreateTaskDialog, type TaskPreset } from "@/components/features/board/create-task-dialog";
import { ConfirmAction } from "@/components/features/confirm-action";
import { AdoptProjectDialog } from "@/components/features/project/adopt-project-dialog";
import { IssueLabel } from "@/components/features/project/issue-label";
import { IssuePanel } from "@/components/features/project/issue-panel";
import type { PriorityChoice } from "@/components/features/project/project-cell";
import { ProjectCreateMenu } from "@/components/features/project/project-create-menu";
import { ProjectRepositoriesDialog } from "@/components/features/project/project-repositories-dialog";
import { ProjectRoadmap } from "@/components/features/project/project-roadmap";
import { type ProjectRow, ProjectTable } from "@/components/features/project/project-table";
import {
  applyProjectView,
  cycleSort,
  effectiveHiddenFieldIds,
  type ProjectViewItem,
  sortProjectRows,
} from "@/components/features/project/project-view-model";
import { ProjectViewTabs } from "@/components/features/project/project-view-tabs";
import { useRowRefresh } from "@/components/features/project/row-refresh";
import { summariseRowTasks, tasksByIssue } from "@/components/features/project/row-tasks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { WHOLE_PAGE } from "@/lib/paged";
import { trpc } from "@/trpc/react";

/**
 * The Projects screen (spec F23, issues #126 and #129).
 *
 * Reads come from the mirror; the only provider call on this page is the adopt picker, which
 * asks precisely because there is nothing mirrored yet (F23 NFR-2).
 *
 * The tabs across the top are **saved configurations over one set of rows**. `items` is fetched
 * once for the project and every tab is a filter, a sort and a layout applied to it in memory —
 * so a value edited under `In review` is edited under `Prioritized backlog` too, because there
 * was only ever one row (AC-6).
 *
 * The active view, and any filter typed over it, live in the URL. That is what makes a narrowed
 * tab a thing you can send to someone (AC-7), and it keeps this component free of filter state
 * that could disagree with what the address bar says — the same rule the Issues list follows.
 *
 * The rule that keeps this from becoming a second product: **a planning change starts nothing.**
 * Moving a row to "In progress" does not launch an agent. The Kanban stays what Decision 0006
 * made it — the runtime of agent work — and this decides what to do, not how it runs.
 */

/**
 * The labels this project's rows actually carry, and which of them the filter is narrowed to.
 *
 * Read off the rows rather than off the whole workspace vocabulary: a menu offering four hundred
 * labels from repositories this project never touches is a menu nobody scrolls, and every one of
 * those extra entries would filter to nothing.
 */
export function labelsInRows(rows: readonly ProjectViewItem[]): string[] {
  const seen = new Set<string>();
  for (const entry of rows) for (const label of entry.row.labels) seen.add(label);
  return [...seen].sort((a, b) => a.localeCompare(b));
}

/** The labels a filter is currently narrowed to — the positive `label:` clause, if there is one. */
export function selectedLabels(filter: ProjectFilter): string[] {
  return filter.terms.flatMap((term) =>
    term.kind === "field" && !term.negated && normaliseFilterKey(term.field) === "label"
      ? term.values
      : [],
  );
}

/**
 * The same filter, narrowed to a different set of labels.
 *
 * Written back into the **filter language** rather than kept beside it as a second piece of state:
 * the filter box is the one place a narrowing is written down, it is what the URL carries and what
 * a saved view stores, and a menu with its own hidden selection would disagree with the text the
 * moment somebody edited either one.
 *
 * An empty selection removes the clause instead of writing `label:` with nothing in it — a clause
 * with no values matches no rows, which is the opposite of "no longer filtering by label".
 */
export function withLabels(filter: ProjectFilter, labels: readonly string[]): ProjectFilter {
  const others = filter.terms.filter(
    (term) =>
      !(term.kind === "field" && !term.negated && normaliseFilterKey(term.field) === "label"),
  );
  return {
    terms:
      labels.length === 0
        ? others
        : [...others, { kind: "field", negated: false, field: "label", values: [...labels] }],
  };
}

/**
 * Does this filter ask who the reader is?
 *
 * Asked so the page can *say* that the mapping behind `@me` is missing. Without it the only
 * evidence would be an empty table, which reads as "nothing is assigned to you" — the one wrong
 * conclusion a `My items` tab can lead someone to.
 */
export function filterAsksWhoIAm(filter: ProjectFilter): boolean {
  return filter.terms.some((term) => term.kind === "field" && term.values.includes(FILTER_ME));
}

/** Build the next address from the current one, dropping the params a null clears. */
export function projectHref(
  projectId: string,
  params: URLSearchParams,
  patch: Record<string, string | null>,
): string {
  const next = new URLSearchParams(params.toString());
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) next.delete(key);
    else next.set(key, value);
  }
  const query = next.toString();
  // The Project lives in the path; only the view and its filter ride in the query, so switching
  // tabs never rewrites which Project you are in.
  const base = `/projects/${projectId}`;
  return query ? `${base}?${query}` : base;
}

/**
 * The planning table for one Project.
 *
 * The Project comes from the **route** (`/projects/:id`), not from a `?project=` parameter and
 * not from "the first one in the list". A Project is the top level of the app now, so which one
 * you are in is a fact about the address — which is what makes a link shareable, a reload stable
 * and the back button mean something. The view no longer picks a default: a route with no
 * Project is the Project *list*, and that is a different screen.
 */
export function ProjectView({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const router = useRouter();
  const params = useSearchParams();

  const project = trpc.project.get.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  /*
   * Every row, not the first page.
   *
   * `project.items` pages, and reading one page while answering as though the project had been
   * read is wrong in three places that all look right: the rollup badge, the filter's answer, and
   * the roadmap's bars. `allItems` walks the pages server-side and states when it stopped.
   */
  const items = trpc.project.allItems.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  /**
   * The Issues this table's rows project — scoped to the Project, like everything else on this
   * screen.
   *
   * It used to read the whole Workspace and index it by id, which worked only because a superset
   * contains what you need. Once the list is bounded (issue #82 AC-4) a superset is exactly the
   * wrong thing to ask for: the page would fill with Issues from other projects and the rows here
   * would fall back to "Untitled" for the ones that did not fit.
   */
  const issues = trpc.issue.list.useQuery(
    { ...WHOLE_PAGE, projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  /**
   * The agent runs on this project's Issues (F23 FR-14).
   *
   * Scoped to the project, like everything else on this screen: an unscoped read would put the
   * whole Workspace's Tasks behind a project's rows, and a row would claim a run that belongs to
   * another project's issue.
   */
  const tasks = trpc.task.list.useQuery(
    { ...WHOLE_PAGE, projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  /**
   * Who `@me` is *on this project's provider*.
   *
   * Resolved server-side, per project, because a project belongs to exactly one Integration and
   * that Integration is what decides which login means "me". The SoloW account name that
   * used to be passed here is a different name for the same person — they agree by coincidence
   * or not at all, which made the `My items` tab a tab that matched nothing.
   */
  const me = trpc.identity.forProject.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );
  const views = trpc.project.views.useQuery(
    { projectId: projectId ?? "" },
    { enabled: projectId !== null },
  );

  const go = useCallback(
    (patch: Record<string, string | null>) =>
      router.replace(projectHref(projectId, params, patch), { scroll: false }),
    [projectId, params, router],
  );

  /** The user's column arrangement, shared across projects — see `surfaceKeySchema`. */
  const layout = trpc.preference.getSurfaceLayout.useQuery({ surface: "project-table" });
  /**
   * The providers' label vocabulary, indexed by name.
   *
   * One query for the whole table rather than a colour looked up per row: the vocabulary is a
   * property of the repositories, not of any issue, and it changes far less often than the rows.
   */
  const labelVocabulary = trpc.issue.labelColors.useQuery({});
  const labelColours = useMemo(
    () => Object.fromEntries((labelVocabulary.data ?? []).map((l) => [l.name, l.color])),
    [labelVocabulary.data],
  );
  /**
   * The priority labels these repositories define, most urgent first.
   *
   * Read off the same vocabulary the colours come from, so the menu offers exactly the labels that
   * exist — never a scale invented here that would write a label nobody has defined.
   */
  const priorityChoices: PriorityChoice[] = useMemo(() => {
    const found = (labelVocabulary.data ?? []).flatMap((entry) => {
      const priority = priorityFromLabel(entry.name);
      return priority ? [{ ...priority, color: entry.color }] : [];
    });
    return found.sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label));
  }, [labelVocabulary.data]);

  const refreshRows = useRowRefresh();
  const saveLayout = trpc.preference.setSurfaceLayout.useMutation({
    onSuccess: () => void utils.preference.getSurfaceLayout.invalidate(),
  });

  const onSynced = () => {
    void utils.project.get.invalidate();
    refreshRows();
    // Connecting a repository shows up in Settings and in every repository picker, so the lists
    // that hold it have to be told — a rescan that silently changes another screen is worse than
    // one that changes none.
    void utils.repository.list.invalidate();
  };
  const refresh = trpc.project.refresh.useMutation({ onSuccess: onSynced });
  const rescan = trpc.project.rescan.useMutation({ onSuccess: onSynced });
  /** Whichever of the two last ran — one banner, reporting the pass the operator asked for. */
  const lastPass = rescan.data ?? refresh.data;

  /**
   * Delete the Project itself (user request 2026-08-27) — its rows in SoloW's own database, never
   * its Issues (they become unassigned, same as `ProjectRepositoriesDialog`'s detach) and, for a
   * mirrored Project, never anything on the provider. Navigates back to the hub first: this page
   * is about to describe a Project that no longer exists, so invalidating in place would refetch
   * it into a 404 rather than let the operator leave.
   */
  const deleteProject = trpc.project.delete.useMutation({
    onSuccess: () => {
      router.push("/projects");
      void utils.project.list.invalidate();
    },
  });

  /**
   * Which Issue the side panel is showing, or null for closed.
   *
   * One piece of state rather than an `open` flag beside an id: the two can disagree, and the
   * disagreement renders as an empty panel with no explanation.
   */
  const [panelIssueId, setPanelIssueId] = useState<string | null>(null);
  /**
   * The row a Task is being started on, or null for "no dialog" — one value doing both jobs, for
   * the same reason `panelIssueId` is one: an `open` flag beside a preset can disagree with it,
   * and the disagreement renders as a dialog opened on the wrong Issue.
   *
   * Held in state rather than built inline where the dialog is rendered: `CreateTaskDialog`
   * re-applies its preset whenever the object's identity changes, and this page re-renders every
   * time one of its eight queries settles — a fresh object each render would stamp the row's
   * Issue back over one the operator had since changed in the form.
   */
  const [taskPreset, setTaskPreset] = useState<TaskPreset | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  /**
   * Change a priority by rewriting the **label** that carries it.
   *
   * Read-modify-write over the Issue's labels because that is the shape the write takes: the
   * provider replaces a label set, it does not patch one entry. Every non-priority label is
   * carried through untouched, so setting a priority cannot drop `area/web` on the way past.
   *
   * The answer is re-read rather than patched in: `updateExternalIssue` returns what the provider
   * stored, and that is the only version worth rendering (F23 NFR-7). The Issue list is what the
   * table reads its labels from, so that is what gets invalidated — not the project items, whose
   * field values this write never touched.
   */
  const setPriority = trpc.issue.updateExternal.useMutation({
    onSettled: () => void utils.issue.list.invalidate(),
  });

  const setValue = trpc.project.setValue.useMutation({
    onSettled: (_data, _error, variables) => {
      setPending((p) => p.filter((k) => k !== `${variables.itemId}:${variables.fieldId}`));
      // Re-read rather than patching a local copy: what the provider stored is the only value
      // worth rendering, and it may not be what was sent (F23 NFR-7).
      refreshRows();
    },
  });

  /*
   * The row handlers, held still across renders.
   *
   * The table memoizes each row on its props (issue #126 AC-6), and a handler written inline in
   * the JSX below is a different function on every render — which is every frame of a scroll. The
   * memo would compare four props that always differ and re-render every row on screen anyway,
   * so the windowing above would buy a shorter list and nothing else.
   */
  const editCell = useCallback(
    (row: ProjectRow, field: ProjectFieldDto, value: ProjectFieldValue | null) => {
      if (!projectId) return;
      setPending((p) => [...p, `${row.item.id}:${field.id}`]);
      setValue.mutate({ projectId, itemId: row.item.id, fieldId: field.id, value });
    },
    [projectId, setValue.mutate],
  );
  const openRow = useCallback((row: ProjectRow) => setPanelIssueId(row.item.issueId), []);
  // Right-click → "Start a task on this issue". The dialog opens with the issue already chosen;
  // everything else about the task is still the operator's to fill in. This page mounts that
  // dialog itself (below `IssuePanel`), so the menu item cannot dispatch at nothing — which is
  // what it would have become when the shell-wide create bus it used to send on was deleted.
  // Still a `useCallback` with no dependencies, for the row memo above: `setTaskPreset` is
  // stable, so this handler is held still across renders exactly as before.
  const startTask = useCallback(
    (row: ProjectRow) =>
      setTaskPreset({
        issueId: row.item.issueId,
        ...(row.item.repositoryId ? { repositoryId: row.item.repositoryId } : {}),
      }),
    [],
  );

  const activeView =
    (views.data ?? []).find((v) => v.id === params.get("view")) ?? views.data?.[0] ?? null;
  const activeViewId = activeView?.id ?? null;
  const saved: ProjectViewConfig = activeView?.config ?? DEFAULT_PROJECT_VIEW_CONFIG;

  /**
   * Changes made on screen but not yet saved to the tab.
   *
   * Held apart from the view rather than written straight through, because these tabs are shared:
   * narrowing `In review` to look at one person's work must not re-point the team's tab at them
   * until somebody says Save.
   *
   * The draft carries the id of the tab it was drafted on, so switching tabs drops it without an
   * effect having to notice — a reset that runs a render late is a tab briefly showing the
   * previous tab's grouping.
   */
  const [draft, setDraft] = useState<{ viewId: string | null; config: Partial<ProjectViewConfig> }>(
    { viewId: null, config: {} },
  );
  const drafted = draft.viewId === activeViewId ? draft.config : {};
  const patchDraft = (patch: Partial<ProjectViewConfig>) =>
    setDraft({ viewId: activeViewId, config: { ...drafted, ...patch } });

  const savedText = formatProjectFilter(saved.filter);
  const filterText = params.get("q") ?? savedText;
  const [typed, setTyped] = useState(filterText);
  // The URL is the source of truth, so a filter cleared elsewhere — the back button, a tab
  // switch — has to reach this input too.
  useEffect(() => setTyped(filterText), [filterText]);
  useEffect(() => {
    if (typed === filterText) return;
    // On a pause, not per keystroke: a router replace per character re-runs the parse mid-word
    // and fights the cursor. The same 250ms the Issues search box uses.
    const timer = setTimeout(() => go({ q: typed === savedText ? null : typed }), 250);
    return () => clearTimeout(timer);
  }, [typed, filterText, savedText, go]);

  const config: ProjectViewConfig = useMemo(
    () => ({
      layout: drafted.layout ?? saved.layout,
      filter: parseProjectFilter(filterText),
      groupByFieldId:
        drafted.groupByFieldId === undefined ? saved.groupByFieldId : drafted.groupByFieldId,
      sort: drafted.sort === undefined ? saved.sort : drafted.sort,
      visibleFieldIds:
        drafted.visibleFieldIds === undefined ? saved.visibleFieldIds : drafted.visibleFieldIds,
      hideClosed: drafted.hideClosed ?? saved.hideClosed,
    }),
    [drafted, saved, filterText],
  );

  const createView = trpc.project.createView.useMutation({
    onSuccess: (view) => {
      void utils.project.views.invalidate();
      go({ view: view.id, q: null });
    },
  });
  const updateView = trpc.project.updateView.useMutation({
    onSuccess: () => {
      setDraft({ viewId: null, config: {} });
      void utils.project.views.invalidate();
    },
  });
  const reorderViews = trpc.project.reorderViews.useMutation({
    onSuccess: () => void utils.project.views.invalidate(),
  });
  const deleteView = trpc.project.deleteView.useMutation({
    onSuccess: () => {
      void utils.project.views.invalidate();
      go({ view: null, q: null });
    },
  });

  /**
   * A row's title comes from the Issue it projects, never from a copy stored here.
   *
   * The table holds no title of its own — that is what makes it a projection over Issues rather
   * than a second Issue model (F23, Summary), and it is why an imported Issue's title staying the
   * provider's costs nothing here. The Issue's labels come along for the same reason: `-label:x`
   * names a fact about the Issue, not a column of the project.
   */
  const allRows: ProjectViewItem[] = useMemo(() => {
    const byId = new Map((issues.data?.items ?? []).map((i) => [i.id, i]));
    // The Tasks running under this project's Issues, indexed once for the whole table rather than
    // searched per row — a linear scan per row is quadratic at a thousand rows (F23 NFR-1).
    const runsByIssue = tasksByIssue(tasks.data?.items ?? []);
    return (items.data?.items ?? []).map((item) => {
      const issue = byId.get(item.issueId);
      const row: ProjectRow = {
        item,
        title: issue?.title ?? "Untitled",
        issueNumber: issue?.externalNumber ?? null,
        issueUrl: issue?.externalUrl ?? null,
        // The provider's own links, mirrored onto the Issue by the poll (#128). Empty for a row
        // whose Issue has not arrived yet — the same fallback the title takes, for the same
        // reason: a row still renders while its Issue is catching up.
        linkedChangeRequests: issue?.linkedChangeRequests ?? [],
        // The provider's own labels on the Issue, which are *not* the project's "Labels" field:
        // GitHub reports that field as read-only and empty, so a table that only rendered the
        // field showed a lock and a dash over issues that are in fact labelled.
        labels: issue?.labels ?? [],
        // The priority those labels state, for the projects whose Priority field was never
        // filled in. Read here, beside the labels it comes from, so there is one reading of it
        // for the column, the filter and the sort rather than three.
        priority: priorityFromLabels(issue?.labels ?? []),
        tasks: summariseRowTasks(runsByIssue.get(item.issueId) ?? []),
      };
      return { row };
    });
    // `tasks.data` among them: without it the Agent runs column is computed once and never again,
    // so a run that starts, finishes or fails leaves the badge showing what was true on first
    // paint — a stale answer that looks like a current one.
  }, [items.data, issues.data, tasks.data]);

  const fields = useMemo(() => project.data?.fields ?? [], [project.data]);
  /**
   * The complete row set, in the view's order — what the table builds its hierarchy from.
   *
   * Complete, because an epic's rollup counts the children a filter hid; **sorted**, because
   * sibling order in that tree is the order this array arrives in, and the table draws from the
   * tree. Handing it the raw mirror order was why clicking a column header moved the arrow and
   * nothing else: the sort was applied to `rows`, which the table uses only to decide what is
   * visible, never what order it sits in.
   */
  const hierarchyRows = useMemo(
    () =>
      sortProjectRows(
        allRows.map((entry) => entry.row),
        fields,
        config.sort,
      ),
    [allRows, fields, config.sort],
  );

  const rows: ProjectRow[] = useMemo(
    () =>
      applyProjectView(allRows, fields, config, {
        // The stated mapping, or null while it is still loading and when nobody has stated one.
        // Null matches nothing rather than everything — a `My items` tab quietly showing the
        // whole project is the worse of the two failures, and the banner below says which it is.
        me: me.data?.login ?? null,
      }),
    [allRows, fields, config, me.data],
  );

  /**
   * The mapping is missing, and this view is asking for it.
   *
   * Both halves matter. Asking for the mapping when no tab mentions `@me` would be nagging about
   * a setting nothing is currently using; staying quiet while a `My items` tab renders empty
   * would let an operator conclude they have no work, which is the failure this whole mapping
   * exists to prevent. `me.data` gates it so a page mid-fetch does not accuse itself.
   */
  const meUnmapped =
    me.data !== undefined && me.data.login === null && filterAsksWhoIAm(config.filter);

  const singleSelects: ProjectFieldDto[] = useMemo(
    () => fields.filter((f) => f.type === "single_select"),
    [fields],
  );

  /**
   * What the table hides: the view's own column set, plus whatever this person hid on top.
   *
   * Two different facts. The view is the team's — `Bugs` shows the columns a bug triager needs —
   * and the arrangement riding on top of it is genuinely personal (#126, F23 FR-3). Merging them
   * into one stored set would make one person's narrow screen everybody's column set.
   */
  const hiddenFieldIds = useMemo(
    () =>
      effectiveHiddenFieldIds({
        fields,
        // Judged over the *complete* row set, not the filtered one: a column is not noise for
        // being empty on the rows a filter happened to leave.
        rows: allRows.map((entry) => entry.row),
        visibleFieldIds: config.visibleFieldIds,
        hidden: layout.data?.layout.hidden ?? [],
        shown: layout.data?.layout.shown ?? [],
      }),
    [fields, allRows, config.visibleFieldIds, layout.data],
  );

  /** The labels these rows carry, and the ones the filter currently names. */
  const projectLabels = useMemo(() => labelsInRows(allRows), [allRows]);
  const chosenLabels = useMemo(() => selectedLabels(config.filter), [config.filter]);

  const dirty = JSON.stringify(config) !== JSON.stringify(saved);

  if (project.isPending) {
    return (
      <p className="flex items-center gap-2 p-6 text-muted-foreground text-sm">
        <Loader2 aria-hidden className="size-4 animate-spin" /> Loading project…
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/*
        No project picker here any more.

        Which Project you are in is the navigator's business — it is the top of the hierarchy, so
        it belongs at the top of the sidebar, not in a toolbar above one of the Project's own
        tabs. A switcher inside the table also implied the table was the Project, when the board
        and the issue list are equally inside it.
      */}
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="ml-auto flex items-center gap-2">
          <span className="font-mono text-2xs text-muted-foreground tabular-nums">
            {/* Both numbers while a filter is on: "12 items" under a filter reads as a project
                that has twelve items, which is a different and wrong claim. */}
            {rows.length === allRows.length
              ? `${items.data?.total ?? 0} items`
              : `${rows.length} of ${items.data?.total ?? 0} items`}
          </span>
          {/* The one authoring action the toolbar has (F23a): sits immediately left of the
              source-branched controls, its two entries each stating why when they cannot run. */}
          {project.data && <ProjectCreateMenu project={project.data} />}
          {project.data?.source === "local" ? (
            // A local Project has no provider to poll — Refresh and Rescan exist to reconcile
            // with one, and there is none here. Its rows come from which Repositories are
            // registered under it, which is what this dialog decides.
            <ProjectRepositoriesDialog
              projectId={projectId}
              trigger={
                <Button size="xs" variant="ghost">
                  <FolderGit2 aria-hidden /> Repositories
                </Button>
              }
            />
          ) : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={refresh.isPending || rescan.isPending || !projectId}
                onClick={() => projectId && refresh.mutate({ projectId })}
              >
                <RefreshCw className={refresh.isPending ? "animate-spin" : undefined} /> Refresh
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={refresh.isPending || rescan.isPending || !projectId}
                onClick={() => projectId && rescan.mutate({ projectId })}
                // The repair, kept distinct from the poll: a project mirrored before its
                // repositories could be connected holds a finished sync and no rows, and no
                // number of one-page refreshes reaches the pages that were already walked.
                title="Re-read every page, connecting the repositories these rows need"
              >
                <FolderSync className={rescan.isPending ? "animate-spin" : undefined} /> Rescan
              </Button>
              <AdoptProjectDialog onAdopted={(id) => go({ project: id, view: null, q: null })} />
            </>
          )}
          {/* Regardless of source — a local Project's Repositories dialog and a mirrored one's
              sync controls both decide what's *in* the Project; deleting it is a different axis
              and applies to either kind the same way. */}
          <ConfirmAction
            trigger={
              <Button size="xs" variant="ghost" disabled={deleteProject.isPending}>
                <Trash2 aria-hidden /> Delete
              </Button>
            }
            title={`Delete "${project.data?.title ?? "this project"}"?`}
            description="This removes the Project from SoloW — its saved views, fields and values. Its Issues are kept and become unassigned, and nothing is deleted on the provider."
            confirmLabel="Delete project"
            onConfirm={() => projectId && deleteProject.mutate({ projectId })}
          />
        </span>
      </div>
      {deleteProject.error && (
        <p className="border-b px-4 py-2 text-destructive text-xs" role="alert">
          {deleteProject.error.message}
        </p>
      )}

      <ProjectViewTabs
        views={views.data ?? []}
        activeViewId={activeViewId}
        disabled={!projectId}
        onSelect={(viewId) => go({ view: viewId, q: null })}
        onCreate={() => projectId && createView.mutate({ projectId, name: "New view", config })}
        onRename={(viewId, name) => updateView.mutate({ viewId, name })}
        onReorder={(viewIds) => projectId && reorderViews.mutate({ projectId, viewIds })}
        onDelete={(viewId) => deleteView.mutate({ viewId })}
      />

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <span className="relative min-w-64 flex-1">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70"
          />
          <Input
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            aria-label="Filter items"
            placeholder={'status:"In progress" assignee:@me -label:blocked'}
            className="h-7 pl-8 text-xs"
          />
        </span>

        {/* Layout is a projection of the same rows, so switching one fetches nothing. */}
        <span className="flex items-center gap-1">
          <Button
            size="xs"
            variant={config.layout === "table" ? "secondary" : "ghost"}
            aria-pressed={config.layout === "table"}
            onClick={() => patchDraft({ layout: "table" })}
          >
            <Table2 aria-hidden /> Table
          </Button>
          <Button
            size="xs"
            variant={config.layout === "roadmap" ? "secondary" : "ghost"}
            aria-pressed={config.layout === "roadmap"}
            onClick={() => patchDraft({ layout: "roadmap" })}
          >
            <CalendarRange aria-hidden /> Roadmap
          </Button>
        </span>

        <Select
          value={config.groupByFieldId ?? "none"}
          onValueChange={(v) => patchDraft({ groupByFieldId: v === "none" ? null : v })}
        >
          <SelectTrigger className="h-7 w-40 text-xs">
            <SelectValue placeholder="Group by" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No grouping</SelectItem>
            {singleSelects.map((f) => (
              <SelectItem key={f.id} value={f.id}>
                Group by {f.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {/*
          Sorting is done by clicking a column header, which is where the columns are.

          This used to be a `Sort by` dropdown listing every field beside a direction toggle — two
          controls, in a toolbar, naming columns that were already on screen a few pixels below.
          Choosing `Sort by Target date` from a menu when the header reading *Target date* is
          right there is indirection for its own sake, and it is not what a planning table is
          expected to do.

          It survives for the **roadmap**, and only there: a roadmap has no column headers to
          click, so removing the control outright would take sorting away from that layout rather
          than move it. A control that exists exactly where the direct manipulation cannot is not
          a duplicate of it.
        */}
        {config.layout === "roadmap" && (
          <>
            <Select
              value={config.sort?.field ?? "none"}
              onValueChange={(v) =>
                patchDraft({
                  sort:
                    v === "none" ? null : { field: v, direction: config.sort?.direction ?? "asc" },
                })
              }
            >
              <SelectTrigger className="h-7 w-40 text-xs">
                <SelectValue placeholder="Sort by" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No sort</SelectItem>
                <SelectItem value={PROJECT_TITLE_KEY}>Sort by title</SelectItem>
                {fields.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    Sort by {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {config.sort && (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={config.sort.direction === "asc" ? "Sort ascending" : "Sort descending"}
                onClick={() =>
                  patchDraft({
                    sort: config.sort
                      ? {
                          field: config.sort.field,
                          direction: config.sort.direction === "asc" ? "desc" : "asc",
                        }
                      : null,
                  })
                }
              >
                {config.sort.direction === "asc" ? (
                  <ArrowUpAZ aria-hidden />
                ) : (
                  <ArrowDownAZ aria-hidden />
                )}
              </Button>
            )}
          </>
        )}

        {/*
          Narrowing by label, from a menu rather than from remembering how to spell one.

          The menu writes into the filter box — `label:type/feat,prio/p1` — so there is exactly one
          place a narrowing lives, and it is the place the URL carries and a view saves. An epic
          whose child matched stays drawn (see `ProjectTable`), so filtering by a label shows the
          matching issues *and* the epics they sit under rather than a flat list of orphans.
        */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant={chosenLabels.length > 0 ? "secondary" : "ghost"}>
              <Tags aria-hidden /> Labels
              {chosenLabels.length > 0 && (
                <span className="font-mono text-2xs tabular-nums">{chosenLabels.length}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-96 w-64 overflow-auto">
            <DropdownMenuLabel className="text-2xs">Labels on these items</DropdownMenuLabel>
            {projectLabels.length === 0 && (
              <p className="px-2 py-1.5 text-2xs text-muted-foreground">
                None of these items carry a label.
              </p>
            )}
            {projectLabels.map((name) => (
              <DropdownMenuCheckboxItem
                key={name}
                checked={chosenLabels.includes(name)}
                onCheckedChange={(checked) =>
                  go({
                    q: formatProjectFilter(
                      withLabels(
                        config.filter,
                        checked ? [...chosenLabels, name] : chosenLabels.filter((l) => l !== name),
                      ),
                    ),
                  })
                }
              >
                <IssueLabel name={name} color={labelColours[name]} />
              </DropdownMenuCheckboxItem>
            ))}
            {chosenLabels.length > 0 && (
              <button
                type="button"
                className="mt-1 w-full border-t px-2 py-1.5 text-left text-2xs text-muted-foreground hover:text-foreground"
                onClick={() => go({ q: formatProjectFilter(withLabels(config.filter, [])) })}
              >
                Clear label filter
              </button>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {/*
          Finished work, in or out.

          A checkbox rather than a filter clause: `-status:Done` is a statement about a *field*
          this project happens to have, and closing an issue is a fact the provider reports on
          every project whether it has a Status column or not. It rides on the view config, so a
          `Backlog` tab can be saved with it on while `Recently shipped` keeps it off.

          Closed rows leave the table; they do not leave the arithmetic. An epic still reads
          `5/8` with its finished children hidden — see `applyProjectView`.
        */}
        <label
          htmlFor="project-hide-closed"
          className="flex shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap text-muted-foreground text-xs hover:text-foreground"
        >
          <Checkbox
            id="project-hide-closed"
            checked={config.hideClosed}
            onCheckedChange={(checked) => patchDraft({ hideClosed: checked === true })}
          />
          Hide closed
        </label>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="xs" variant="ghost">
              <Columns3 aria-hidden /> Columns
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-80 overflow-auto">
            <DropdownMenuLabel className="text-2xs">Columns in this view</DropdownMenuLabel>
            {fields.map((field) => {
              const shown =
                config.visibleFieldIds === null || config.visibleFieldIds.includes(field.id);
              return (
                <DropdownMenuCheckboxItem
                  key={field.id}
                  checked={shown}
                  onCheckedChange={() => {
                    // Null means "every column", so the first hide has to be written out as the
                    // full set minus one — otherwise a view saved today would hide a field the
                    // provider adds tomorrow, which nobody chose.
                    const current = config.visibleFieldIds ?? fields.map((f) => f.id);
                    patchDraft({
                      visibleFieldIds: shown
                        ? current.filter((id) => id !== field.id)
                        : [...current, field.id],
                    });
                  }}
                >
                  {field.name}
                </DropdownMenuCheckboxItem>
              );
            })}
          </DropdownMenuContent>
        </DropdownMenu>

        {dirty && activeView && (
          <Button
            size="xs"
            variant="outline"
            loading={updateView.isPending}
            onClick={() => updateView.mutate({ viewId: activeView.id, config })}
          >
            {/* Explicit, because the tab is the team's: an unsaved narrowing is one person
                looking, and a saved one is everybody's default. */}
            <Save aria-hidden /> Save to {activeView.name}
          </Button>
        )}
      </div>

      {lastPass &&
        (lastPass.skipped > 0 ||
          lastPass.connected.length > 0 ||
          lastPass.drafts > 0 ||
          lastPass.pullRequests > 0) && (
          <p className="shrink-0 border-b bg-background/60 px-4 py-1.5 text-2xs text-muted-foreground">
            {/* Three different facts, and each one explains a different discrepancy between this
                table and the same project on the provider. Left unsaid, a shorter table reads as
                a broken import. */}
            {lastPass.connected.length > 0 && (
              <span className="text-state-parked">
                Connected {lastPass.connected.join(", ")} to import their issues.{" "}
              </span>
            )}
            {(lastPass.drafts > 0 || lastPass.pullRequests > 0) && (
              <span>
                Not shown:{" "}
                {[
                  lastPass.drafts > 0 &&
                    `${lastPass.drafts} draft${lastPass.drafts === 1 ? "" : "s"}`,
                  lastPass.pullRequests > 0 &&
                    `${lastPass.pullRequests} pull request${lastPass.pullRequests === 1 ? "" : "s"}`,
                ]
                  .filter(Boolean)
                  .join(" and ")}{" "}
                — every row here is an issue.{" "}
              </span>
            )}
            {lastPass.skipped > 0 && (
              <span>
                {lastPass.skipped} row{lastPass.skipped === 1 ? "" : "s"} still waiting on their
                issues.
              </span>
            )}
          </p>
        )}

      {meUnmapped && (
        <p className="flex shrink-0 flex-wrap items-center gap-1.5 border-b bg-background/60 px-4 py-1.5 text-2xs text-muted-foreground">
          <UserX aria-hidden className="size-3.5" />
          {/* The count above already says "0 of N": this says why, and what to do about it. The
              filter is left exactly as typed — resolving @me to nothing is the honest answer
              until somebody states who they are. */}
          <span>
            <code className="font-mono">@me</code> matches nothing here: SoloW does not know your
            login on this project&apos;s provider.
          </span>
          <Link className="underline underline-offset-2" href="/settings?section=provider-identity">
            Say who you are
          </Link>
        </p>
      )}

      {setValue.error && (
        <p className="shrink-0 border-b bg-state-failed/5 px-4 py-1.5 text-2xs text-state-failed">
          {/* The provider's value is still on screen: the write failed, so nothing changed. */}
          {setValue.error.message}
        </p>
      )}

      {project.data ? (
        config.layout === "roadmap" ? (
          <ProjectRoadmap fields={fields} rows={rows} />
        ) : (
          <ProjectTable
            project={project.data}
            rows={rows}
            hierarchyRows={hierarchyRows}
            groupByFieldId={config.groupByFieldId}
            hiddenFieldIds={hiddenFieldIds}
            widths={layout.data?.layout.widths}
            columnOrder={layout.data?.layout.order}
            labelColours={labelColours}
            priorityChoices={priorityChoices}
            onSetPriority={(row, label) => {
              const field = fields.find((f) => isPriorityFieldName(f.name));
              if (!field) return;
              const key = `${row.item.id}:${field.id}`;
              setPending((p) => [...p, key]);
              setPriority.mutate(
                {
                  issueId: row.item.issueId,
                  // Every label that is not a priority survives untouched — a provider takes a
                  // whole label set, so this is the one write that could silently drop `area/web`.
                  labels: withPriorityLabel(row.labels, label),
                },
                { onSettled: () => setPending((p) => p.filter((k) => k !== key)) },
              );
            }}
            /*
             * A width is stored per column, and `null` means "fit the content" — which is stored
             * as *absence* rather than as a number, so the column goes on tracking its content
             * instead of freezing at whatever it happened to measure once.
             */
            onResize={(fieldId, width) => {
              const next = { ...(layout.data?.layout.widths ?? {}) };
              if (width === null) delete next[fieldId];
              else next[fieldId] = width;
              saveLayout.mutate({
                surface: "project-table",
                layout: {
                  order: [...(layout.data?.layout.order ?? [])],
                  hidden: [...(layout.data?.layout.hidden ?? [])],
                  shown: [...(layout.data?.layout.shown ?? [])],
                  widths: next,
                },
              });
            }}
            onReorder={(fieldIds) =>
              saveLayout.mutate({
                surface: "project-table",
                layout: {
                  order: fieldIds,
                  hidden: [...(layout.data?.layout.hidden ?? [])],
                  shown: [...(layout.data?.layout.shown ?? [])],
                  widths: { ...(layout.data?.layout.widths ?? {}) },
                },
              })
            }
            pendingCells={pending}
            onEdit={editCell}
            onOpenRow={openRow}
            onStartTask={startTask}
            sort={config.sort}
            /*
             * Ascending → descending → none, on the header itself (`cycleSort`).
             *
             * The third click is the part that is new. It used to be missing because the
             * toolbar's `Sort by` menu owned "no sort"; with that menu gone from this layout, a
             * sort applied on a header and only clearable somewhere else would be a one-way door.
             */
            onSort={(field) => patchDraft({ sort: cycleSort(config.sort, field) })}
          />
        )
      ) : (
        <p className="p-6 text-muted-foreground text-sm">Loading…</p>
      )}

      {/* Title, description, assignees, labels, milestone and state — all edited on the provider
          that owns them (Decision 0019). The panel is the only surface large enough for a
          description, and the cells above stay for the columns the project itself defines. */}
      <IssuePanel issueId={panelIssueId} onOpenChange={(open) => !open && setPanelIssueId(null)} />

      {/* The row menu's "Start a task on this issue", rendered here so every row-triggered
          overlay sits in one place. Mounted only while open: the form starts empty each time
          without a reset path, and the dialog's four lookups stay off a page that is already
          holding eight queries. Cleared on close, or a second right-click would open on the row
          somebody clicked before it. */}
      {taskPreset && (
        <CreateTaskDialog
          trigger={null}
          open
          preset={taskPreset}
          onOpenChange={(next) => !next && setTaskPreset(null)}
        />
      )}

      {/* Column visibility for *this person*, saved through F19's preference boundary so it
          survives a device change — the same seam the status bar uses. It rides on top of the
          view's own column set above, and never edits it. */}
      <div className="shrink-0 border-t px-4 py-1.5">
        <details>
          <summary className="cursor-pointer text-2xs text-muted-foreground">My columns</summary>
          <div className="flex flex-wrap gap-3 pt-2">
            {fields.map((field) => {
              // The effective answer, so a column hidden by the table's own default shows as
              // unticked rather than as ticked-but-absent.
              const hidden = hiddenFieldIds.includes(field.id);
              return (
                <label key={field.id} className="flex items-center gap-1.5 text-2xs">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => {
                      /*
                       * Both lists, because visibility is a three-state (see `surfaceLayoutSchema`).
                       * Turning a column on has to be *recorded* in `shown`, or the table's own
                       * default — hide a read-only field the provider fills in for no row — would
                       * put it straight back on the next load, and the tick would look broken.
                       */
                      saveLayout.mutate({
                        surface: "project-table",
                        layout: {
                          order: [...(layout.data?.layout.order ?? [])],
                          hidden: hidden
                            ? (layout.data?.layout.hidden ?? []).filter((id) => id !== field.id)
                            : [...(layout.data?.layout.hidden ?? []), field.id],
                          shown: hidden
                            ? [...(layout.data?.layout.shown ?? []), field.id]
                            : (layout.data?.layout.shown ?? []).filter((id) => id !== field.id),
                        },
                      });
                    }}
                  />
                  {field.name}
                </label>
              );
            })}
          </div>
        </details>
      </div>
    </div>
  );
}
