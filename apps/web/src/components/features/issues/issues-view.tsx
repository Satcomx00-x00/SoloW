"use client";

import type { IssueDto, IssueSource, IssueStatus } from "@solow/contracts";
import { CommonErrorCode, issueSourceSchema } from "@solow/contracts";
import { buildProjectHierarchy } from "@solow/core";
import { ChevronRight, ListFilter, Search, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { IssueLabel } from "@/components/features/project/issue-label";
import { useProviderNames } from "@/components/hooks/use-provider-names";
import { useEventStream } from "@/components/hooks/use-task-stream";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
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
import {
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_STYLE,
  ISSUE_STATUSES,
  issueSourceLabel,
} from "@/lib/issue-status";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The Issues section (spec F01).
 *
 * An Issue is the unit of intent — the thing you actually want done — and Tasks are the slices
 * of it handed to agents. Until now it existed only as a row in a create dialog and a foreign
 * key on a Task, so there was no way to ask "what am I working on, and how far along is it".
 *
 * Status is derived from the Issue's Tasks (`deriveIssueStatus`), so this list is a read of the
 * board rolled up one level, not a second place to keep state in step — unless someone has set
 * a status by hand, which `issue.setStatus` records and the detail view explains.
 *
 * Every filter lives in the URL (FR-2). That is what makes a narrowed list a thing you can send
 * to someone, reload, or reach with the back button — and it keeps this component free of
 * filter state that could disagree with what the address bar says.
 */

/** `?source=` values, plus the "no filter" entry the Select needs a real value for. */
const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "local", label: "Local" },
  { value: "github", label: "GitHub" },
  { value: "gitlab", label: "GitLab" },
] as const;

export interface IssueFilters {
  status: IssueStatus | null;
  query: string;
  labels: string[];
  source: IssueSource | null;
}

export function readFilters(params: URLSearchParams): IssueFilters {
  const status = params.get("status");
  const source = params.get("source");
  return {
    status: ISSUE_STATUSES.includes(status as IssueStatus) ? (status as IssueStatus) : null,
    query: params.get("q") ?? "",
    labels: params.getAll("label"),
    // Validated against the *grammar*, not against a list of three ids. Decision 0016 opened
    // `issueSourceSchema` for exactly this reason: a Workspace with a Gitea integration would
    // otherwise have its source filter silently dropped here, which is the failure F21 FR-7
    // describes — an unfamiliar provider costing a feature rather than a badge.
    source: issueSourceSchema.safeParse(source).success ? (source as IssueSource) : null,
  };
}

export function toSearchParams(filters: IssueFilters): string {
  const next = new URLSearchParams();
  if (filters.status) next.set("status", filters.status);
  if (filters.query) next.set("q", filters.query);
  if (filters.source) next.set("source", filters.source);
  for (const label of filters.labels) next.append("label", label);
  const query = next.toString();
  return query ? `/issues?${query}` : "/issues";
}

function StatusFilter({ filters }: { filters: IssueFilters }) {
  const tab = (status: IssueStatus | null, label: string) => (
    <Link
      key={label}
      href={toSearchParams({ ...filters, status })}
      scroll={false}
      aria-current={filters.status === status ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm transition-colors",
        filters.status === status
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tab(null, "All")}
      {ISSUE_STATUSES.map((status) => tab(status, ISSUE_STATUS_LABELS[status]))}
    </div>
  );
}

type Apply = (next: Partial<IssueFilters>) => void;

/**
 * Search, labels and source. The search box keeps its own state and pushes to the URL on a
 * pause, rather than on every keystroke: a router replace per character would re-run the query
 * mid-word and fight the cursor.
 */
