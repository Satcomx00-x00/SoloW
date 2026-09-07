"use client";

import type { TaskDto } from "@solow/contracts";
import { nextTaskState, primaryTaskRepository } from "@solow/core";
import {
  Check,
  Columns3,
  Copy,
  Inbox,
  Play,
  RotateCcw,
  ScanSearch,
  Workflow,
  X,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useState } from "react";
import { ConfirmAction } from "@/components/features/confirm-action";
import { useBackToProject } from "@/components/features/shared/back-to-project";
import {
  LaunchTaskDialog,
  useWorkflowChoices,
} from "@/components/features/task/launch-task-dialog";
import { stepStatuses, useTaskBinding } from "@/components/features/task/workflow-steps";
import { Button } from "@/components/ui/button";
import { STATUS_WORD, StepMarker, stepLabelVariants } from "@/components/ui/steps";
import { taskActionMessage } from "@/lib/task-errors";
import { STATE_LABELS } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The Task page's sidebar: what you can do to this Task, where it sits, and where to go from it.
 *
 * The page itself puts each control where its evidence is — the lifecycle arrows by the state
 * badge, the review verdicts under the diff. This is the same set gathered in one column, for
 * the reader who knows what they want to do and does not want to find the control for it in a
 * page that scrolls. It issues the same mutations the page does and invalidates the same
 * queries, so the page catches up on its own.
 */

function SectionLabel({ children }: { children: ReactNode }) {
  return (
    <p className="px-3 pt-4 pb-2 font-medium text-2xs text-muted-foreground/70 uppercase tracking-[0.14em]">
      {children}
    </p>
  );
}

function Action({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <li>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        disabled={disabled}
        onClick={onClick}
        className="w-full justify-start gap-2.5 px-2 font-normal"
      >
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
      </Button>
    </li>
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
  const utils = trpc.useUtils();
  const task = trpc.task.get.useQuery({ id: taskId });
  const sessions = trpc.session.listForTask.useQuery({ taskId });
  const latest = sessions.data?.[0];
  const back = useBackToProject(task.data?.issueId, "/board");
  const binding = useTaskBinding(task.data ?? null);
  const workflowChoices = useWorkflowChoices();
  const [launching, setLaunching] = useState<TaskDto | null>(null);
  const [copied, setCopied] = useState(false);

  // The same invalidations the page performs for the same mutations, so both surfaces move.
  const settle = () => {
    utils.task.get.invalidate({ id: taskId });
    utils.task.list.invalidate();
    utils.session.listForTask.invalidate({ taskId });
    utils.workflow.taskBinding.invalidate({ taskId });
  };
  const move = trpc.task.move.useMutation({ onSuccess: settle });
  const launch = trpc.task.launch.useMutation({ onSuccess: settle });
  const submit = trpc.task.submitForReview.useMutation({ onSuccess: settle });
  const decide = trpc.review.decide.useMutation({
    onSuccess: () => {
      settle();
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
    },
  });

  const t = task.data;
  if (!t) return null;

  const busy = move.isPending || launch.isPending || submit.isPending || decide.isPending;
  const message =
    taskActionMessage(move.error?.message ?? launch.error?.message ?? submit.error?.message) ??
    decide.error?.message ??
    null;
  const requestLaunch = () => {
    if (workflowChoices.available) setLaunching(t);
    else launch.mutate({ id: t.id });
  };
  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (latest?.id) decide.mutate({ sessionId: latest.id, decision });
  };
  // Forward from anywhere but Running, whose exit is the orchestrator's to write (see
  // `TaskAdvance`); Ready's forward is a launch, not a state write.
  const forward = t.state === "running" || t.state === "ready" ? null : nextTaskState(t.state);
  const primary = t.repositories.length > 0 ? primaryTaskRepository(t.repositories) : null;
  const branch = primary?.resultBranch ?? primary?.checkoutBranch ?? null;
  const stepped = binding ? stepStatuses(binding, t.state) : [];

  return (
    <div className="pb-3">
      <LaunchTaskDialog
        task={launching}
        onOpenChange={(open) => {
          if (!open) setLaunching(null);
        }}
        onLaunch={(task) => launch.mutate({ id: task.id })}
      />

      <nav aria-label="Task actions">
        <SectionLabel>Actions</SectionLabel>
        <ul className="space-y-px px-2">
          {t.state === "ready" && (
            <Action icon={Play} label="Launch" onClick={requestLaunch} disabled={busy} />
          )}
          {t.state === "running" && t.completedOutcome === "changes_ready" && (
            <Action
              icon={ScanSearch}
              label="Open review"
              onClick={() => submit.mutate({ id: t.id })}
              disabled={busy}
            />
          )}
          {t.state === "review" && (
            <>
              <Action
                icon={Check}
                label="Approve"
                onClick={() => runDecision("approve")}
                disabled={busy || !latest}
              />
              <Action
                icon={RotateCcw}
                label="Request changes"
                onClick={() => runDecision("request_changes")}
                disabled={busy || !latest}
              />
              <li>
                <ConfirmAction
                  disabled={busy || !latest}
                  title="Reject these changes?"
                  description="The harness's work is discarded and the worktree is torn down. This cannot be undone. The task returns to Ready and would have to run again from scratch."
                  confirmLabel="Discard the changes"
                  onConfirm={() => runDecision("reject")}
                  trigger={
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={busy || !latest}
                      className="w-full justify-start gap-2.5 px-2 font-normal text-destructive hover:bg-destructive/10 hover:text-destructive"
                    >
                      <X aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate text-left">Reject</span>
                    </Button>
                  }
                />
              </li>
            </>
          )}
          {forward && (
            <Action
              icon={Play}
              label={`Move to ${STATE_LABELS[forward]}`}
              onClick={() => move.mutate({ id: t.id, to: forward })}
              disabled={busy}
            />
          )}
          {branch && (
            <Action
              icon={copied ? Check : Copy}
              label={copied ? "Branch copied" : "Copy branch name"}
              onClick={() => {
                // `navigator.clipboard` exists only in a secure context; a plain http deployment
                // gets nothing, and saying "copied" then would be a lie.
                void navigator.clipboard?.writeText(branch).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  },
                  () => {},
                );
              }}
            />
          )}
        </ul>
        {message && (
          <p className="px-3 pt-1 font-mono text-2xs text-state-failed" role="alert">
            {message}
          </p>
        )}
      </nav>

      {binding && (
        <nav aria-label="Workflow steps">
          <SectionLabel>{binding.workflowName}</SectionLabel>
          <ol className="space-y-px px-2">
            {stepped.map(({ step, status, current }, i) => (
              <li
                key={step.id}
                data-status={status}
                aria-current={current ? "step" : undefined}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2 py-1.5",
                  current && "bg-sidebar-accent/60",
                )}
              >
                <StepMarker status={status} index={i} />
                <span className={cn(stepLabelVariants({ status }), "min-w-0 flex-1 text-sm")}>
                  {step.name}
                </span>
                {STATUS_WORD[status] && <span className="sr-only"> — {STATUS_WORD[status]}</span>}
              </li>
            ))}
          </ol>
        </nav>
      )}

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
