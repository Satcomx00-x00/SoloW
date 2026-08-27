"use client";

import { CircleUser, FlaskConical, GitBranch } from "lucide-react";
import { useAppContext } from "@/lib/app-context";
import { contribute, statusItemRegistry } from "@/lib/contributions";
import { countLabel, pageRows, WHOLE_PAGE } from "@/lib/paged";
import { STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";

/**
 * The status bar's own segments, as registrations (issue #3).
 *
 * These used to be branches inside the bar itself. Nothing about them changed except who decides
 * whether they appear: the identity/dev-owner split is now two contributions with opposite `when`
 * predicates rather than a ternary, so the bar has no idea either exists — which is the whole
 * point, because a feature module elsewhere can now add a segment the same way.
 *
 * Each counter keeps its own query. Co-located state is what a contributed item has to be allowed
 * to have, and React Query dedupes the shared `task.list` key, so three items cost one request.
 */

function WorkspaceItem() {
  return (
    <span className="flex items-center gap-1.5">
      <GitBranch className="size-3" aria-hidden /> local workspace
    </span>
  );
}

function IdentityItem() {
  const { identity } = useAppContext();
  if (!identity) return null;
  return (
    <span className="flex items-center gap-1.5">
      <CircleUser className="size-3" aria-hidden />
      {identity.name || identity.email}
    </span>
  );
}

/**
 * The local stand-in owner. It used to be hard-coded, which told a genuinely signed-in Owner they
 * were the dev stand-in; saying so only when there is no identity is the correction.
 */
function DevOwnerItem() {
  return (
    <span
      className="flex items-center gap-1.5 text-state-parked"
      title="Signed in as the local development owner, not a real account"
    >
      <FlaskConical className="size-3" aria-hidden /> dev owner
    </span>
  );
}

function TaskCountItem() {
  const tasks = trpc.task.list.useQuery({ ...WHOLE_PAGE });
  // `500+ tasks` rather than `500 tasks` past the page bound. A status bar is exactly where a
  // number gets believed without being checked, so it has to be one this read can support.
  const { rows, truncated } = pageRows(tasks.data);
  return (
    <span>
      {rows.length === 1 && !truncated ? "1 task" : `${countLabel(rows.length, truncated)} tasks`}
    </span>
  );
}

function RunningTasksItem() {
  const tasks = trpc.task.list.useQuery({ ...WHOLE_PAGE });
  const { rows, truncated } = pageRows(tasks.data);
  const running = rows.filter((t) => t.state === "running").length;
  if (running === 0) return null;
  return (
    <span className={cn("flex items-center gap-1.5", STATE_STYLE.running.textClassName)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {countLabel(running, truncated)} running
    </span>
  );
}

/** The only thing on this bar a person has to act on, so it is the only thing lit. */
function AwaitingReviewItem() {
  const tasks = trpc.task.list.useQuery({ ...WHOLE_PAGE });
  const { rows, truncated } = pageRows(tasks.data);
  const review = rows.filter((t) => t.state === "review").length;
  if (review === 0) return null;
  return (
    <span className={cn("flex items-center gap-1.5", STATE_STYLE.review.textClassName)}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {countLabel(review, truncated)} awaiting review
    </span>
  );
}

contribute(statusItemRegistry, {
  id: "status.workspace",
  priority: 10,
  render: { label: "Workspace", slot: "left", Component: WorkspaceItem },
});

contribute(statusItemRegistry, {
  id: "status.identity",
  priority: 20,
  when: (ctx) => ctx.identity !== null,
  render: { label: "Signed-in account", slot: "left", Component: IdentityItem },
});

contribute(statusItemRegistry, {
  id: "status.dev-owner",
  priority: 20,
  when: (ctx) => ctx.identity === null,
  render: { label: "Local development owner", slot: "left", Component: DevOwnerItem },
});

contribute(statusItemRegistry, {
  id: "status.tasks",
  priority: 10,
  render: { label: "Task count", slot: "right", Component: TaskCountItem },
});

contribute(statusItemRegistry, {
  id: "status.running",
  priority: 20,
  render: { label: "Running tasks", slot: "right", Component: RunningTasksItem },
});

contribute(statusItemRegistry, {
  id: "status.review",
  priority: 30,
  render: { label: "Tasks awaiting review", slot: "right", Component: AwaitingReviewItem },
});
