"use client";

import type { IssueDto, IssueSource, IssueStatus } from "@gatecontrol/contracts";
import { CommonErrorCode } from "@gatecontrol/contracts";
import { ChevronRight, ListFilter, Search, TriangleAlert, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
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
  ISSUE_SOURCE_LABELS,
  ISSUE_STATUS_LABELS,
  ISSUE_STATUS_STYLE,
  ISSUE_STATUSES,
} from "@/lib/issue-status";
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
    source: source === "local" || source === "github" || source === "gitlab" ? source : null,
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

function IssueRow({ issue }: { issue: IssueDto }) {
  const { icon: Icon, text } = ISSUE_STATUS_STYLE[issue.status];
  return (
    <li>
      <Link
        href={`/issues/${issue.id}`}
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
                <Badge key={label} variant="secondary" className="text-2xs">
                  {label}
                </Badge>
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

export function IssuesView() {
  const router = useRouter();
  const params = useSearchParams();
  const filters = readFilters(new URLSearchParams(params.toString()));

  const apply: Apply = (next) =>
    router.replace(toSearchParams({ ...filters, ...next }), { scroll: false });

  const issues = trpc.issue.list.useQuery({
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.query ? { query: filters.query } : {}),
    ...(filters.source ? { source: filters.source } : {}),
    ...(filters.labels.length > 0 ? { labels: filters.labels } : {}),
  });
  // The whole vocabulary, not the labels of what survived the current filter — otherwise
  // choosing one label would delete every other option from the menu that offered it.
  const labels = trpc.issue.labels.useQuery({});

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
        (issues.data.length === 0 ? (
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
                {issues.data.length === 1 ? "1 issue" : `${issues.data.length} issues`}
                {filters.source ? ` · ${ISSUE_SOURCE_LABELS[filters.source]}` : ""}
              </p>
            )}
            <ul className="space-y-2">
              {issues.data.map((issue) => (
                <IssueRow key={issue.id} issue={issue} />
              ))}
            </ul>
          </>
        ))}
    </div>
  );
}
