"use client";

import type {
  LinkedChangeRequest,
  ProjectDto,
  ProjectFieldDto,
  ProjectFieldValue,
  ProjectItemDto,
} from "@gatecontrol/contracts";
import { PROJECT_TITLE_KEY } from "@gatecontrol/contracts";
import {
  buildProjectHierarchy,
  countProjectRows,
  flattenProjectHierarchy,
  type ProjectHierarchyRow,
  type ProjectTreeNode,
} from "@gatecontrol/core";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CheckCircle2 as CircleCheck,
  CircleDashed,
  CircleDot,
  Copy,
  ExternalLink,
  GitPullRequest,
  Lock,
  PanelRight,
  Unlink,
  Zap,
} from "lucide-react";
import { useMemo, useState } from "react";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { ProjectCell } from "./project-cell";
import { SubIssueProgress } from "./project-progress";

/**
 * The project table (spec F23, issue #126).
 *
 * Columns come from the **project's own fields**, not from a list written here: a project with a
 * field GateControl has never heard of still shows it, named as the provider names it. A column
 * set that silently omits what it cannot render lies about what the project holds.
 *
 * Read-only in this first cut. Inline editing writes to the provider and is the second half of
 * #126 — what is here is the half that has to be true before an edit can be honest: the value on
 * screen is the value the provider holds.
 */

export interface ProjectRow {
  item: ProjectItemDto;
  /** Resolved from the Issue the row projects — the table itself never stores a title. */
  title: string;
  issueNumber: number | null;
  issueUrl: string | null;
  /**
   * The pull or merge requests the **provider** links to this row's Issue (F23 FR-8, issue #128).
   *
   * Not a project field, so not a column the provider reports: it hangs off the Issue, the same
   * way the title does, and is resolved the same way. And not the branch a GateControl Task
   * produced (issue #104) — that is a different fact and gets a different column, or a reader
   * cannot tell what the provider knows from what an agent did here.
   */
  linkedChangeRequests: LinkedChangeRequest[];
  /**
   * The Issue's own labels, from the provider (§7).
   *
   * Distinct from the project's `Labels` *field*, which GitHub reports as read-only and never
   * fills in — rendering only that field showed a padlock and a dash over issues carrying six
   * labels each. These come off the Issue, the same way the title does.
   */
  labels: string[];
}

/**
 * A change request's state, in the colour vocabulary the rest of the product already uses.
 *
 * Chosen against those tokens rather than against GitHub's palette: `running` is what "in flight"
 * means everywhere else here, `done` is what landed, and a closed-unmerged change is *idle*, not
 * failed — someone decided against it, which is a decision and not an error. Painting it red
 * would make the table editorialise about a choice a team made deliberately.
 */
const LINK_STATE_CLASS: Record<LinkedChangeRequest["state"], string> = {
  open: "border-state-running/40 text-state-running",
  merged: "border-state-done/40 text-state-done",
  closed: "border-state-idle/40 text-state-idle",
};

/**
 * How many badges a row shows before it counts the rest.
 *
 * A long-lived issue can collect a dozen cross-references, and a row that grows to fit them stops
 * being a row. The overflow is counted rather than dropped — "+4" is still an answer.
 */
const MAX_VISIBLE_LINKS = 3;

/**
 * What a reader is told about a row whose parent the hierarchy refused (F23 FR-7, #127 AC-6).
 *
 * The provider reported a parent chain that comes back to this row, so every row on the loop is
 * drawn at the top level instead — see `buildProjectHierarchy`. Said in words, because the whole
 * point of the refusal is that the reader must not mistake it for a project that simply has no
 * epic here: an unexplained top-level row and a refused one look identical.
 *
 * Deliberately flat in tone. It is the provider's data contradicting itself, not GateControl
 * failing, and a table that raises an alarm about someone else's sub-issue loop teaches its
 * reader to ignore markers.
 */
const REFUSED_PARENT_NOTE =
  "The provider reports this issue's parent chain looping back to itself. Shown at the top level, unnested, because a hierarchy that contradicts itself is not one this table can draw.";

/**
 * The provider's links, as badges that leave (F23 FR-8, #128 AC-2 / AC-3).
 *
 * **Read-only, and there is nothing here to grow.** No create, no review, no approve, no merge —
 * that is issue #71's, behind the review gate. The temptation to add a merge button to a row that
 * already knows the pull request is exactly the one issue #104 names and refuses: it turns a
 * planning table into a second, worse client for the provider the team already has open.
 */
