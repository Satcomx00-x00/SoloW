"use client";

import type { TaskDto, TaskState, TaskWorkflowBindingDto, WorkflowStepDto } from "@solow/contracts";
import { Workflow } from "lucide-react";
import type { KeyboardEvent } from "react";
import { useCallback, useState } from "react";
import { Step, type StepStatus, Steps } from "@/components/ui/steps";
import { cn } from "@/lib/utils";
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

/**
 * The one panel the strip's tabs control.
 *
 * A constant rather than a `useId`: there is exactly one Task workspace on a page, the tabs and
 * the panel are rendered by two different components several levels apart, and threading a
 * generated id between them would buy nothing but the plumbing.
 */
export const TERMINAL_PANEL_ID = "task-terminal-panel";
/** The tab that means "everything", which is not a Step and so has no Step id to be named by. */
export const WHOLE_RUN_TAB_ID = "workflow-step-tab-whole-run";
export const stepTabId = (stepId: string) => `workflow-step-tab-${stepId}`;

/** Which tab is selected, so the panel can name it in `aria-labelledby`. */
export function selectedTabId(selected: string | null): string {
  return selected === null ? WHOLE_RUN_TAB_ID : stepTabId(selected);
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
 * Where a Task is in its Workflow, and which Step's output the terminal below is showing
 * (spec F03).
 *
 * **Why a tablist.** The strip used to be an ordered list that only reported progress, and
 * `aria-current="step"` said which entry the run had reached. Selecting is a second, independent
 * fact — an operator reads Step 1 while the run is on Step 3 — and layering it onto
 * `aria-current` would have made one attribute answer two questions that routinely disagree.
 * What this is now is the textbook case for tabs: one strip of alternatives, one panel below
 * whose content each one swaps. So the steps are tabs (`aria-selected`), the terminal is their
 * panel, and `aria-current` stays on whichever tab the run is actually on. The ordered-list
 * semantics are the price — a `tablist` cannot also be a list — and they are worth it: a tab
 * announces its own position in the set, and the header line above still says "Step 2 of 3".
 *
 * **Manual activation.** The arrow keys move focus and Enter or Space selects, rather than the
 * selection following focus. Automatic activation is only appropriate when showing a panel is
 * free; each of these fires a fresh query for a Step's worth of log, and arrowing across five
 * steps to reach the sixth would fire five of them.
 *
 * Nothing at all for a Task on no Workflow: a single-harness run has no steps to be on, and its
 * terminal is never scoped.
 */
export function WorkflowSteps({ scope }: { scope: StepScope }) {
  const { binding, stepped, selected, select } = scope;

  /**
   * Roving focus along the strip. Queried from the DOM rather than held in a ref array: the tabs
   * are rendered by a shared primitive that knows nothing about this strip, and what has to move
   * is focus, which is a DOM fact anyway.
   */
  const onStripKey = useCallback((event: KeyboardEvent<HTMLOListElement>) => {
    const { key } = event;
    if (key !== "ArrowLeft" && key !== "ArrowRight" && key !== "Home" && key !== "End") return;
    const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
    const at = tabs.indexOf(document.activeElement as HTMLElement);
    if (at === -1) return;
    event.preventDefault();
    const last = tabs.length - 1;
    const next =
      key === "Home"
        ? 0
        : key === "End"
          ? last
          : key === "ArrowLeft"
            ? (at - 1 + tabs.length) % tabs.length
            : (at + 1) % tabs.length;
    tabs[next]?.focus();
  }, []);

  if (!binding) return null;

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
      <Steps aria-label="Workflow steps" onKeyDown={onStripKey} role="tablist">
        {/*
          The way back to everything, first and set apart — where an "All" filter sits in every
          other strip of this shape. It belongs *in* the tablist rather than beside it because a
          tablist with none of its tabs selected is a broken tablist, and "the whole run" is a
          genuine alternative to the Steps, not a control that undoes them.
        */}
        <li className="flex min-w-0 items-center" role="presentation">
          <button
            aria-controls={TERMINAL_PANEL_ID}
            aria-selected={selected === null}
            className={cn(
              "cursor-pointer rounded-md px-1.5 py-0.5 text-xs transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
              selected === null
                ? "bg-muted font-medium text-foreground ring-1 ring-border"
                : "text-muted-foreground hover:bg-muted/60",
            )}
            id={WHOLE_RUN_TAB_ID}
            onClick={() => select(null)}
            role="tab"
            tabIndex={selected === null ? 0 : -1}
            type="button"
          >
            Whole run
          </button>
          <span aria-hidden className="mx-2 h-4 w-px shrink-0 bg-border" />
        </li>
        {stepped.map(({ step, status }, i) => (
          <Step
            controls={TERMINAL_PANEL_ID}
            index={i}
            key={step.id}
            last={i === stepped.length - 1}
            onSelect={() => select(step.id)}
            selected={selected === step.id}
            status={status}
            tabId={stepTabId(step.id)}
          >
            {step.name}
          </Step>
        ))}
      </Steps>
    </section>
  );
}
