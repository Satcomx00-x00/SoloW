"use client";

import type { IssueStatus, TaskState } from "@gatecontrol/contracts";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE, ISSUE_STATUSES } from "@/lib/issue-status";
import { sectionFor } from "@/lib/navigation";
import { BOARD_COLUMNS, STATE_LABELS, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

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
  href?: string;
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

/** Board context: live per-state task counts. */
function BoardNav() {
  const tasks = trpc.task.list.useQuery({});
  const rows = tasks.data ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, t) => {
    acc[t.state] = (acc[t.state] ?? 0) + 1;
    return acc;
  }, {});

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
          />
        ))}
      </ul>
    </nav>
  );
}

/** Issues context: counts per status, each row filtering the list. */
function IssuesNav() {
  const issues = trpc.issue.list.useQuery({});
  const rows = issues.data ?? [];
  const counts = rows.reduce<Record<string, number>>((acc, i) => {
    acc[i.status] = (acc[i.status] ?? 0) + 1;
    return acc;
  }, {});

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
        <CountRow
          icon={AllIcon}
          label="All issues"
          count={rows.length}
          tone="text-foreground/70"
          href="/issues"
        />
        {ISSUE_STATUSES.map((status: IssueStatus) => (
          <CountRow
            key={status}
            icon={ISSUE_STATUS_STYLE[status].icon}
            label={ISSUE_STATUS_LABELS[status]}
            count={counts[status] ?? 0}
            tone={ISSUE_STATUS_STYLE[status].text}
            href={`/issues?status=${status}`}
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

const SETTINGS_SECTIONS = [
  { id: "secrets", label: "Secrets" },
  { id: "agent-profiles", label: "Agent profiles" },
  { id: "executor-profiles", label: "Executor profiles" },
  { id: "repositories", label: "Repositories" },
];

/** Settings context: anchors to the configuration sections. */
function SettingsNav() {
  return (
    <nav className="pb-3" aria-label="Settings sections">
      <SectionLabel>Configuration</SectionLabel>
      <ul className="space-y-px px-2">
        {SETTINGS_SECTIONS.map((s) => (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              className="block rounded-md px-2 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-sidebar-accent/60 hover:text-foreground"
            >
              {s.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}

/** VS-Code-style navigator: the context panel next to the activity bar. */
export function Navigator({ workspaceName }: { workspaceName: string }) {
  const pathname = usePathname();
  const section = sectionFor(pathname);
  const isSettings = section?.href === "/settings";
  const isIssues = section?.href === "/issues";

  return (
    <aside className="hidden w-60 shrink-0 flex-col border-r bg-sidebar md:flex">
      <div className="flex h-11 shrink-0 flex-col justify-center border-b px-3">
        <span className="truncate font-semibold text-sm leading-tight">
          {isSettings || isIssues ? (section?.label ?? workspaceName) : workspaceName}
        </span>
        <span className="truncate text-2xs text-muted-foreground leading-tight">
          {section?.caption ?? "Workspace"}
        </span>
      </div>
      <ScrollArea className="flex-1">
        {isSettings ? <SettingsNav /> : isIssues ? <IssuesNav /> : <BoardNav />}
      </ScrollArea>
    </aside>
  );
}
