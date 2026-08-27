"use client";

import type { TaskDependencyDto, TaskDto } from "@solow/contracts";
import { parseDependencyCycleMessage } from "@solow/core";
import { Check, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { STATE_LABELS } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The "Blocked by" picker (issue #6 AC-1) — a searchable multi-select over the Workspace's other
 * Tasks, each row showing its state so the Owner can see *why* a choice would block this one.
 *
 * Built on `CommandDialog` rather than a new Popover-based Combobox primitive: the search-and-
 * pick behaviour is identical, and the command palette already establishes it as this codebase's
 * way of choosing a Task by name.
 *
 * A cycle is not reported here. It is handed up via `onCycle` so the path is named by the dialog
 * that exists for exactly that (AC-2) — a one-line error under a search box would be the generic
 * failure the issue is asking us not to ship.
 */
export function BlockedByDialog({
  task,
  tasks,
  blockers,
  onOpenChange,
  onCycle,
}: {
  /** The Task being blocked; null closes the dialog. */
  task: TaskDto | null;
  tasks: readonly TaskDto[];
  blockers: readonly TaskDependencyDto[];
  onOpenChange: (open: boolean) => void;
  onCycle: (path: readonly string[]) => void;
}) {
  const utils = trpc.useUtils();
  const [failure, setFailure] = useState<string | null>(null);

  const settled = () => {
    void utils.task.dependencies.invalidate();
    void utils.task.list.invalidate();
  };
  const add = trpc.task.addDependency.useMutation({
    onSuccess: settled,
    onError: (error) => {
      const path = parseDependencyCycleMessage(error.message);
      if (path) {
        onOpenChange(false);
        onCycle(path);
        return;
      }
      setFailure(error.message);
    },
  });
  const remove = trpc.task.removeDependency.useMutation({ onSuccess: settled });

  const blocking = new Set(blockers.map((edge) => edge.blockedByTaskId));
  // A Task cannot block itself, and offering it as a choice would only produce a refusal the
  // Owner could have been spared.
  const candidates = tasks.filter((candidate) => candidate.id !== task?.id);

  return (
    <CommandDialog
      open={task !== null}
      onOpenChange={(open) => {
        if (!open) setFailure(null);
        onOpenChange(open);
      }}
      title="Blocked by"
      description="Choose the tasks this one waits on."
    >
      <CommandInput placeholder="Search tasks this one should wait on…" />
      <CommandList>
        <CommandEmpty>No other task matches.</CommandEmpty>
        {failure ? (
          <p
            className="mx-3 my-2 flex items-center gap-2 rounded-lg border border-state-failed/30 bg-state-failed/10 px-3 py-2 text-state-failed text-sm"
            role="alert"
          >
            <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
            {failure}
          </p>
        ) : null}
        <CommandGroup heading="Blocked by">
          {candidates.map((candidate) => {
            const selected = blocking.has(candidate.id);
            return (
              <CommandItem
                key={candidate.id}
                value={`${candidate.title} ${candidate.id}`}
                disabled={add.isPending || remove.isPending}
                onSelect={() => {
                  if (!task) return;
                  setFailure(null);
                  const edge = { taskId: task.id, blockedByTaskId: candidate.id };
                  if (selected) remove.mutate(edge);
                  else add.mutate(edge);
                }}
              >
                <Check
                  aria-hidden
                  className={cn("text-muted-foreground", selected ? "opacity-100" : "opacity-0")}
                />
                <span className="min-w-0 flex-1 truncate">{candidate.title}</span>
                <span className="shrink-0 font-mono text-2xs text-muted-foreground/80">
                  {STATE_LABELS[candidate.state]}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
