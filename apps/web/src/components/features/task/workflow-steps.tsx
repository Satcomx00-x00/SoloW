"use client";

import type { TaskDto, TaskState, TaskWorkflowBindingDto, WorkflowStepDto } from "@solow/contracts";
import { Workflow } from "lucide-react";
import { useCallback, useState } from "react";
import type { StepStatus } from "@/components/ui/steps";
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
  return useTaskBindingQuery(task).binding;
}

/**
 * The same query, plus whether it has answered yet.
 *
 * Split out for one caller — the Task workspace, which cannot fire its transcript query until it
 * knows which Step to scope it to. `null` alone cannot tell "this Task has no Workflow" from
 * "the binding has not arrived", and guessing wrong costs exactly what this whole change exists
 * to save: a first, unscoped fetch of the entire pipeline, immediately superseded by a scoped one.
 *
 * A refusal settles too. Nothing here retries, so a binding that errors would otherwise leave the
 * terminal waiting forever on an answer that is never coming — a Task whose Workflow cannot be
 * read still has a log to show.
 */
export function useTaskBindingQuery(task: TaskDto | null): {
  binding: TaskWorkflowBindingDto | null;
  settled: boolean;
} {
  const bound = task !== null && task.workflowId !== null;
  const binding = trpc.workflow.taskBinding.useQuery(
    { taskId: task?.id ?? "" },
    { enabled: bound, retry: false },
  );
  return {
    binding: bound ? (binding.data ?? null) : null,
    settled: !bound || !binding.isPending,
  };
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

export interface StepScope {
  /** The Task's binding, or null when it is on no Workflow. */
  binding: TaskWorkflowBindingDto | null;
  /** Every Step with the status the strip draws it in; empty for an unbound Task. */
  stepped: SteppedStep[];
  /** The Step the terminal is narrowed to, or null for the whole run. */
  selected: string | null;
  select: (stepId: string | null) => void;
  /**
   * Whether `selected` is an answer rather than a placeholder. False only while a bound Task's
   * binding is still in flight — the window in which a transcript query would be fired unscoped
   * and then thrown away.
   */
  settled: boolean;
}

/**
 * Which Step the terminal is showing.
 *
 * One SoloW Session spans an entire pipeline — every Step, every review round — and the terminal
 * used to load and render all of it at once. That is the thing being fixed: the selection here
 * is not decoration on the strip, it is the argument `session.get` is scoped by, so a Step's
 * worth of log is the only part that is ever fetched or held.
 *
 * **Following, then not.** `undefined` means the operator has not touched the strip, and until
 * they do the terminal follows the run: the Step the cursor is on is the Step on screen, and it
 * moves as the pipeline advances. The moment they pick one, their choice wins outright and
 * nothing overrides it — the same "override, or the default until then" shape `CreateDisclosure`
 * uses, and for the same reason: the default is an answer that arrives a query later than the
 * first render, so seeding state with it once would freeze the strip on whatever was true (or
 * not yet known) at mount. `null` is a third answer and has to be distinguishable from both —
 * it is the operator having deliberately asked for the whole run, which is not "untouched".
 *
 * **A default that stopped existing.** A Workflow definition can drift under a running Task, so
 * an override naming a Step that is no longer in the binding falls back to following rather than
 * leaving the strip with no tab selected and the terminal scoped to a Step nothing can produce.
 */
export function useStepScope(task: TaskDto | null): StepScope {
  const { binding, settled } = useTaskBindingQuery(task);
  const [override, setOverride] = useState<string | null | undefined>(undefined);
  const select = useCallback((stepId: string | null) => setOverride(stepId), []);

  const stepped = binding && task ? stepStatuses(binding, task.state) : [];
  const following = binding?.currentStep.id ?? null;
  const known =
    override === undefined || override === null || stepped.some((s) => s.step.id === override);
  const selected = override === undefined || !known ? following : override;

  return { binding, stepped, selected, select, settled };
}

/**
 * Where a Task is in its Workflow: the pipeline's name and the Step the run is on, in the Task's
 * header bar (spec F03). Nothing at all for a Task on no Workflow.
 *
 * Just the position. This used to be a full strip — every Step as a tab, plus "Whole run" — and
 * the tabs scoped the board and the transcript. The board itself now draws every Step as a node,
 * with the one running and the one waiting on you animated, so a second row of the same Steps in
 * the header was a duplicate competing for the eye; it was removed on request. Scoping is still
 * there: the board follows the Step the run is on, and a Step's own dialog has "Show this step
 * on the board".
 */
export function WorkflowPosition({ scope }: { scope: StepScope }) {
  const { binding, stepped } = scope;
  if (!binding) return null;
  const at = stepped.findIndex((s) => s.current);
  return (
    <section
      aria-label="Workflow progress"
      className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs"
    >
      <Workflow aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 max-w-56 truncate font-medium text-foreground/80">
        {binding.workflowName}
      </span>
      <span className="shrink-0">
        · Step {at + 1} of {stepped.length}
      </span>
    </section>
  );
}