function FilterBar({
  filters,
  apply,
  labels,
  labelsKnownEmpty,
}: {
  filters: IssueFilters;
  apply: Apply;
  labels: string[];
  labelsKnownEmpty: boolean;
}) {
  const [text, setText] = useState(filters.query);

  // The URL is the source of truth, so a filter cleared from anywhere else (the Clear button,
  // the back button) has to reach this input too.
  useEffect(() => setText(filters.query), [filters.query]);

  useEffect(() => {
    if (text === filters.query) return;
    const timer = setTimeout(() => apply({ query: text }), 250);
    return () => clearTimeout(timer);
  }, [text, filters.query, apply]);

  const toggleLabel = (label: string) =>
    apply({
      labels: filters.labels.includes(label)
        ? filters.labels.filter((l) => l !== label)
        : [...filters.labels, label],
    });

  const filtered = filters.query || filters.labels.length > 0 || filters.source;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <div className="relative min-w-56 flex-1">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted-foreground/70"
          aria-hidden
        />
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Search title, description or #number"
          aria-label="Search issues"
          className="pl-8"
        />
      </div>

      {/* No labels anywhere in the Workspace means nothing to filter by — an empty menu would
          only be a thing to click and regret. Hidden only once that is *known*, though: dropping
          the button while the vocabulary loads made the rest of the bar jump sideways on every
          page load. */}
      {!labelsKnownEmpty && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8">
              <ListFilter aria-hidden />
              Labels
              {filters.labels.length > 0 && (
                <span className="font-mono text-2xs tabular-nums">{filters.labels.length}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="max-h-72 w-56">
            {labels.map((label) => (
              <DropdownMenuCheckboxItem
                key={label}
                checked={filters.labels.includes(label)}
                onCheckedChange={() => toggleLabel(label)}
                onSelect={(event) => event.preventDefault()}
              >
                {label}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <Select
        value={filters.source ?? "all"}
        onValueChange={(value) =>
          apply({ source: value === "all" ? null : (value as IssueSource) })
        }
      >
        <SelectTrigger className="w-32" aria-label="Filter by source">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {SOURCE_FILTERS.map((s) => (
            <SelectItem key={s.value} value={s.value}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {filtered && (
        <Button
          variant="ghost"
          size="sm"
          className="h-8 text-muted-foreground"
          onClick={() => apply({ query: "", labels: [], source: null })}
        >
          <X aria-hidden /> Clear
        </Button>
      )}
    </div>
  );
}

/**
 * Order the list so a sub-issue only ever appears **under its epic**, never beside it.
 *
 * A flat list showed every child of an epic as a peer of its own parent — six rows that read as
 * six independent pieces of work when they are one. Someone planning from that list counts the
 * epic and its children as seven things instead of one.
 *
 * The tree comes from `buildProjectHierarchy`, the same function the project table uses, so the
 * two surfaces cannot disagree about what nests under what — including its refusals: a parent
 * chain that loops is dropped to the top level rather than recursed into, and a child whose epic
 * is not in this list stays visible at the top level rather than vanishing with it.
 *
 * Always expanded here. The table collapses because it is a planning grid where an epic's rows
 * are noise until asked for; a list is read top to bottom, and a chevron hiding half of it would
 * be a filter nobody applied.
 */
export function nestIssues(issues: readonly IssueDto[]): Array<{ issue: IssueDto; depth: number }> {
  const byId = new Map(issues.map((i) => [i.id, i]));
  const roots = buildProjectHierarchy(
    issues.map((issue) => ({
      id: issue.id,
      externalId: issue.externalId,
      parentExternalId: issue.externalParentId,
      repositoryId: issue.repositoryId,
      // The hierarchy helper counts closed children for a rollup this list does not draw; the
      // status is still the honest answer to "is this closed".
      closed: issue.status === "closed",
    })),
  );

  const flat: Array<{ issue: IssueDto; depth: number }> = [];
  const walk = (
    nodes: ReadonlyArray<{ row: { id: string }; children: unknown[] }>,
    depth: number,
  ) => {
    for (const node of nodes) {
      const issue = byId.get(node.row.id);
      if (issue) flat.push({ issue, depth });
      walk(node.children as typeof nodes, depth + 1);
    }
  };
  walk(roots as never, 0);
  return flat;
}

function IssueRow({
  issue,
  depth = 0,
  colours,
}: {
  issue: IssueDto;
  depth?: number;
  /** The provider's own label colours, absent while they are still being fetched. */
  colours?: Record<string, string | null> | undefined;
}) {
  const { icon: Icon, text } = ISSUE_STATUS_STYLE[issue.status];
  return (
    <li>
      <Link
        href={`/issues/${issue.id}`}
        // Indented rather than drawn in a nested list: one column of titles stays scannable, and
        // the indent is the whole signal that this row belongs to the one above it.
        style={depth > 0 ? { marginLeft: depth * 24 } : undefined}
        className="group flex items-start gap-3 rounded-lg border bg-card px-3.5 py-3 transition-all duration-150 hover:-translate-y-px hover:border-ring/35 hover:shadow-panel"
      >
        <Icon aria-hidden strokeWidth={2.25} className={cn("mt-0.5 size-4 shrink-0", text)} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium text-sm">
            {issue.externalNumber !== null && (
              <span className="mr-1.5 font-mono text-muted-foreground text-xs">
                #{issue.externalNumber}
              </span>
            )}
            {issue.title}
          </p>
          {issue.description && (
            <p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">{issue.description}</p>
          )}
          {issue.labels.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1">
              {issue.labels.map((label) => (
                <IssueLabel key={label} name={label} color={colours?.[label]} />
              ))}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 pt-0.5">
          <span className="text-2xs text-muted-foreground tabular-nums">
            {issue.taskCount === 1 ? "1 task" : `${issue.taskCount} tasks`}
          </span>
          <span className={cn("text-2xs", text)}>{ISSUE_STATUS_LABELS[issue.status]}</span>
          <ChevronRight
            aria-hidden
            className="size-3.5 text-muted-foreground/40 transition-colors group-hover:text-muted-foreground"
          />
        </div>
      </Link>
    </li>
  );
}

/**
 * The issue list, scoped to where it is mounted.
 *
 * See `Board` for why the scope is a prop rather than something the view reads from the URL
 * itself: the route already knows which Project it is, and a second reader of the same fact is a
 * second chance for the two to disagree.
 */
export function IssuesView({
  projectId,
  unassigned,
}: {
  projectId?: string | undefined;
  unassigned?: boolean | undefined;
} = {}) {
  const providerName = useProviderNames();
  const router = useRouter();
  const params = useSearchParams();
  const filters = readFilters(new URLSearchParams(params.toString()));

  const apply: Apply = (next) =>
    router.replace(toSearchParams({ ...filters, ...next }), { scroll: false });

  const issues = trpc.issue.list.useQuery({
    ...WHOLE_PAGE,
    ...(projectId ? { projectId } : {}),
    ...(unassigned ? { unassigned: true } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.labels.length > 0 ? { labels: filters.labels } : {}),
  });
  // The whole vocabulary, not the labels of what survived the current filter — otherwise
  // choosing one label would delete every other option from the menu that offered it.
  const labels = trpc.issue.labels.useQuery({});
  /*
   * The same vocabulary the project table paints with, asked for the same way. A label is the
   * provider's, and a list that greys out what the table colours would read as two different
   * label systems rather than one seen twice.
   */
  const labelVocabulary = trpc.issue.labelColors.useQuery({});
  const labelColours = useMemo(
    () => Object.fromEntries((labelVocabulary.data ?? []).map((l) => [l.name, l.color])),
    [labelVocabulary.data],
  );
  const utils = trpc.useUtils();

  /**
   * The same reasoning as the Issue page: a status here is derived from Tasks, and a Task that
   * finishes elsewhere changes what this list says about the Issue above it — its status, and
   * how many of its Tasks are still active.
   */
  const onStatus = useCallback(() => {
    utils.issue.list.invalidate();
  }, [utils]);
  useEventStream({ onEvent: onStatus });

  const narrowed = Boolean(
    filters.status || filters.query || filters.labels.length || filters.source,
  );

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-5">
      <div className="space-y-3">
        <StatusFilter filters={filters} />
        <FilterBar
          filters={filters}
          apply={apply}
          labels={labels.data ?? []}
          labelsKnownEmpty={labels.isSuccess && labels.data.length === 0}
        />
      </div>

      {issues.isLoading && (
        <ul className="space-y-2" aria-hidden>
          {[0, 1, 2].map((row) => (
            <li key={row} className="h-[62px] animate-pulse rounded-lg border bg-card" />
          ))}
        </ul>
      )}

      {issues.error &&
        (issues.error.message === CommonErrorCode.FlagDisabled ? (
          <div className="space-y-3 py-10" role="alert">
            <h2 className="font-medium text-sm">The core program is not enabled here</h2>
            <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
              Feature flags ship off. Enable it from the machine running this instance:
            </p>
            <pre className="w-fit rounded-lg border bg-card px-3 py-2 font-mono text-xs">
              bun run flag enable ff-core-program
            </pre>
          </div>
        ) : (
          <div className="flex items-start gap-2.5 py-10 text-sm" role="alert">
            <TriangleAlert className="mt-px size-4 shrink-0 text-state-failed" aria-hidden />
            <div>
              <p className="font-medium">Failed to load issues</p>
              <p className="mt-0.5 font-mono text-xs text-muted-foreground">
                {issues.error.message}
              </p>
            </div>
          </div>
        ))}

      {issues.isSuccess &&
        (issues.data.items.length === 0 ? (
          <div className="space-y-2 py-10">
            <h2 className="font-medium text-sm">
              {narrowed ? "Nothing matches these filters" : "No issues yet"}
            </h2>
            <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
              {narrowed
                ? "Widen the search, or clear the filters to see everything."
                : "An issue describes what you want done. Tasks under it are the slices you hand to an agent."}
            </p>
          </div>
        ) : (
          <>
            {narrowed && (
              <p className="text-muted-foreground text-xs">
                {issues.data.items.length === 1 ? "1 issue" : `${issues.data.items.length} issues`}
                {filters.source
                  ? ` · ${issueSourceLabel(filters.source, providerName(filters.source))}`
                  : ""}
              </p>
            )}
            <ul className="space-y-2">
              {nestIssues(issues.data.items).map(({ issue, depth }) => (
                <IssueRow key={issue.id} issue={issue} depth={depth} colours={labelColours} />
              ))}
            </ul>
          </>
        ))}
    </div>
  );
}
