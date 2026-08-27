"use client";

import type {
  LinkedChangeRequest,
  ProjectDto,
  ProjectFieldDto,
  ProjectFieldValue,
  ProjectItemDto,
} from "@solow/contracts";
import { PROJECT_TITLE_KEY } from "@solow/contracts";
import {
  buildProjectHierarchy,
  countProjectRows,
  type DerivedPriority,
  type FlatProjectRow,
  flattenProjectHierarchy,
  isPriorityFieldName,
  type ProjectHierarchyRow,
  type ProjectRollup,
  type ProjectTreeNode,
} from "@solow/core";
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
  PanelRight,
  Unlink,
  Zap,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
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
import { clampWidth, moveColumn, orderColumns } from "./column-sizing";
import { isoToday } from "./date-input";
import { IssueLabel, labelColour } from "./issue-label";
import {
  type DateCounterpart,
  PriorityCell,
  type PriorityChoice,
  ProjectCell,
} from "./project-cell";
import { SubIssueProgress } from "./project-progress";
import type { RowTaskSummary } from "./row-tasks";
import { type RowWindow, windowOf } from "./row-window";

/**
 * The project table (spec F23, issue #126).
 *
 * Columns come from the **project's own fields**, not from a list written here: a project with a
 * field SoloW has never heard of still shows it, named as the provider names it. A column
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
   * way the title does, and is resolved the same way. And not the branch a SoloW Task
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
  /**
   * The priority the Issue's **labels** state, where the project's own field holds none.
   *
   * Not a value and never stored as one. A GitHub project routinely carries a `Priority` field
   * whose options were never configured while every issue in it is labelled `prio/p2` — the
   * column then reads empty over a project that has priorities on every row. GitLab already has
   * this: its `Priority` field *is* a scoped label (`DEFAULT_GITLAB_MAPPING`). This is the same
   * reading, for the provider that has a field and no values in it.
   *
   * Null where the labels say nothing about priority, which is most rows on most projects.
   */
  priority: DerivedPriority | null;
  /**
   * What the agent runs on this Issue amount to (F23 FR-14, Decision 0006).
   *
   * The planning table sits above execution, and this is the one cell that looks down: it says
   * whether an agent is on the row, waiting for a person, or has failed. Null for a row with no
   * Tasks — which is not the same as a row whose Tasks are all done, and the cell draws them
   * differently.
   */
  tasks: RowTaskSummary | null;
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
  open: "[--badge-color:var(--scm-open)]",
  merged: "[--badge-color:var(--scm-merged)]",
  // Closed-unmerged stays grey: someone decided against it, which is a decision and not an
  // error, and painting it red would make the table editorialise about a deliberate choice.
  closed: "[--badge-color:var(--scm-draft)]",
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
 * Deliberately flat in tone. It is the provider's data contradicting itself, not SoloW
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
            "badge-soft inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-2xs tabular-nums hover:underline",
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
 * The nesting, the cycle refusal and the rollup are `@solow/core`'s, not this file's: they
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
/**
 * The reference's default column width (§1) — kept as the *maximum* an auto-sized column may
 * take, not as the width every column gets.
 *
 * GitHub gives every column 200px whatever it holds, so a Status column of five-letter words is
 * as wide as one holding a sentence. Sizing to content instead means a short column is short and
 * the space goes to the columns that need it; the cap is what stops one long cell deciding the
 * layout for everything to its right.
 */
export const AUTO_COLUMN_MAX_WIDTH = 260;
/** A floor, so a column is never narrower than its own header. */
export const AUTO_COLUMN_MIN_WIDTH = 72;

/**
 * The agent runs on a row, as one badge.
 *
 * The badge shows the state that most demands a person rather than the newest run — see
 * `summariseRowTasks`, where that rule and its reason live. The count sits beside it when there
 * is more than one, because a single badge over three Tasks would read as one Task.
 */
function RowTasks({ row }: { row: ProjectRow }) {
  // An empty cell, not a hidden column: "no agent has touched this" is an answer a planner came
  // for, and it is different from a row whose runs are finished.
  if (!row.tasks) return <span className="text-muted-foreground/40">—</span>;
  return (
    <span className="flex items-center gap-1.5">
      <TaskStateBadge state={row.tasks.state} size="sm" />
      {row.tasks.total > 1 && (
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {row.tasks.total}
        </span>
      )}
    </span>
  );
}

