"use client";

import type { TaskDto } from "@solow/contracts";
import { Workflow } from "lucide-react";
import { Step, type StepStatus, Steps } from "@/components/ui/steps";
import { trpc } from "@/trpc/react";

/**
 * Where a Task is in its Workflow, in the runner's own header (spec F03).
 *
 * The cursor is the Task's `workflowStepId`, read through `workflow.taskBinding` so the Step
 * list and the current one come from a single answer. A finished Task still points at its last
 * Step, so the Task's state — not the cursor — is what says whether that Step is done or failed.
 *
 * Nothing at all for a Task on no Workflow: a single-harness run has no steps to be on.
 */
export function WorkflowSteps({ task }: { task: TaskDto }) {
  const bound = task.workflowId !== null;
  const binding = trpc.workflow.taskBinding.useQuery(
    { taskId: task.id },
    { enabled: bound, retry: false },
  );
  if (!bound || !binding.data) return null;

  const { steps, currentStep, workflowName } = binding.data;
  const ordered = [...steps].sort((a, b) => a.position - b.position);
  const at = ordered.findIndex((s) => s.id === currentStep.id);
  const statusOf = (i: number): StepStatus => {
    if (i < at) return "done";
    if (i > at) return "upcoming";
    if (task.state === "done") return "done";
    if (task.state === "failed") return "failed";
    return "current";
  };

  return (
    <section
      aria-label="Workflow progress"
      className="surface-edge mx-4 mt-3 rounded-lg border bg-card px-3 py-2"
    >
      <p className="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Workflow aria-hidden className="size-3 shrink-0" />
        <span className="truncate font-medium text-foreground/80">{workflowName}</span>
        <span className="shrink-0">
          · Step {at + 1} of {ordered.length}
        </span>
      </p>
      <Steps aria-label="Workflow steps">
        {ordered.map((s, i) => (
          <Step key={s.id} index={i} last={i === ordered.length - 1} status={statusOf(i)}>
            {s.name}
          </Step>
        ))}
      </Steps>
    </section>
  );
}