function LinkedChanges({ row }: { row: ProjectRow }) {
  const links = row.linkedChangeRequests;
  // An empty cell, not a hidden column: "nothing is in flight" is the answer a reviewer came for.
  if (links.length === 0) return <span className="text-muted-foreground/50">—</span>;

  const shown = links.slice(0, MAX_VISIBLE_LINKS);
  const overflow = links.length - shown.length;
  return (
    <span className="flex flex-wrap items-center gap-1">
      {shown.map((link) => (
        <a
          key={link.externalId}
          href={link.url}
          target="_blank"
          rel="noreferrer"
          title={`#${link.number} ${link.title} — ${link.state}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-2xs tabular-nums hover:underline",
            LINK_STATE_CLASS[link.state],
          )}
        >
          <GitPullRequest aria-hidden className="size-2.5" />#{link.number}
          {/* The state is in the text as well as the colour: a badge that says "merged" only in
              green is a badge nobody colour-blind can read (F23 FR-8). */}
          <span className="sr-only">{link.state}</span>
        </a>
      ))}
      {overflow > 0 && (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">+{overflow}</span>
      )}
    </span>
  );
}

/**
 * A row, plus the four facts the hierarchy resolves on (spec F23 FR-7, issue #127).
 *
 * The nesting, the cycle refusal and the rollup are `@gatecontrol/core`'s, not this file's: they
 * are decisions about a graph, and a decision about a graph should be provable without a DOM.
 * What is left here is what a table is for — an indent, a chevron and a number.
 */
export type NestableProjectRow = ProjectRow & ProjectHierarchyRow;

export function toNestableRow(row: ProjectRow): NestableProjectRow {
  return {
    ...row,
    id: row.item.id,
    externalId: row.item.issueExternalId,
    parentExternalId: row.item.parentExternalId,
    repositoryId: row.item.repositoryId,
    closed: row.item.closed,
  };
}

/** Which column a row is grouped under, and the label that group header shows. */
export function groupKeyFor(row: ProjectRow, field: ProjectFieldDto | null): string {
  if (!field) return "";
  const value = row.item.values[field.id];
  if (value?.type !== "single_select") return "";
  return value.optionId;
}

/**
 * Rendering a value the way its type reads now lives in `project-cell.tsx`, beside the editors
 * that share its vocabulary — `formatCellValue` is the same function under its own roof.
 */
export { formatCellValue as formatValue } from "./project-cell";

/**
 * The measured metrics of the reference table (GitHub Projects §1).
 *
 * Numbers rather than Tailwind's scale, because they are *measurements* — 37 is not `h-9` (36)
 * and the difference is visible when forty rows stack. `ROW_HEIGHT` is also what the windowing
 * arithmetic divides by, so it has to be the real height and not an approximation of one.
 */
export const ROW_HEIGHT = 37;
export const COLUMN_HEADER_HEIGHT = 34;
export const GROUP_HEADER_HEIGHT = 44;
/** The reference's default column width. Wide enough for a token and a caret without wrapping. */
export const DEFAULT_COLUMN_WIDTH = 200;

/**
 * How many labels a row shows before it counts the rest.
 *
 * Overflow is counted, never dropped: an issue carrying six labels in a cell that fits three is
 * still a six-label issue, and a row that silently showed half would answer "what is this tagged
 * with" wrongly.
 */
const MAX_VISIBLE_LABELS = 2;

/**
 * The Issue's labels, as tokens beside its title (§7).
 *
 * Neutral rather than in the repository's own colours, by the same decision that greyed every
 * other token here — so they read as a set of words, and shape carries what hue used to.
 */
function RowLabels({ labels }: { labels: string[] }) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, MAX_VISIBLE_LABELS);
  const overflow = labels.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1" title={labels.join(", ")}>
      {shown.map((name) => (
        <span
          key={name}
          className="inline-flex h-5 shrink-0 items-center rounded-full border border-border bg-muted/60 px-1.5 font-medium text-2xs text-muted-foreground"
        >
          {name}
        </span>
      ))}
      {overflow > 0 && (
        <span className="shrink-0 font-mono text-2xs text-muted-foreground/60">+{overflow}</span>
      )}
    </span>
  );
}

/**
 * The right-click menu on a row (§6's row affordances).
 *
 * Everything reachable here is also reachable another way — the title opens the panel, the number
 * links out — which is the rule for a context menu: it is a shortcut to actions that exist, never
 * the only door to one. A menu holding the sole way to do something is a menu that hides it.
 *
 * The one action that changes state is starting a Task, and it is offered only where it can
 * actually run: a row with no provider issue behind it has nothing for an agent to work on.
 */
function RowMenu({
  row,
  onOpenRow,
  onStartTask,
}: {
  row: ProjectRow;
  onOpenRow?: ((row: ProjectRow) => void) | undefined;
  onStartTask?: ((row: ProjectRow) => void) | undefined;
}) {
  return (
    <ContextMenuContent className="w-60">
      <ContextMenuLabel className="truncate text-2xs text-muted-foreground">
        {row.issueNumber === null ? row.title : `#${row.issueNumber} ${row.title}`}
      </ContextMenuLabel>
      <ContextMenuSeparator />
      {onStartTask && row.issueNumber !== null && (
        <ContextMenuItem onSelect={() => onStartTask(row)}>
          <Zap aria-hidden />
          Start a task on this issue
        </ContextMenuItem>
      )}
      {onOpenRow && (
        <ContextMenuItem onSelect={() => onOpenRow(row)}>
          <PanelRight aria-hidden />
          Open details
        </ContextMenuItem>
      )}
      {row.issueUrl && (
        <ContextMenuItem asChild>
          <a href={row.issueUrl} target="_blank" rel="noreferrer">
            <ExternalLink aria-hidden />
            Open on the provider
          </a>
        </ContextMenuItem>
      )}
      {row.issueNumber !== null && (
        <ContextMenuItem
          onSelect={() => {
            // Best-effort: a clipboard write can be refused (an insecure origin, a denied
            // permission) and there is nothing useful to say about it on a context menu that has
            // already closed. The number is on screen either way.
            void navigator.clipboard?.writeText(`#${row.issueNumber}`).catch(() => {});
          }}
        >
          <Copy aria-hidden />
          Copy issue number
        </ContextMenuItem>
      )}
    </ContextMenuContent>
  );
}

/**
 * The issue's own state, as GitHub draws it (§3, §7).
 *
 * The same four glyphs, distinguished by **shape** rather than by hue: a circle with a dot is
 * open, a circle with a check is closed, a dashed circle is a row with no provider issue behind
 * it. GitHub tints them green and purple; this build is neutral by decision, and these shapes
 * carry the distinction on their own — which is why they were the right icons to borrow.
 *
 * `closed` is the provider's own flag, never a Status column reading "Done": a status is a team's
 * convention and closed is a fact (F23 AC-2 / AC-3).
 */
function IssueStateIcon({ row }: { row: ProjectRow }) {
  if (row.issueNumber === null) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="flex shrink-0 items-center">
            <CircleDashed aria-hidden className="size-4 text-muted-foreground/50" />
            <span className="sr-only">No provider issue</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>This row has no issue on the provider</TooltipContent>
      </Tooltip>
    );
  }
  const closed = row.item.closed;
  const Icon = closed ? CircleCheck : CircleDot;
  const label = closed ? "Closed" : "Open";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex shrink-0 items-center">
          <Icon aria-hidden className="size-4 text-muted-foreground" />
          <span className="sr-only">{label}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label} on the provider</TooltipContent>
    </Tooltip>
  );
}