/**
 * The other end of the range this cell is one end of, or nothing.
 *
 * Nothing is the ordinary answer: most date fields are not one end of anything, and a project with
 * only a `Target date` gets a plain picker rather than one that talks about a start nobody set.
 */
function counterpartFor(
  row: ProjectRow,
  fieldId: string,
  range: { start: ProjectFieldDto | null; end: ProjectFieldDto | null },
): DateCounterpart | undefined {
  const dateOf = (field: ProjectFieldDto | null): string | null => {
    if (!field) return null;
    const value = row.item.values[field.id];
    return value?.type === "date" ? value.date : null;
  };
  if (range.start && range.end && fieldId === range.start.id) {
    return { name: range.end.name, date: dateOf(range.end), role: "start" };
  }
  if (range.start && range.end && fieldId === range.end.id) {
    return { name: range.start.name, date: dateOf(range.start), role: "end" };
  }
  return undefined;
}

/**
 * How a priority read off a label is spelled in the Priority column.
 *
 * Three things it deliberately does, in order of how much they matter:
 *
 *  1. It says where the value came from, in a `title` the operator can read. This is not a value
 *     the provider holds, and a column that silently filled itself in would be the table telling
 *     a team something nobody put there.
 *  2. It keeps the unset styling around it — the cell's dashed edge is drawn by `SelectCell` for
 *     a row with no value, and that stays true.
 *  3. A native `title`, not a `Tooltip`: this renders **inside** the select cell's trigger button,
 *     and a `TooltipTrigger` there would nest a button inside a button.
 *
 * The colour is the **label's own**, from the provider's vocabulary — the same hue the chip in
 * the Labels column carries, because it is the same label. Not a scale invented here: the theme's
 * `--state-*` tokens are deliberately achromatic (the neutral shadcn palette), so a rank-to-hue
 * table would have rendered four identical greys, and a fourth palette beside the diff, the SCM
 * states and the provider labels is one more colour language than this product has room for.
 */
function DerivedPriorityBadge({
  priority,
  color,
}: {
  priority: DerivedPriority;
  color?: string | null | undefined;
}) {
  const hex = labelColour(color);
  return (
    <span
      className="badge-soft inline-flex h-4 shrink-0 items-center rounded-full border px-1.5 font-semibold text-2xs"
      style={hex ? ({ "--badge-color": hex } as React.CSSProperties) : undefined}
      title={`Read from the label \u201C${priority.label}\u201D. This project's Priority field holds no value for this row.`}
    >
      {priority.name}
    </span>
  );
}

/**
 * How many labels a row shows before it counts the rest.
 *
 * Overflow is counted, never dropped: an issue carrying six labels in a cell that fits two is
 * still a six-label issue, and a row that silently showed half would answer "what is this tagged
 * with" wrongly.
 */
const MAX_VISIBLE_LABELS = 2;

/**
 * The Issue's labels, in the colours their repository gives them (§7).
 *
 * `colours` is the vocabulary read from the providers — a label the vocabulary does not name
 * renders neutral rather than guessing, which is the same rule the single-select tokens follow.
 */
