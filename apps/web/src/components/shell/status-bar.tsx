"use client";

import { Circle, GitBranch, Radio } from "lucide-react";
import { trpc } from "@/trpc/react";

/** VS-Code-style status bar pinned to the bottom of the shell. */
export function StatusBar() {
  const tasks = trpc.task.list.useQuery({});
  const total = tasks.data?.length ?? 0;
  const running = (tasks.data ?? []).filter((t) => t.state === "running").length;
  const review = (tasks.data ?? []).filter((t) => t.state === "review").length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-[11px] text-muted-foreground">
      <span className="flex items-center gap-1">
        <GitBranch className="size-3" /> local workspace
      </span>
      <span className="flex items-center gap-1">
        <Circle className="size-2.5 fill-current text-chart-2" /> dev-owner
      </span>
      <span className="ml-auto flex items-center gap-1 tabular-nums">
        {total} tasks · {running} running · {review} in review
      </span>
      <span className="flex items-center gap-1">
        <Radio className="size-3" /> orchestrator :5001
      </span>
    </footer>
  );
}
