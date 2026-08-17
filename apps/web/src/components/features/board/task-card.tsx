import type { TaskDto } from "@gatecontrol/contracts";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";

/** A single Task card on the board. `actions` (optional) renders lifecycle controls. */
export function TaskCard({ task, actions }: { task: TaskDto; actions?: ReactNode }) {
  return (
    <Card className="gap-0 py-3 shadow-xs">
      <CardContent className="px-3">
        <p className="font-medium text-sm leading-snug">{task.title}</p>
        {task.failureReason ? (
          <Badge variant="destructive" className="mt-2">
            {task.failureReason}
          </Badge>
        ) : (
          <p className="mt-1 font-mono text-muted-foreground text-xs">
            {task.resultBranch ?? task.id.slice(0, 8)}
          </p>
        )}
        {actions ? <div className="mt-3 flex gap-2">{actions}</div> : null}
      </CardContent>
    </Card>
  );
}