function RowLabels({
  labels,
  colours,
}: {
  labels: string[];
  colours?: Readonly<Record<string, string | null>> | undefined;
}) {
  if (labels.length === 0) return null;
  const shown = labels.slice(0, MAX_VISIBLE_LABELS);
  const overflow = labels.length - shown.length;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {shown.map((name) => (
        <IssueLabel key={name} name={name} color={colours?.[name]} />
      ))}
      {overflow > 0 && (
        // The ones that did not fit, on hover — as labels, not as a comma-joined `title` string.
        // A row carrying eight labels shows two and a number, and the number is only useful if
        // the rest are one gesture away in the form they are drawn everywhere else.
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="shrink-0 cursor-default rounded px-1 font-mono text-2xs text-muted-foreground/60 hover:bg-accent hover:text-foreground">
              +{overflow}
            </span>
          </TooltipTrigger>
          <TooltipContent className="max-w-64">
            <span className="flex flex-wrap gap-1">
              {labels.slice(MAX_VISIBLE_LABELS).map((name) => (
                <IssueLabel key={name} name={name} color={colours?.[name]} />
              ))}
            </span>
          </TooltipContent>
        </Tooltip>
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
 * The same four glyphs *and* the same colours: green for open, purple for closed, grey for a row
 * with no provider issue behind it. Shape still carries the distinction on its own — which is why
 * these were the right icons to borrow — and the colour is now what makes a column of them
 * scannable at a glance.
 *
 * Their own tokens (`--scm-*`), not the Task lifecycle's greys and not the diff's red/green: this
 * says what the *provider* says about an issue, which is a third unrelated fact. Sharing a token
 * with either would recouple them the next time one changes.
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
            <CircleDashed aria-hidden className="size-4 text-scm-draft" />
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
          <Icon
            aria-hidden
            className={cn("size-4", closed ? "text-scm-closed" : "text-scm-open")}
          />
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
 * The grab strip on a column's trailing edge (§6, "colonnes redimensionnables").
 *
 * Pointer events rather than a drag-and-drop library: a resize is one pointer following one axis,
 * and `setPointerCapture` keeps the drag alive when the cursor outruns the 4px strip — which it
 * always does. A DnD library would also fight the header's own drag-to-reorder, since both would
 * claim the same gesture on the same element.
 *
 * Double-click fits the column to its content, which is the gesture every spreadsheet has taught
 * and the only way back from a width dragged too small to read.
 */
function ResizeHandle({
  onResize,
  onAutoFit,
  label,
}: {
  onResize: (width: number) => void;
  onAutoFit: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      aria-label={`Resize ${label}`}
      // A button so it is focusable and named; the keyboard path is the arrow keys below, because
      // a resize that only a mouse can reach is a column a keyboard user cannot fix.
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const header = event.currentTarget.closest("th");
        if (!header) return;
        const startX = event.clientX;
        const startWidth = header.getBoundingClientRect().width;
        event.currentTarget.setPointerCapture(event.pointerId);

        const move = (moved: PointerEvent) => onResize(startWidth + (moved.clientX - startX));
        const done = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", done);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", done);
      }}
      onDoubleClick={(event) => {
        event.stopPropagation();
        onAutoFit();
      }}
      onKeyDown={(event) => {
        const header = event.currentTarget.closest("th");
        if (!header) return;
        const width = header.getBoundingClientRect().width;
        // 16px a press, which is a visible change without being a jump.
        if (event.key === "ArrowLeft") onResize(width - 16);
        if (event.key === "ArrowRight") onResize(width + 16);
        if (event.key === "Enter") onAutoFit();
      }}
      className="-mr-1 absolute inset-y-0 right-0 w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-ring/40 focus-visible:bg-ring/60"
    />
  );
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
}: {
  label: string;
  sortKey: string;
  sort: { field: string; direction: "asc" | "desc" } | null;
  onSort?: ((field: string) => void) | undefined;
  align?: "start" | "end";
}) {
  const active = sort?.field === sortKey;
  const body = (
    <>
      {/*
       * `whitespace-nowrap`, not `truncate`.
       *
       * A truncated header can shrink below its own text, and with content-sized columns that is
       * exactly what happens to a column whose cells are empty: the browser sizes it to the `—`
       * and the header clips to "Priori…". A header that cannot shrink contributes its full width
       * to the column's natural size, so the column is at least as wide as its own name — bounded
       * above by the cap, so a long field name still cannot run away with the layout.
       */}
      <span className="whitespace-nowrap">{label}</span>
      {active ? (
        sort?.direction === "asc" ? (
          <ArrowUp aria-hidden className="size-3 shrink-0" />
        ) : (
          <ArrowDown aria-hidden className="size-3 shrink-0" />
        )
      ) : (
        onSort && (
          /*
           * A ghost arrow, visible only on hover.
           *
           * Sorting used to be reachable from a `Sort by` menu in the toolbar; the header is the
           * only way now, and a control whose only affordance is a background tint on hover is
           * one nobody discovers. The arrow occupies its space whether or not it is shown — with
           * `opacity` rather than `hidden` — so a header does not jump sideways as the pointer
           * crosses it, and it says which direction the first click gives you.
           */
          <ArrowUp
            aria-hidden
            className="size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-40"
          />
        )
      )}
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
      /*
       * Says what the click does, not merely what the column is.
       *
       * The button's accessible name is the column's name, which is right — but a header that is
       * also a three-state control has to state the state and the next step somewhere, and
       * `aria-sort` on the `<th>` only carries the first half.
       */
      title={sortHint(label, active ? (sort?.direction ?? null) : null)}
      onClick={() => onSort(sortKey)}
      className={cn(shape, "group/sort -mx-1 rounded px-1 py-0.5 hover:bg-accent/60")}
    >
      {body}
    </button>
  );
}

