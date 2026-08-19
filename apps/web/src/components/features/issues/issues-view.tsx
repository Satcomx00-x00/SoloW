"use client";

import type { IssueDto, IssueStatus } from "@gatecontrol/contracts";
import { CommonErrorCode } from "@gatecontrol/contracts";
import { ChevronRight, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CreateIssueDialog } from "@/components/features/board/create-issue-dialog";
import { HeaderActions } from "@/components/shell/header-actions";
import { ISSUE_STATUS_LABELS, ISSUE_STATUS_STYLE, ISSUE_STATUSES } from "@/lib/issue-status";
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
 * board rolled up one level, not a second place to keep state in step.
 */

function StatusFilter({ active }: { active: IssueStatus | null }) {
  const tab = (href: string, label: string, selected: boolean) => (
    <Link
      key={href}
      href={href}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "rounded-md px-2.5 py-1 text-sm transition-colors",
        selected
          ? "bg-accent text-foreground"
          : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
      )}
    >
      {label}
    </Link>
  );

  return (
    <div className="flex flex-wrap items-center gap-1">
      {tab("/issues", "All", active === null)}
      {ISSUE_STATUSES.map((status) =>
        tab(`/issues?status=${status}`, ISSUE_STATUS_LABELS[status], active === status),
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
          <p className="truncate font-medium text-sm">{issue.title}</p>
          {issue.description && (
            <p className="mt-0.5 line-clamp-1 text-muted-foreground text-xs">{issue.description}</p>
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
  const params = useSearchParams();
  const raw = params.get("status");
  const status = ISSUE_STATUSES.includes(raw as IssueStatus) ? (raw as IssueStatus) : null;
  const issues = trpc.issue.list.useQuery(status ? { status } : {});

  return (
    <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-5">
      <HeaderActions>
        <CreateIssueDialog />
      </HeaderActions>

      <StatusFilter active={status} />

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
              {status ? `Nothing is ${ISSUE_STATUS_LABELS[status].toLowerCase()}` : "No issues yet"}
            </h2>
            <p className="max-w-md text-muted-foreground text-sm leading-relaxed">
              {status
                ? "Try another status, or clear the filter to see everything."
                : "An issue describes what you want done. Tasks under it are the slices you hand to an agent."}
            </p>
          </div>
        ) : (
          <ul className="space-y-2">
            {issues.data.map((issue) => (
              <IssueRow key={issue.id} issue={issue} />
            ))}
          </ul>
        ))}
    </div>
  );
}
