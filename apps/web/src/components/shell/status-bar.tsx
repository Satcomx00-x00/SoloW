"use client";

import { CircleUser, FlaskConical, GitBranch } from "lucide-react";
import { STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * VS-Code-style status bar pinned to the bottom of the shell.
 *
 * Everything here is read from live state. It used to hard-code `dev-owner` and the
 * orchestrator's port, which was harmless while the local stand-in was the only way to run the
 * app and became untrue the moment real sign-in existed: a signed-in Owner was told they were
 * the dev stand-in, and the port was whatever the string said rather than whatever was
 * configured. A status bar that states something false is worse than one that omits it.
 *
 * `identity` arrives as a prop from the layout, which has already resolved the session on the
 * server. Asking the browser for it again would render "dev owner" first and correct itself a
 * moment later, which is the same wrong claim, just briefer.
 */
export interface ShellIdentity {
  name: string;
  email: string;
}

export function StatusBar({ identity }: { identity: ShellIdentity | null }) {
  const tasks = trpc.task.list.useQuery({});
  const rows = tasks.data ?? [];
  const running = rows.filter((t) => t.state === "running").length;
  const review = rows.filter((t) => t.state === "review").length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-4 border-t bg-sidebar px-3 text-2xs text-muted-foreground">
      <span className="flex items-center gap-1.5">
        <GitBranch className="size-3" aria-hidden /> local workspace
      </span>
      {identity ? (
        <span className="flex items-center gap-1.5">
          <CircleUser className="size-3" aria-hidden />
          {identity.name || identity.email}
        </span>
      ) : (
        <span
          className="flex items-center gap-1.5 text-state-parked"
          title="Signed in as the local development owner, not a real account"
        >
          <FlaskConical className="size-3" aria-hidden /> dev owner
        </span>
      )}
      <span className="ml-auto flex items-center gap-3 tabular-nums">
        <span>{rows.length === 1 ? "1 task" : `${rows.length} tasks`}</span>
        {running > 0 && (
          <span className={cn("flex items-center gap-1.5", STATE_STYLE.running.textClassName)}>
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {running} running
          </span>
        )}
        {/* The only thing on this bar a person has to act on, so it is the only thing lit. */}
        {review > 0 && (
          <span className={cn("flex items-center gap-1.5", STATE_STYLE.review.textClassName)}>
            <span className="size-1.5 rounded-full bg-current" aria-hidden />
            {review} awaiting review
          </span>
        )}
      </span>
    </footer>
  );
}