/**
 * The `aria-sort` value for one column.
 *
 * Lives on the `<th>` itself, which is where ARIA defines it — a `columnheader` carries the sort
 * state, and a button nested inside one does not (an `aria-sort` there is simply ignored, so the
 * announcement it looks like it makes never happens).
 */
function ariaSortFor(
  sort: { field: string; direction: "asc" | "desc" } | null | undefined,
  key: string,
): "ascending" | "descending" | "none" {
  if (sort?.field !== key) return "none";
  return sort.direction === "asc" ? "ascending" : "descending";
}

/**
 * A column header that sorts (§6).
 *
 * The sort lives in the *view*, not here: this reports which column carries it and asks for a
 * change. Clicking the sorted column flips its direction, clicking another takes the sort over at
 * ascending — the behaviour every table has, and the reason no third click clears it is that
 * "unsorted" is a state the toolbar's own control already offers by name.
 *
 * Rendered as a button only when it can do something. A header that looks pressable and is not is
 * worse than a plain label, and a read-only render (the tests, a future viewer role) passes no
 * handler at all.
 */
function SortableHeader({
  label,
  sortKey,
  sort,
  onSort,
  align = "start",
  locked = false,
}: {
  label: string;
  sortKey: string;
  sort: { field: string; direction: "asc" | "desc" } | null;
  onSort?: ((field: string) => void) | undefined;
  align?: "start" | "end";
  locked?: boolean;
}) {
  const active = sort?.field === sortKey;
  const body = (
    <>
      <span className="truncate">{label}</span>
      {locked && <Lock aria-hidden className="size-3 shrink-0 text-muted-foreground/50" />}
      {active &&
        (sort?.direction === "asc" ? (
          <ArrowUp aria-hidden className="size-3 shrink-0" />
        ) : (
          <ArrowDown aria-hidden className="size-3 shrink-0" />
        ))}
    </>
  );
  const shape = cn(
    "inline-flex max-w-full items-center gap-1",
    align === "end" && "w-full justify-end",
  );

  if (!onSort) return <span className={shape}>{body}</span>;
  return (
    <button
      type="button"
      onClick={() => onSort(sortKey)}
      className={cn(shape, "-mx-1 rounded px-1 py-0.5 hover:bg-accent/60")}
    >
      {body}
    </button>
  );
}

