"use client";

import type { ProjectFieldDto, ProjectFilter, ProjectViewConfig } from "@gatecontrol/contracts";
import { DEFAULT_PROJECT_VIEW_CONFIG, PROJECT_TITLE_KEY } from "@gatecontrol/contracts";
import { FILTER_ME, formatProjectFilter, parseProjectFilter } from "@gatecontrol/core";
import {
  ArrowDownAZ,
  ArrowUpAZ,
  CalendarRange,
  Columns3,
  FolderSync,
  Loader2,
  RefreshCw,
  Save,
  Search,
  Table2,
  UserX,
} from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { openCreateDialog } from "@/components/features/board/create-dialog-bus";
import { AdoptProjectDialog } from "@/components/features/project/adopt-project-dialog";
import { IssuePanel } from "@/components/features/project/issue-panel";
import { ProjectRoadmap } from "@/components/features/project/project-roadmap";
import { type ProjectRow, ProjectTable } from "@/components/features/project/project-table";
import {
  applyProjectView,
  hiddenFieldIdsFor,
  type ProjectViewItem,
} from "@/components/features/project/project-view-model";
import { ProjectViewTabs } from "@/components/features/project/project-view-tabs";
import { Button } from "@/components/ui/button";
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
  const issues = trpc.issue.list.useQuery({});
  /**
   * Who `@me` is *on this project's provider*.
   *
   * Resolved server-side, per project, because a project belongs to exactly one Integration and
   * that Integration is what decides which login means "me". The GateControl account name that
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
  const saveLayout = trpc.preference.setSurfaceLayout.useMutation({
    onSuccess: () => void utils.preference.getSurfaceLayout.invalidate(),
  });

  const onSynced = () => {
    void utils.project.get.invalidate();
    void utils.project.items.invalidate();
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
   * Which Issue the side panel is showing, or null for closed.
   *
   * One piece of state rather than an `open` flag beside an id: the two can disagree, and the
   * disagreement renders as an empty panel with no explanation.
   */
  const [panelIssueId, setPanelIssueId] = useState<string | null>(null);
  const [pending, setPending] = useState<string[]>([]);
  const setValue = trpc.project.setValue.useMutation({
    onSettled: (_data, _error, variables) => {
      setPending((p) => p.filter((k) => k !== `${variables.itemId}:${variables.fieldId}`));
      // Re-read rather than patching a local copy: what the provider stored is the only value
      // worth rendering, and it may not be what was sent (F23 NFR-7).
      void utils.project.items.invalidate();
    },
  });

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
    const byId = new Map((issues.data ?? []).map((i) => [i.id, i]));
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
      };
      return { row };
    });
  }, [items.data, issues.data]);

  const fields = useMemo(() => project.data?.fields ?? [], [project.data]);
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
    () => [
      ...new Set([
        ...hiddenFieldIdsFor(fields, config.visibleFieldIds),
        ...(layout.data?.layout.hidden ?? []),
      ]),
    ],
    [fields, config.visibleFieldIds, layout.data],
  );

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
            // The repair, kept distinct from the poll: a project mirrored before its repositories
            // could be connected holds a finished sync and no rows, and no number of one-page
            // refreshes reaches the pages that were already walked.
            title="Re-read every page, connecting the repositories these rows need"
          >
            <FolderSync className={rescan.isPending ? "animate-spin" : undefined} /> Rescan
          </Button>
          <AdoptProjectDialog onAdopted={(id) => go({ project: id, view: null, q: null })} />
        </span>
      </div>

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

        <Select
          value={config.sort?.field ?? "none"}
          onValueChange={(v) =>
            patchDraft({
              sort: v === "none" ? null : { field: v, direction: config.sort?.direction ?? "asc" },
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
            <code className="font-mono">@me</code> matches nothing here: GateControl does not know
            your login on this project&apos;s provider.
          </span>
          <Link className="underline underline-offset-2" href="/settings#provider-identity">
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
            hierarchyRows={allRows.map((entry) => entry.row)}
            groupByFieldId={config.groupByFieldId}
            hiddenFieldIds={hiddenFieldIds}
            pendingCells={pending}
            onEdit={(row, field, value) => {
              if (!projectId) return;
              setPending((p) => [...p, `${row.item.id}:${field.id}`]);
              setValue.mutate({ projectId, itemId: row.item.id, fieldId: field.id, value });
            }}
            onOpenRow={(row) => setPanelIssueId(row.item.issueId)}
            // Right-click → "Start a task on this issue". The dialog opens with the issue already
            // chosen; everything else about the task is still the operator's to fill in.
            onStartTask={(row) =>
              openCreateDialog("task", {
                issueId: row.item.issueId,
                ...(row.item.repositoryId ? { repositoryId: row.item.repositoryId } : {}),
              })
            }
            sort={config.sort}
            // Clicking the sorted column flips it; clicking another takes the sort over at
            // ascending. The toolbar's own control still owns "no sort", which is why there is no
            // third click that clears it here.
            onSort={(field) =>
              patchDraft({
                sort:
                  config.sort?.field === field
                    ? { field, direction: config.sort.direction === "asc" ? "desc" : "asc" }
                    : { field, direction: "asc" },
              })
            }
          />
        )
      ) : (
        <p className="p-6 text-muted-foreground text-sm">Loading…</p>
      )}

      {/* Title, description, assignees, labels, milestone and state — all edited on the provider
          that owns them (Decision 0019). The panel is the only surface large enough for a
          description, and the cells above stay for the columns the project itself defines. */}
      <IssuePanel issueId={panelIssueId} onOpenChange={(open) => !open && setPanelIssueId(null)} />

      {/* Column visibility for *this person*, saved through F19's preference boundary so it
          survives a device change — the same seam the status bar uses. It rides on top of the
          view's own column set above, and never edits it. */}
      <div className="shrink-0 border-t px-4 py-1.5">
        <details>
          <summary className="cursor-pointer text-2xs text-muted-foreground">My columns</summary>
          <div className="flex flex-wrap gap-3 pt-2">
            {fields.map((field) => {
              const hidden = (layout.data?.layout.hidden ?? []).includes(field.id);
              return (
                <label key={field.id} className="flex items-center gap-1.5 text-2xs">
                  <input
                    type="checkbox"
                    checked={!hidden}
                    onChange={() => {
                      const current = [...(layout.data?.layout.hidden ?? [])];
                      saveLayout.mutate({
                        surface: "project-table",
                        layout: {
                          order: [...(layout.data?.layout.order ?? [])],
                          hidden: hidden
                            ? current.filter((id) => id !== field.id)
                            : [...current, field.id],
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