/** What the next click on this header will do — the third state included. */
function sortHint(label: string, direction: "asc" | "desc" | null): string {
  if (direction === null) return `Sort by ${label}`;
  return direction === "asc" ? `Sort by ${label}, descending` : `Clear the sort on ${label}`;
}

/**
 * One drawn line of the body, memoized (issue #126 AC-6, second half).
 *
 * "Re-render only rows whose values changed" is not something a table gets for free once it draws
 * fewer rows: scrolling changes state on the table, so without this every row still on screen
 * re-renders on every frame of a wheel gesture — a hundred context menus and editable cells
 * rebuilt to move the viewport by forty pixels.
 *
 * Which makes the prop list the load-bearing part. Everything here is either a value the row owns
 * or something the table holds still across renders (`useMemo`ed lookups, `useCallback`ed
 * handlers). The two that would otherwise defeat the memo are broken out deliberately:
 * `isExpanded` rather than the expanded set, and `onToggle` taking the id — a set and a
 * `setState` closure both change identity whenever any row opens, which would re-render all of
 * them.
 */
/** One drawn line of the body: the heading of a group, or one row of the hierarchy. */
type BodyLine =
  | {
      kind: "group";
      key: string;
      label: string;
      nodes: ProjectTreeNode<NestableProjectRow>[];
    }
  | { kind: "row"; entry: FlatProjectRow<NestableProjectRow> };

