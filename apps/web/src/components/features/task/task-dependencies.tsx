"use client";

import type { TaskDependencyDto, TaskDto } from "@solow/contracts";
import { unsatisfiedDependencies } from "@solow/core";
import { Lock } from "lucide-react";
import Link from "next/link";
import { type ReactNode, useMemo, useState } from "react";
import { BlockedByDialog } from "@/components/features/board/blocked-by-dialog";
import { DependencyCycleDialog } from "@/components/features/board/dependency-cycle-dialog";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { Button } from "@/components/ui/button";
import { WHOLE_PAGE } from "@/lib/paged";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The edges around one Task, and which of them still hold it back (issue #6).
 *
 * Its own hook so the header row and the footer's Launch read the same answer. The list is the
 * whole Workspace's on purpose — the DTO carries `blocked_by` edges only, so "what this Task
 * blocks" is the same list read from the other end, and a second query scoped to `taskId` would
 * answer half the question for the same round trip. The board holds this exact query too, so
 * React Query usually serves it from cache.
 */
export function useTaskDependencies(taskId: string) {
  const edges = trpc.task.dependencies.useQuery({});
  return useMemo(() => {
    const all = edges.data ?? [];
    const blockedBy = all.filter((edge) => edge.taskId === taskId);
    const blocks = all.filter((edge) => edge.blockedByTaskId === taskId);
    return { blockedBy, blocks, outstanding: unsatisfiedDependencies(blockedBy) };
  }, [edges.data, taskId]);
}

/**
 * "Blocked by" and "Blocks", as chips under the header (spec F02, issue #6).
 *
 * A Task stuck in Ready explains itself on the board — the card dims and a lock names what it is
 * waiting on — and said nothing on its own page, where the operator had just pressed Launch and
 * been refused. The chips link to the other Task, because the next thing anyone does with
 * "waiting on X" is go and look at X.
 *
 * Nothing at all when there are no edges: a "Blocked by: —" row on every unblocked Task is a
 * line people learn to stop reading. Editing lives in the header's action cluster
 * (`useBlockedByEditor`), so it is reachable whether or not this row exists.
 */
export function TaskDependencies({
  blockedBy,
  blocks,
}: {
  blockedBy: readonly TaskDependencyDto[];
  blocks: readonly TaskDependencyDto[];
}) {
  // "Blocks" needs the titles of the Tasks on the far end of each edge — the DTO names the
  // blocker, not the blocked. Fetched only when there is such an edge.
  const tasks = trpc.task.list.useQuery({ ...WHOLE_PAGE }, { enabled: blocks.length > 0 });
  const other = (id: string) => tasks.data?.items.find((t) => t.id === id) ?? null;

  if (blockedBy.length === 0 && blocks.length === 0) return null;

  return (
    <div
      className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-2xs"
      data-task-dependencies
    >
      {blockedBy.length > 0 ? (
        <ChipGroup label="Blocked by" icon={Lock}>
          {blockedBy.map((edge) => (
            <Chip
              key={edge.blockedByTaskId}
              href={`/task/${edge.blockedByTaskId}`}
              title={edge.blockedByTitle}
              state={edge.blockedByState}
            />
          ))}
        </ChipGroup>
      ) : null}
      {blocks.length > 0 ? (
        <ChipGroup label="Blocks">
          {blocks.map((edge) => {
            const t = other(edge.taskId);
            return (
              <Chip
                key={edge.taskId}
                href={`/task/${edge.taskId}`}
                title={t?.title ?? "…"}
                state={t?.state ?? null}
              />
            );
          })}
        </ChipGroup>
      ) : null}
    </div>
  );
}

function ChipGroup({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon?: typeof Lock;
  children: ReactNode;
}) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <span className="flex items-center gap-1 text-muted-foreground">
        {Icon ? <Icon aria-hidden className="size-3" /> : null}
        {label}
      </span>
      {children}
    </span>
  );
}

/** One edge: the other Task's title, its state, and the way there. */
function Chip({
  href,
  title,
  state,
}: {
  href: string;
  title: string;
  state: TaskDependencyDto["blockedByState"] | null;
}) {
  // A predecessor that is Done no longer holds anything back, and reads quieter for it.
  const settled = state === "done";
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex max-w-64 items-center gap-1.5 rounded-md border bg-card px-1.5 py-0.5 transition-colors hover:bg-accent",
        settled && "text-muted-foreground",
      )}
    >
      <span className="truncate">{title}</span>
      {state ? <TaskStateBadge state={state} size="sm" /> : null}
    </Link>
  );
}

/**
 * Editing the edges from this page, with the board's own picker and its cycle dialog — so the
 * rule about what may block what is stated once (the server's refusal, parsed by
 * `parseDependencyCycleMessage`) and the dialog that names a cycle is the one that already
 * exists for it.
 *
 * A hook rather than a component because the control and the dialogs land in different places:
 * the button sits in the header's action cluster, the dialogs anywhere. The Task list the picker
 * chooses from is fetched only once the picker is opened.
 */
export function useBlockedByEditor(task: TaskDto | null, blockedBy: readonly TaskDependencyDto[]) {
  const [editing, setEditing] = useState(false);
  const [cyclePath, setCyclePath] = useState<readonly string[] | null>(null);
  const tasks = trpc.task.list.useQuery({ ...WHOLE_PAGE }, { enabled: editing });
  const items = tasks.data?.items ?? [];

  const button = (
    <Button
      aria-label="Edit what this task is blocked by"
      className="text-muted-foreground"
      onClick={() => setEditing(true)}
      size="icon"
      title="Blocked by…"
      variant="ghost"
    >
      <Lock />
    </Button>
  );
  const dialogs = (
    <>
      <BlockedByDialog
        task={editing ? task : null}
        tasks={items}
        blockers={blockedBy}
        onOpenChange={(open) => {
          if (!open) setEditing(false);
        }}
        onCycle={setCyclePath}
      />
      <DependencyCycleDialog
        path={cyclePath}
        tasks={items}
        onOpenChange={(open) => {
          if (!open) setCyclePath(null);
        }}
      />
    </>
  );
  return { button, dialogs };
}
