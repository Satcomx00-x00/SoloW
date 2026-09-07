"use client";

import type { TaskDto } from "@solow/contracts";
import { GitBranch, Play, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { trpc } from "@/trpc/react";

/**
 * The question a launch asks first: which Workflow, if any (spec F03).
 *
 * A Task is bound to a pipeline by `workflow.attachTask`, which the designer offers from its own
 * page — but the moment somebody actually decides is the moment they press Launch, and a launch
 * that silently ran a Task as a single harness because nobody had visited the designer was the
 * common case. So the launch asks. The answer is written first (attach, or detach when "no
 * workflow" is chosen on a bound Task) and the caller's own launch runs after, so every refusal
 * a launch can meet still lands on the caller's banner.
 *
 * `useWorkflowChoices` says whether there is anything to ask: with `ff-workflows` off, or with no
 * Workflow in the Workspace, the launch goes straight through and this dialog never shows.
 */
export function useWorkflowChoices() {
  // Allowed to fail: `workflow.list` throws FLAG_DISABLED wherever the flag is off, and that
  // must mean "no question", never an error on a screen that was fine before Workflows existed.
  const query = trpc.workflow.list.useQuery({}, { retry: false });
  const workflows = Array.isArray(query.data) ? query.data : [];
  return { workflows, available: workflows.length > 0 };
}

const NONE = "__none__";

export function LaunchTaskDialog({
  task,
  onOpenChange,
  onLaunch,
}: {
  /** The Task about to be launched, or null when the dialog is closed. */
  task: TaskDto | null;
  onOpenChange: (open: boolean) => void;
  /** Runs once the binding is written; the caller launches (and owns the launch's errors). */
  onLaunch: (task: TaskDto) => void;
}) {
  const utils = trpc.useUtils();
  const { workflows } = useWorkflowChoices();
  const [choice, setChoice] = useState<string>(NONE);
  // Each opening starts from what the Task is bound to now, not from the last answer given.
  useEffect(() => {
    if (task) setChoice(task.workflowId ?? NONE);
  }, [task]);

  const settle = () => {
    utils.task.list.invalidate();
    utils.workflow.taskBinding.invalidate();
  };
  const attach = trpc.workflow.attachTask.useMutation({ onSuccess: settle });
  const detach = trpc.workflow.detachTask.useMutation({ onSuccess: settle });
  const pending = attach.isPending || detach.isPending;
  const error = attach.error ?? detach.error;

  const confirm = async () => {
    if (!task) return;
    const wanted = choice === NONE ? null : choice;
    if (wanted !== (task.workflowId ?? null)) {
      try {
        if (wanted) await attach.mutateAsync({ taskId: task.id, workflowId: wanted });
        else await detach.mutateAsync({ taskId: task.id });
      } catch {
        return; // said in the dialog, by the mutation's error below
      }
    }
    onOpenChange(false);
    onLaunch({ ...task, workflowId: wanted });
  };

  return (
    <Dialog open={task !== null} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Launch {task?.title ?? "the task"}</DialogTitle>
          <DialogDescription>
            Through a Workflow — one harness per Step, with its gates — or as a single harness run.
          </DialogDescription>
        </DialogHeader>
        <div
          role="radiogroup"
          aria-label="Workflow"
          className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-1.5"
        >
          <Choice
            selected={choice === NONE}
            onSelect={() => setChoice(NONE)}
            icon={<Sparkles aria-hidden className="size-3.5" />}
            title="No workflow"
            detail="One harness, one run, then the review gate."
          />
          {workflows.map((w) => (
            <Choice
              key={w.id}
              selected={choice === w.id}
              onSelect={() => setChoice(w.id)}
              icon={<GitBranch aria-hidden className="size-3.5" />}
              title={w.name}
              detail={`${w.stepCount} step${w.stepCount === 1 ? "" : "s"}${w.description ? ` · ${w.description}` : ""}`}
            />
          ))}
        </div>
        {error && (
          <p className="text-destructive text-sm" role="alert">
            {error.message}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" loading={pending} onClick={() => void confirm()}>
            <Play aria-hidden />
            Launch
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Choice({
  selected,
  onSelect,
  icon,
  title,
  detail,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: React.ReactNode;
  title: string;
  detail: string;
}) {
  // A native radio, visually hidden, so the row is a real choice to a keyboard and a reader; the
  // label is the whole row, which is the click target people expect.
  return (
    <label
      className={`flex min-w-0 cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50 ${
        selected ? "border-primary/50 bg-primary/5" : "hover:border-ring/40 hover:bg-accent/30"
      }`}
    >
      <input
        type="radio"
        name="launch-workflow"
        className="sr-only"
        checked={selected}
        onChange={onSelect}
      />
      <span
        aria-hidden
        className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-md border ${
          selected ? "border-primary/40 text-primary" : "text-muted-foreground"
        }`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{title}</span>
        <span className="block truncate text-muted-foreground text-xs">{detail}</span>
      </span>
    </label>
  );
}