const BodyRow = memo(function BodyRow({
  row,
  depth,
  hasChildren,
  rollup,
  inCycle,
  isExpanded,
  onToggle,
  columns,
  widths,
  labelColours,
  priorityChoices,
  dateRange,
  today,
  pendingCells,
  onEdit,
  onOpenRow,
  onSetPriority,
  onStartTask,
}: {
  row: NestableProjectRow;
  depth: number;
  hasChildren: boolean;
  rollup: ProjectRollup | null;
  inCycle: boolean;
  isExpanded: boolean;
  onToggle: (itemId: string) => void;
  columns: readonly ProjectFieldDto[];
  widths: Readonly<Record<string, number>> | undefined;
  labelColours: Readonly<Record<string, string | null>> | undefined;
  priorityChoices: readonly PriorityChoice[] | undefined;
  dateRange: { start: ProjectFieldDto | null; end: ProjectFieldDto | null };
  today: string;
  pendingCells: readonly string[];
  onEdit?:
    | ((row: ProjectRow, field: ProjectFieldDto, value: ProjectFieldValue | null) => void)
    | undefined;
  onOpenRow?: ((row: ProjectRow) => void) | undefined;
  onSetPriority?: ((row: ProjectRow, label: string | null) => void) | undefined;
  onStartTask?: ((row: ProjectRow) => void) | undefined;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow className="hover:bg-accent/30" style={{ height: ROW_HEIGHT }}>
          {/*
            The issue's own number — see the header for why it is not an
            ordinal — and the way out to the provider.

            The number is the one thing on this row that means something *there*
            rather than here, so it is what links there. The title opens the
            panel inside SoloW. Two destinations, two controls, rather than
            one that guesses which you meant.
          */}
          <TableCell className="w-16 px-2 text-right align-middle font-mono text-2xs text-muted-foreground/60 tabular-nums">
            {row.issueNumber === null ? (
              ""
            ) : row.issueUrl ? (
              <a
                href={row.issueUrl}
                target="_blank"
                rel="noreferrer"
                title={`Open #${row.issueNumber} on the provider`}
                className="hover:text-foreground hover:underline"
              >
                #{row.issueNumber}
              </a>
            ) : (
              `#${row.issueNumber}`
            )}
          </TableCell>
          <TableCell className="max-w-[460px] px-3 py-0 align-middle">
            {/* Indented rather than drawn as a separate table per epic: one column of
          titles stays scannable, and a child keeps every one of its own cells. */}
            <span className="flex min-w-0 items-center gap-2" style={{ paddingLeft: depth * 16 }}>
              {hasChildren ? (
                <button
                  type="button"
                  aria-expanded={isExpanded}
                  aria-label={`${isExpanded ? "Collapse" : "Expand"} ${row.title}`}
                  onClick={() => onToggle(row.item.id)}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  {isExpanded ? (
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
            </span>
          </TableCell>
          <TableCell className="px-3 py-0 align-middle">
            <RowTasks row={row} />
          </TableCell>
          <TableCell className="px-3 py-0 align-middle">
            <LinkedChanges row={row} />
          </TableCell>
          <TableCell className="max-w-[260px] px-3 py-0 align-middle">
            <RowLabels labels={row.labels} colours={labelColours} />
          </TableCell>
          {/* Counted from what is closed on the provider, never from a Status
              column (AC-2 / AC-3), and across every repository the children
              live in (AC-4). Its own column now rather than crowding the title
              — a bar and a title competing for one cell made both harder to
              read. */}
          <TableCell className="px-3 py-0 align-middle">
            {rollup ? (
              <SubIssueProgress done={rollup.done} total={rollup.total} />
            ) : (
              <span className="text-muted-foreground/40">—</span>
            )}
          </TableCell>
          {columns.map((field) => (
            <TableCell
              key={field.id}
              className="px-3 py-0 align-middle"
              // The same exact width as the header, or the two disagree and the
              // widest cell wins — the browser sizing the column instead of the
              // person who dragged it.
              style={
                widths?.[field.id]
                  ? {
                      width: widths[field.id],
                      minWidth: widths[field.id],
                      maxWidth: widths[field.id],
                    }
                  : { maxWidth: AUTO_COLUMN_MAX_WIDTH }
              }
            >
              {/*
                A Priority column the provider gave no options is not a control
                that can be repaired by disabling it: the priority is on the
                issue, in a label, and that is what the operator has to be able
                to change. Where the field *does* have options it is the
                authority and the ordinary cell is right.
              */}
              {isPriorityFieldName(field.name) && field.options.length === 0 && onSetPriority ? (
                <PriorityCell
                  current={row.priority}
                  choices={priorityChoices ?? []}
                  rowTitle={row.title}
                  onPick={(label) => onSetPriority(row, label)}
                  pending={pendingCells.includes(`${row.item.id}:${field.id}`)}
                />
              ) : (
                <ProjectCell
                  field={field}
                  value={row.item.values[field.id]}
                  rowTitle={row.title}
                  fallback={
                    isPriorityFieldName(field.name) && row.priority ? (
                      <DerivedPriorityBadge
                        priority={row.priority}
                        color={labelColours?.[row.priority.label]}
                      />
                    ) : undefined
                  }
                  onEdit={
                    field.readOnly || !onEdit ? undefined : (value) => onEdit(row, field, value)
                  }
                  counterpart={counterpartFor(row, field.id, dateRange)}
                  today={today}
                  pending={pendingCells.includes(`${row.item.id}:${field.id}`)}
                />
              )}
            </TableCell>
          ))}
        </TableRow>
      </ContextMenuTrigger>
      <RowMenu row={row} onOpenRow={onOpenRow} onStartTask={onStartTask} />
    </ContextMenu>
  );
});

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
  widths,
  columnOrder,
  labelColours,
  priorityChoices,
  today,
  onSetPriority,
  onResize,
  onReorder,
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
  /** Stored pixel widths by field id. A field absent from it sizes to its content. */
  widths?: Readonly<Record<string, number>> | undefined;
  /** The person's saved column order. Partial: anything unnamed keeps its own place, behind. */
  columnOrder?: readonly string[] | undefined;
  /** The provider's label vocabulary, so a label is the same colour here as in the drawer. */
  labelColours?: Readonly<Record<string, string | null>> | undefined;
  /**
   * The priority labels this workspace's repositories define, most urgent first.
   *
   * Handed in rather than derived here: the vocabulary is a property of the repositories and is
   * already fetched once for the whole table (see `labelColours`), and a column that computed its
   * own option list from the rows on screen would offer fewer choices the more a filter narrowed.
   */
  priorityChoices?: readonly PriorityChoice[] | undefined;
  /** The day relative dates resolve against. Defaulted from the clock; passed in by tests. */
  today?: string | undefined;
  /**
   * Write a priority by **label**, for the projects whose Priority field holds no options.
   *
   * Deliberately not routed through `onEdit`: that writes a project field value, and this writes a
   * label on the Issue. Two different writes to two different places, and collapsing them into one
   * callback is how a cell ends up sending a field value nobody can store.
   */
  onSetPriority?: ((row: ProjectRow, label: string | null) => void) | undefined;
  /** A column was dragged to a new width, or double-clicked to fit its content (null). */
  onResize?: ((fieldId: string, width: number | null) => void) | undefined;
  /** A column was dropped on another. The handler receives the complete new order. */
  onReorder?: ((fieldIds: string[]) => void) | undefined;
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
  /**
   * Held still across renders so `BodyRow`'s memo survives a scroll — a `setExpanded` closure
   * written inline is a new function on every frame, and a new function is a new prop.
   */
  const toggleExpanded = useCallback((itemId: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      // Delete-or-add: one statement of the toggle, so the chevron and the rows it reveals
      // cannot disagree about what "open" means.
      if (!next.delete(itemId)) next.add(itemId);
      return next;
    });
  }, []);

  /**
   * How tall the scrolling pane is and how far down it, which is the whole input to windowing
   * (F23 NFR-1, issue #126 AC-6).
   *
   * Both start at zero and mean "not measured yet", which `windowOf` reads as "draw everything" —
   * so the first paint is complete rather than empty, and narrows on the layout pass that follows.
   */
  const scroller = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState({ scrollTop: 0, height: 0 });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const measure = () =>
      setPane((current) =>
        // Compared before it is stored: a scroll event fires far more often than the numbers
        // change, and an unconditional `setState` would re-render the table for every one of them.
        current.scrollTop === element.scrollTop && current.height === element.clientHeight
          ? current
          : { scrollTop: element.scrollTop, height: element.clientHeight },
      );
    measure();
    element.addEventListener("scroll", measure, { passive: true });
    // Guarded rather than assumed: the pane is resized by the sidebar, by the window and by the
    // filter bar wrapping, and none of those fire a scroll — but a test environment has no
    // observer to give, and a table that threw there would be a table nothing could render.
    const observer =
      typeof ResizeObserver === "function" ? new ResizeObserver(() => measure()) : null;
    observer?.observe(element);
    return () => {
      element.removeEventListener("scroll", measure);
      observer?.disconnect();
    };
  }, []);

  /**
   * The column names this table owns, so a provider field carrying the same name can be told
   * apart from it.
   *
   * GitHub's projects ship a built-in `Title` field, and a project can carry a real value in it
   * that is *not* the issue's title — so the table legitimately shows two columns called Title
   * and a reader has no way to know which is which. Suffixing the provider's one is the smallest
   * honest fix: neither column is wrong, and hiding either would lose a fact.
   */
  const ownColumnNames = useMemo(
    () => new Set(["Title", "Agent runs", "Linked changes", "Labels", "Sub-issues"]),
    [],
  );

  const columns = useMemo(
    // Filtered first, then ordered: a hidden column must not occupy a slot in the arrangement,
    // or dragging one column past a hidden one would leave a gap nobody can see or fill.
    () =>
      orderColumns(
        project.fields.filter((f) => !hiddenFieldIds.includes(f.id)),
        columnOrder ?? [],
      ),
    [project.fields, hiddenFieldIds, columnOrder],
  );
  const groupField = useMemo(
    () => project.fields.find((f) => f.id === groupByFieldId && f.type === "single_select") ?? null,
    [project.fields, groupByFieldId],
  );

  /**
   * Which two date fields are the two ends of one range.
   *
   * Matched by name, the same way the Priority column is: `Start date` and `Target date` are what
   * GitHub Projects calls them, and a project whose dates are called something else simply gets two
   * independent pickers — which is correct, because nothing here knows that they are related.
   *
   * The pairing buys one thing: each end can show the other. It does **not** make them one control
   * (see `DateCounterpart`).
   */
  const dateRange = useMemo(() => {
    const normalise = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");
    const dates = project.fields.filter((f) => f.type === "date");
    return {
      start: dates.find((f) => normalise(f.name) === "startdate") ?? null,
      end:
        dates.find((f) => ["targetdate", "enddate", "duedate"].includes(normalise(f.name))) ?? null,
    };
  }, [project.fields]);

  /** Resolved once for the whole table, so every cell agrees which day today is. */
  const resolvedToday = useMemo(() => today ?? isoToday(new Date()), [today]);

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

  /**
   * The body as one flat list of lines — a group heading or a row — in the order they are drawn.
   *
   * This is what makes the table windowable: a viewport spans groups, so "which lines are on
   * screen" is only answerable once the groups have stopped being separate lists. It is also
   * where the filter is applied, exactly as it was when this lived in the JSX: the tree and its
   * arithmetic come from every row, and only what is *drawn* is narrowed.
   */
  const lines = useMemo(() => {
    const out: BodyLine[] = [];
    for (const group of groups) {
      if (groupField)
        out.push({ kind: "group", key: group.key, label: group.label, nodes: group.nodes });
      if (collapsed[group.key]) continue;
      for (const entry of flattenProjectHierarchy(group.nodes, expanded)) {
        // Drawn is the filter's answer; `rollup` on the entry is not filtered. A parent whose
        // child matched stays, because hiding it would hide the match.
        if (drawn !== null && !drawn.has(entry.row.item.id)) continue;
        out.push({ kind: "row", entry });
      }
    }
    return out;
  }, [groups, groupField, collapsed, expanded, drawn]);

  /**
   * The heights, from the measurements at the top of this file rather than from the DOM.
   *
   * Every row is `ROW_HEIGHT` and every heading `GROUP_HEADER_HEIGHT` because both are fixed in
   * the markup below — so there is nothing to measure, and no first paint spent measuring it.
   */
  const win: RowWindow = useMemo(
    () =>
      windowOf(
        lines.map((line) => (line.kind === "group" ? GROUP_HEADER_HEIGHT : ROW_HEIGHT)),
        pane.scrollTop,
        pane.height,
      ),
    [lines, pane],
  );

  // A local Project has, and will always have, zero fields — there is no provider board behind
  // it to have declared any (`projectDto.fields`'s own comment). That is not "not yet synced";
  // it is the permanent and correct state for the kind of Project this is, so the guard below
  // fires only for a mirrored Project waiting on its first sync.
  if (project.fields.length === 0 && project.source === "adopted") {
    return (
      <p className="px-4 py-6 text-muted-foreground text-sm">
        This project has no fields yet. Refresh to read them from the provider.
      </p>
    );
  }

  return (
    // One provider for the whole table rather than one per cell — see `ProjectCell`.
    <TooltipProvider>
      <div ref={scroller} className="min-h-0 flex-1 overflow-auto">
        <Table
          /*
           * `w-auto`, not the primitive's `w-full`.
           *
           * A full-width table distributes its slack across the columns, so every column is
           * *stretched* and none of them ends up the size of what it holds — which is the whole
           * of "auto width". Sized to content it is as wide as it needs to be, and the container
           * around it already scrolls horizontally for the case where that is wider than the pane.
           */
          className="w-auto text-xs"
        >
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
                // The title is the row's identifier and the one column worth a wider cap: a
                // sentence truncated at 260px is a title nobody can tell from its neighbour.
                className="px-3"
                style={{ height: COLUMN_HEADER_HEIGHT, minWidth: 220, maxWidth: 460 }}
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
              {/* SoloW's own two columns, kept together and ahead of the provider's
                  fields: both are facts about the Issue rather than columns the project defines,
                  so their position is ours to decide rather than the provider's. */}
              <TableHead className="px-3" style={{ height: COLUMN_HEADER_HEIGHT }}>
                Agent runs
              </TableHead>
              <TableHead className="px-3" style={{ height: COLUMN_HEADER_HEIGHT }}>
                Linked changes
              </TableHead>
              <TableHead className="px-3" style={{ height: COLUMN_HEADER_HEIGHT }}>
                Labels
              </TableHead>
              <TableHead className="px-3" style={{ height: COLUMN_HEADER_HEIGHT }}>
                Sub-issues
              </TableHead>
              {columns.map((field) => {
                const stored = widths?.[field.id];
                return (
                  <TableHead
                    key={field.id}
                    className="relative px-3"
                    style={{
                      height: COLUMN_HEADER_HEIGHT,
                      // A stored width is exact — `width` *and* both bounds, because a table cell
                      // treats `width` as a suggestion and grows past it otherwise, which is how a
                      // resized column springs back on the next render.
                      ...(stored
                        ? { width: stored, minWidth: stored, maxWidth: stored }
                        : { minWidth: AUTO_COLUMN_MIN_WIDTH, maxWidth: AUTO_COLUMN_MAX_WIDTH }),
                    }}
                    aria-sort={ariaSortFor(sort, field.id)}
                    /*
                     * Reordering by dragging the header itself (§6). Native HTML5 drag rather than a
                     * library: the gesture is one element dropped on another with no preview to
                     * render, and a library would also have to be told not to claim the resize strip
                     * living inside the same header.
                     */
                    draggable={Boolean(onReorder)}
                    onDragStart={(event) => {
                      event.dataTransfer.setData("text/plain", field.id);
                      event.dataTransfer.effectAllowed = "move";
                    }}
                    onDragOver={(event) => {
                      if (!onReorder) return;
                      // Without this the drop never fires — the default is to reject.
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const dragged = event.dataTransfer.getData("text/plain");
                      if (!dragged || !onReorder) return;
                      onReorder(
                        moveColumn(
                          columns.map((c) => c.id),
                          dragged,
                          field.id,
                        ),
                      );
                    }}
                  >
                    <SortableHeader
                      label={
                        ownColumnNames.has(field.name) ? `${field.name} (project)` : field.name
                      }
                      sortKey={field.id}
                      sort={sort ?? null}
                      onSort={onSort}
                      align={field.type === "number" ? "end" : "start"}
                    />
                    {onResize && (
                      <ResizeHandle
                        label={field.name}
                        onResize={(width) => onResize(field.id, clampWidth(width))}
                        onAutoFit={() => onResize(field.id, null)}
                      />
                    )}
                  </TableHead>
                );
              })}
            </TableRow>
          </TableHeader>
          <TableBody>
            {/*
              One `tbody` for the whole table, not one per group.

              A window spans groups — the top of the viewport can sit in `In progress` while the
              bottom is already in `Done` — so the drawn lines have to be one list before they can
              be sliced. The group headings are lines in it, which is also why `windowOf` walks
              the heights instead of dividing by one: a heading is taller than a row.
            */}
            {win.padTop > 0 && (
              // The lines above the window, as height and nothing else. `aria-hidden` keeps it out
              // of the accessibility tree, where a spacer would otherwise be announced as a row.
              <tr aria-hidden style={{ height: win.padTop }} />
            )}
            {lines.slice(win.from, win.to).map((line) =>
              line.kind === "group" ? (
                <TableRow key={`group:${line.key}`} className="bg-card hover:bg-card">
                  <TableHead
                    colSpan={columns.length + 6}
                    className="px-2 text-left font-medium text-2xs"
                    style={{ height: GROUP_HEADER_HEIGHT }}
                  >
                    <button
                      type="button"
                      aria-expanded={!collapsed[line.key]}
                      onClick={() =>
                        setCollapsed((c) => ({ ...c, [line.key]: !collapsed[line.key] }))
                      }
                      className="inline-flex items-center gap-1.5"
                    >
                      {collapsed[line.key] ? (
                        <ChevronRight aria-hidden className="size-3" />
                      ) : (
                        <ChevronDown aria-hidden className="size-3" />
                      )}
                      {/* The option dot of §6, neutral like every other token here: it marks
                          the heading as a value of the grouped field, not a section title. */}
                      <span
                        aria-hidden
                        className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                      />
                      <span className="font-semibold text-sm tracking-tight">{line.label}</span>
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
                      <span className="badge-soft inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full border px-1.5 font-semibold text-2xs [--badge-color:var(--muted-foreground)] tabular-nums">
                        {countProjectRows(line.nodes, (row) => visible.has(row.id))}
                      </span>
                    </button>
                  </TableHead>
                </TableRow>
              ) : (
                <BodyRow
                  key={line.entry.row.item.id}
                  row={line.entry.row}
                  depth={line.entry.depth}
                  hasChildren={line.entry.hasChildren}
                  rollup={line.entry.rollup}
                  inCycle={line.entry.inCycle}
                  isExpanded={expanded.has(line.entry.row.item.id)}
                  onToggle={toggleExpanded}
                  columns={columns}
                  widths={widths}
                  labelColours={labelColours}
                  priorityChoices={priorityChoices}
                  dateRange={dateRange}
                  today={resolvedToday}
                  pendingCells={pendingCells}
                  onEdit={onEdit}
                  onOpenRow={onOpenRow}
                  onSetPriority={onSetPriority}
                  onStartTask={onStartTask}
                />
              ),
            )}
            {win.padBottom > 0 && <tr aria-hidden style={{ height: win.padBottom }} />}
          </TableBody>
        </Table>
      </div>
    </TooltipProvider>
  );
}
