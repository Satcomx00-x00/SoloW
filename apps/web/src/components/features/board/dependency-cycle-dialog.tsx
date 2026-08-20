"use client";

import type { TaskDto } from "@gatecontrol/contracts";
import { ArrowRight, RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * The refusal surface for a dependency that would close a cycle (issue #6 AC-2).
 *
 * A generic "request failed" would leave the Owner with a board that refuses an edge and no way
 * to know which of the existing ones to withdraw — so this names the path, and names it in the
 * titles the Owner wrote rather than the ids the server had to send.
 */
export function DependencyCycleDialog({
  path,
  tasks,
  onOpenChange,
}: {
  /** The offending cycle as Task ids, or null when there is nothing to report. */
  path: readonly string[] | null;
  tasks: readonly TaskDto[];
  onOpenChange: (open: boolean) => void;
}) {
  // A hop can name a Task that is not on the loaded board (filtered out, or created elsewhere);
  // showing its short id beats dropping the hop and printing a cycle that does not close.
  const label = (id: string) => tasks.find((task) => task.id === id)?.title ?? id.slice(0, 8);

  // The first and last hop are the same Task by construction, so an id alone is not a stable
  // key — the position in the cycle is what identifies a hop.
  const hops = (path ?? []).map((id, position) => ({ id, position }));

  return (
    <Dialog open={path !== null} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>That would create a circular dependency</DialogTitle>
          <DialogDescription>
            Each task here waits on the next, and the last one waits on the first — so none of them
            could ever start. Withdraw one of these links, then try again.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex flex-wrap items-center gap-1.5 rounded-lg border bg-card px-3 py-2.5 text-sm">
          {hops.map((hop) => (
            <li key={`${hop.position}-${hop.id}`} className="flex items-center gap-1.5">
              {hop.position > 0 && (
                <ArrowRight className="size-3 shrink-0 text-muted-foreground" aria-hidden />
              )}
              <span className="font-medium">{label(hop.id)}</span>
            </li>
          ))}
        </ol>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            <RefreshCcw /> Pick another task
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