export function ProjectTable({
  project,
  rows,
  groupByFieldId,
  hierarchyRows,
  hiddenFieldIds = [],
  onEdit,
  onOpenRow,
  sort,
  onSort,
  onStartTask,
  pendingCells = [],
}: {
  project: ProjectDto;
  rows: ProjectRow[];
  /** Any single-select field. Null renders one flat list. */
  groupByFieldId: string | null;
  /**
   * The complete row set, when `rows` has been filtered.
   *
   * Two inputs rather than one because the table answers two different questions: what to draw
   * (filtered) and what an epic's progress is (all of it). Omitted, the two are the same set and
   * nothing is filtered.
   */
  hierarchyRows?: ProjectRow[] | undefined;
  hiddenFieldIds?: string[];
  /**
   * Write a cell. Absent on a read-only rendering, which is what the tests use and what a future
   * viewer role would get — the table itself never decides whether an edit is allowed.
   */
  /**
   * Write a cell. Absent on a read-only rendering, which is what the tests use and what a future
   * viewer role would get — the table itself never decides whether an edit is allowed.
   *
   * Takes a whole `ProjectFieldValue` rather than an option id: the first cut could only edit a
   * single-select, and a signature shaped around that one type made every other column read-only
   * by construction rather than by decision.
   */
  onEdit?:
    | ((row: ProjectRow, field: ProjectFieldDto, value: ProjectFieldValue | null) => void)
    | undefined;
  /** Open the issue panel on a row. Absent leaves the table read-only, as the tests render it. */
  onOpenRow?: ((row: ProjectRow) => void) | undefined;
  /**
   * The view's sort, so a column header can show which one is sorted and which way (§6).
   *
   * The table does not *apply* it — the rows arrive already ordered — it only reports it. Sorting
   * here as well would be a second implementation of the same rule, and the two would disagree
   * the first time one of them learned about a field type the other did not.
   */
  sort?: { field: string; direction: "asc" | "desc" } | null | undefined;
  /** Ask for a different sort. Absent leaves the headers inert, which is what a read-only render wants. */
  onSort?: ((field: string) => void) | undefined;
  /**
   * Start a Task on a row's Issue — the right-click menu's one action that changes anything.
   *
   * A prop rather than a call to the dialog bus from in here, for the reason every other action
   * on this table is a prop: a table that reached for a global dialog could not be rendered in a
   * test, in a read-only view, or anywhere the dialog does not exist.
   */
  onStartTask?: ((row: ProjectRow) => void) | undefined;
  /** `itemId:fieldId` of writes in flight, so a cell can disable itself without a local copy. */
  pendingCells?: string[];
}) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  /**
   * Which parent rows are **open**, never which are closed — that is the whole of "collapsed by
   * default" (AC-1). A table that remembered what was collapsed would open every epic the first
   * time it rendered, turning a 20-row table into 60 before anyone asked for it.
   */
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

  const columns = useMemo(
    () => project.fields.filter((f) => !hiddenFieldIds.includes(f.id)),
    [project.fields, hiddenFieldIds],
  );
  const groupField = useMemo(
    () => project.fields.find((f) => f.id === groupByFieldId && f.type === "single_select") ?? null,
    [project.fields, groupByFieldId],
  );

  /**
   * The provider's hierarchy, as a forest. A child appears once, under its parent; a child whose
   * parent is not in the project appears at the top level; a cycle the provider reported is
   * refused outright — every row on the loop drawn at the top level and marked, rather than
   * nested into a shape the provider never asserted (issue #127, AC-5 / AC-6, all decided in
   * core, where the graph can be proven without a DOM).
   */
  /*
   * Built from the *complete* row set, not the filtered one.
   *
   * The rollup badge means `done/total over this epic's children`. Building the hierarchy from
   * the rows that survived the filter silently re-means it to "over the children that survive the
   * current filter" — so a `Status is Todo` view turned an epic that is 5/8 into `0/2 · 0%`, a
   * number that is wrong, plausible, and accompanied by nothing saying it was narrowed. Worse,
   * children whose parent was filtered out were promoted to the top level, which looks exactly
   * like the legitimate orphan of AC-5.
   *
   * So the shape of the tree and the arithmetic on it come from everything; only what is *drawn*
   * is filtered, below.
   */
  const roots = useMemo(
    () => buildProjectHierarchy((hierarchyRows ?? rows).map(toNestableRow)),
    [hierarchyRows, rows],
  );

  /**
   * Which rows the filter admits. A parent stays drawn when a descendant matches — hiding an epic
   * whose child matched would hide the match itself, and the operator would read the filter as
   * having found nothing.
   */
  const visible = useMemo(() => new Set(rows.map((r) => r.item.id)), [rows]);
  const drawn = useMemo(() => {
    if (!hierarchyRows) return null;
    const keep = new Set<string>();
    const walk = (node: { row: { item: { id: string } }; children: unknown[] }): boolean => {
      const children = node.children as (typeof node)[];
      const anyChild = children.map(walk).some(Boolean);
      const self = visible.has(node.row.item.id);
      if (self || anyChild) keep.add(node.row.item.id);
      return self || anyChild;
    };
    for (const root of roots) walk(root as never);
    return keep;
  }, [hierarchyRows, roots, visible]);

  /**
   * Groups of **top-level** rows, in the field's own option order.
   *
   * The provider's order, not alphabetical: a Status field is ordered Todo → In progress → Done
   * because someone decided that, and re-sorting it would be the table overruling the project.
   *
   * A child is grouped by its parent, not by its own value, because a row appears exactly once —
   * and the once it appears is under the epic it belongs to. Grouping a sub-issue away from its
   * epic would show the hierarchy shredded across four headings, which is neither a grouping nor
   * a hierarchy.
   */
  const groups = useMemo(() => {
    if (!groupField) return [{ key: "", label: "", nodes: roots }];
    const byKey = new Map<string, ProjectTreeNode<NestableProjectRow>[]>();
    for (const node of roots) {
      const key = groupKeyFor(node.row, groupField);
      byKey.set(key, [...(byKey.get(key) ?? []), node]);
    }
    const ordered = groupField.options.map((option) => ({
      key: option.id,
      label: option.name,
      nodes: byKey.get(option.id) ?? [],
    }));
    // Rows with no value are a group of their own, last — "not decided" is an answer, and
    // dropping them would make the table show fewer rows than the project has.
    const unset = byKey.get("") ?? [];
    return [
      ...ordered,
      ...(unset.length > 0 ? [{ key: "", label: `No ${groupField.name}`, nodes: unset }] : []),
    ].filter((g) => g.nodes.length > 0);
  }, [groupField, roots]);

  if (project.fields.length === 0) {
    return (
      <p className="px-4 py-6 text-muted-foreground text-sm">
        This project has no fields yet. Refresh to read them from the provider.
      </p>
    );
  }

  return (
    // One provider for the whole table rather than one per cell — see `ProjectCell`.
    <TooltipProvider>
      <div className="min-h-0 flex-1 overflow-auto">
        <Table className="text-xs">
          <TableHeader className="sticky top-0 z-10 bg-card">
            <TableRow className="hover:bg-transparent">
              {/* The gutter's own header cell. Without it the header row is one cell short of the
                  body and every label sits over the wrong column — which is exactly what happened
                  the first time the gutter was added to the body alone. */}
              {/* The gutter's own header cell. Without it the header row is one cell short of the
                  body and every label sits over the wrong column — which is exactly what happened
                  the first time the gutter was added to the body alone. */}
              <TableHead className="w-10 px-2" style={{ height: COLUMN_HEADER_HEIGHT }}>
                <span className="sr-only">Row</span>
              </TableHead>
              <TableHead
                className="min-w-64 px-3"
                style={{ height: COLUMN_HEADER_HEIGHT }}
                aria-sort={ariaSortFor(sort, PROJECT_TITLE_KEY)}
              >
                <SortableHeader
                  label="Title"
                  sortKey={PROJECT_TITLE_KEY}
                  sort={sort ?? null}
                  onSort={onSort}
                />
              </TableHead>
              {/* Next to Title rather than out among the provider's own fields: like the title, this
                belongs to the Issue the row projects, not to the project's column set — and its
                position is therefore ours to decide rather than the provider's. "Linked changes"
                because the domain says change request; the provider's noun is on the badge's own
                page (issue #15's terminology rule). */}
              <TableHead className="min-w-28 px-3" style={{ height: COLUMN_HEADER_HEIGHT }}>
                Linked changes
              </TableHead>
              {columns.map((field) => (
                <TableHead
                  key={field.id}
                  className="px-3"
                  style={{ height: COLUMN_HEADER_HEIGHT, minWidth: DEFAULT_COLUMN_WIDTH }}
                  aria-sort={ariaSortFor(sort, field.id)}
                >
                  <SortableHeader
                    label={field.name}
                    sortKey={field.id}
                    sort={sort ?? null}
                    onSort={onSort}
                    align={field.type === "number" ? "end" : "start"}
                    // A field the provider will not let this build write is still a field it can
                    // be sorted by — the lock is about editing, not about reading.
                    locked={field.readOnly}
                  />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          {groups.map((group) => {
            const open = !collapsed[group.key];
            return (
              <TableBody key={group.key || "__ungrouped"}>
                {groupField && (
                  <TableRow className="bg-card hover:bg-card">
                    <TableHead
                      colSpan={columns.length + 3}
                      className="px-2 text-left font-medium text-2xs"
                      style={{ height: GROUP_HEADER_HEIGHT }}
                    >
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() => setCollapsed((c) => ({ ...c, [group.key]: open }))}
                        className="inline-flex items-center gap-1.5"
                      >
                        {open ? (
                          <ChevronDown aria-hidden className="size-3" />
                        ) : (
                          <ChevronRight aria-hidden className="size-3" />
                        )}
                        {/* The option dot of §6, neutral like every other token here: it marks
                            the heading as a value of the grouped field, not a section title. */}
                        <span
                          aria-hidden
                          className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                        />
                        <span className="font-semibold text-sm tracking-tight">{group.label}</span>
                        {/*
                        Every row in the group, children included — not the top-level ones.

                        Two counts sit on this screen: this one and the toolbar's `N items`, which
                        counts items. Counting roots here made a group holding one epic and ten
                        children read `1` beside a toolbar reading `11`, with nothing on screen
                        explaining the difference — and a reader who notices two disagreeing
                        numbers has to distrust both. So a group's count means what the toolbar's
                        means: rows, wherever they sit in the hierarchy, and the groups add up to
                        the total. Collapsing an epic does not change it — hidden is not gone.

                        Under a filter it counts the rows the filter *admitted*, which is the
                        toolbar's `N of M` first number: a parent drawn only to keep its matching
                        child reachable is context, not a match, and counting it would inflate
                        every group by the epics above the matches.
                      */}
                        {/* The round counter badge of §11. */}
                        <span className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-muted px-1.5 font-semibold text-2xs text-muted-foreground tabular-nums">
                          {countProjectRows(group.nodes, (row) => visible.has(row.id))}
                        </span>
                      </button>
                    </TableHead>
                  </TableRow>
                )}
                {open &&
                  flattenProjectHierarchy(group.nodes, expanded)
                    // Drawn is the filter's answer; `rollup` above is not filtered. A parent whose
                    // child matched stays, because hiding it would hide the match.
                    .filter(({ row }) => drawn === null || drawn.has(row.item.id))
                    .map(({ row, depth, hasChildren, rollup, inCycle }) => (
                      <ContextMenu key={row.item.id}>
                        <ContextMenuTrigger asChild>
                          <TableRow className="hover:bg-accent/30" style={{ height: ROW_HEIGHT }}>
                            {/* The issue's own number — see the header for why it is not an ordinal. */}
                            <TableCell className="w-16 px-2 text-right align-middle font-mono text-2xs text-muted-foreground/60 tabular-nums">
                              {row.issueNumber === null ? "" : `#${row.issueNumber}`}
                            </TableCell>
                            <TableCell className="max-w-xl px-3 py-0 align-middle">
                              {/* Indented rather than drawn as a separate table per epic: one column of
                            titles stays scannable, and a child keeps every one of its own cells. */}
                              <span
                                className="flex min-w-0 items-center gap-2"
                                style={{ paddingLeft: depth * 16 }}
                              >
                                {hasChildren ? (
                                  <button
                                    type="button"
                                    aria-expanded={expanded.has(row.item.id)}
                                    aria-label={`${expanded.has(row.item.id) ? "Collapse" : "Expand"} ${row.title}`}
                                    onClick={() =>
                                      setExpanded((current) => {
                                        const next = new Set(current);
                                        // Delete-or-add: one statement of the toggle, so the chevron and
                                        // the rows it reveals cannot disagree about what "open" means.
                                        if (!next.delete(row.item.id)) next.add(row.item.id);
                                        return next;
                                      })
                                    }
                                    className="shrink-0 text-muted-foreground hover:text-foreground"
                                  >
                                    {expanded.has(row.item.id) ? (
                                      <ChevronDown aria-hidden className="size-3" />
                                    ) : (
                                      <ChevronRight aria-hidden className="size-3" />
                                    )}
                                  </button>
                                ) : (
                                  // Keeps every title on the same line whether or not it has children,
                                  // so an indent reads as depth rather than as a missing chevron.
                                  <span aria-hidden className="size-3 shrink-0" />
                                )}
                                <IssueStateIcon row={row} />
                                {onOpenRow ? (
                                  // A button, not the row: a row-wide click target swallows every cell
                                  // editor inside it, and a title that opens a panel is the affordance
                                  // GitHub Projects uses for the same reason.
                                  <button
                                    type="button"
                                    onClick={() => onOpenRow(row)}
                                    title={row.title}
                                    className="truncate text-left hover:underline"
                                  >
                                    {row.title}
                                  </button>
                                ) : (
                                  <span className="truncate" title={row.title}>
                                    {row.title}
                                  </span>
                                )}
                                <RowLabels labels={row.labels} />
                                {inCycle && (
                                  // A native `title` rather than the tooltip primitive `Cell` uses: at a
                                  // thousand rows (NFR-1) a provider per row is a cost paid by every
                                  // table for a marker almost none of them show. The sentence is in the
                                  // row's text as well, because a marker that is only an icon is a
                                  // refusal a screen reader never hears.
                                  <span
                                    title={REFUSED_PARENT_NOTE}
                                    className="inline-flex shrink-0 items-center text-muted-foreground/70"
                                  >
                                    <Unlink aria-hidden className="size-3" />
                                    <span className="sr-only">{REFUSED_PARENT_NOTE}</span>
                                  </span>
                                )}
                                {rollup && (
                                  // Counted from what is closed on the provider, never from a Status
                                  // column (AC-2 / AC-3), and across every repository the children live
                                  // in (AC-4). Beside the title because it is a fact about this issue,
                                  // not a field the project reported.
                                  // §4: one segment per sub-issue rather than a `3/4` label. The count
                                  // and the percentage are both still there — the bar adds the shape.
                                  <SubIssueProgress done={rollup.done} total={rollup.total} />
                                )}
                              </span>
                            </TableCell>
                            <TableCell className="max-w-48 px-3 py-0 align-middle">
                              <LinkedChanges row={row} />
                            </TableCell>
                            {columns.map((field) => (
                              <TableCell
                                key={field.id}
                                className={cn("max-w-48 px-3 py-0 align-middle")}
                              >
                                <ProjectCell
                                  field={field}
                                  value={row.item.values[field.id]}
                                  rowTitle={row.title}
                                  onEdit={
                                    field.readOnly || !onEdit
                                      ? undefined
                                      : (value) => onEdit(row, field, value)
                                  }
                                  pending={pendingCells.includes(`${row.item.id}:${field.id}`)}
                                />
                              </TableCell>
                            ))}
                          </TableRow>
                        </ContextMenuTrigger>
                        <RowMenu row={row} onOpenRow={onOpenRow} onStartTask={onStartTask} />
                      </ContextMenu>
                    ))}
              </TableBody>
            );
          })}
        </Table>
      </div>
    </TooltipProvider>
  );
}
