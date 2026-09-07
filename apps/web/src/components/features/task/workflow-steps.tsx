"use client";

import type { TaskDto, TaskState, TaskWorkflowBindingDto, WorkflowStepDto } from "@solow/contracts";
import { Workflow } from "lucide-react";
import { Step, type StepStatus, Steps } from "@/components/ui/steps";
import { trpc } from "@/trpc/react";

/**
 * The Task's Workflow binding, or null while it has none — one query, shared by every surface
 * that draws the Steps, so the header strip and the sidebar list can never disagree.
 *
 * Kept fresh by the workspace: a `status` frame on the Task's stream invalidates it, so a Step
 * advancing (which announces the state even when the state itself did not change) reaches the
 * screen without a reload.
 */
export function useTaskBinding(task: TaskDto | null): TaskWorkflowBindingDto | null {
  const bound = task !== null && task.workflowId !== null;
  const binding = trpc.workflow.taskBinding.useQuery(
    { taskId: task?.id ?? "" },
    { enabled: bound, retry: false },
  );
  return bound ? (binding.data ?? null) : null;
}

export interface SteppedStep {
  step: WorkflowStepDto;
  status: StepStatus;
  /** The Step the cursor is on — whatever its status says about how that is going. */
  current: boolean;
}

/**
 * Each Step with the colour it earns from where the cursor is and what the Task is doing.
 *
 * The cursor is the Task's `workflowStepId`; a finished Task still points at its last Step, so
 * the Task's state — not the cursor — is what says whether that Step is done, failed, running,
 * or waiting on a person (review) or on the world (parked).
 */
export function stepStatuses(binding: TaskWorkflowBindingDto, state: TaskState): SteppedStep[] {
  const ordered = [...binding.steps].sort((a, b) => a.position - b.position);
  const at = ordered.findIndex((s) => s.id === binding.currentStep.id);
  const here: StepStatus =
    state === "done"
      ? "done"
      : state === "failed"
        ? "failed"
        : state === "running"
          ? "running"
          : state === "review" || state === "parked"
            ? "waiting"
            : "upcoming";
  return ordered.map((step, i) => ({
    step,
    status: i < at ? "done" : i > at ? "upcoming" : here,
    current: i === at,
  }));
}

/**
 * Where a Task is in its Workflow, in the runner's own header (spec F03).
 *
 * Nothing at all for a Task on no Workflow: a single-harness run has no steps to be on.
 */
export function WorkflowSteps({ task }: { task: TaskDto }) {
  const binding = useTaskBinding(task);
  if (!binding) return null;

  const stepped = stepStatuses(binding, task.state);
  const at = stepped.findIndex((s) => s.current);

  return (
    <section
      aria-label="Workflow progress"
      className="surface-edge mx-4 mt-3 rounded-lg border bg-card px-3 py-2"
    >
      <p className="mb-2 flex items-center gap-1.5 text-2xs text-muted-foreground">
        <Workflow aria-hidden className="size-3 shrink-0" />
        <span className="truncate font-medium text-foreground/80">{binding.workflowName}</span>
        <span className="shrink-0">
          · Step {at + 1} of {stepped.length}
        </span>
      </p>
      <Steps aria-label="Workflow steps">
        {stepped.map(({ step, status }, i) => (
          <Step key={step.id} index={i} last={i === stepped.length - 1} status={status}>
            {step.name}
          </Step>
        ))}
      </Steps>
    </section>
  );
}
