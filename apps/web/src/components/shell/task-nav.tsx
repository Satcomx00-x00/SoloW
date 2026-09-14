"use client";

import { Columns3, Inbox, Workflow } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { useBackToProject } from "@/components/features/shared/back-to-project";
import { useTaskBinding } from "@/components/features/task/workflow-steps";
import { trpc } from "@/trpc/react";

/**
 * The Task page's sidebar: where to go from this Task.
 *
 * It used to gather the page's controls as well — Launch, Open review, the three verdicts, Move
 * to Done, Copy branch — so a decision stayed reachable while the transcript scrolled. The page
 * now keeps its decision bar fixed under every tab and the branch's copy button on the branch,
 * so that job is done where the evidence is, and the sidebar's copy of the verdicts was the
 * third place on one screen offering the same act (with "Move to Done" between Approve and
 * Copy, skipping the gate with none of the gate's wording). One copy of each verb, on the page.
 * What is left here is navigation: the board, the Issue, the Workflow.
 */

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-2 font-medium text-2xs text-muted-foreground-subtle uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

function Go({
  icon: Icon,
  label,
  href,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  href: string;
}) {
  return (
    <li>
      <Link
        href={href}
        className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-foreground/75 text-sm transition-colors hover:bg-sidebar-accent/50 hover:text-foreground"
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </Link>
    </li>
  );
}

export function TaskNav({ taskId }: { taskId: string }) {
  const task = trpc.task.get.useQuery({ id: taskId });
  const back = useBackToProject(task.data?.issueId, "/board");
  const binding = useTaskBinding(task.data ?? null);

  const t = task.data;
  if (!t) return null;

  return (
    <div className="pb-3">
      <nav aria-label="Go to">
        <SectionLabel>Go to</SectionLabel>
        <ul className="space-y-px px-2">
          <Go icon={Columns3} label="Board" href={back.href} />
          <Go icon={Inbox} label="Issue" href={`/issues/${t.issueId}`} />
          {binding && (
            <Go icon={Workflow} label="Workflow" href={`/workflows/${binding.workflowId}`} />
          )}
        </ul>
      </nav>
    </div>
  );
}
