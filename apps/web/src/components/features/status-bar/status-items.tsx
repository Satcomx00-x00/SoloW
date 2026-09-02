"use client";

import { CircleUser, FlaskConical, GitBranch, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useRelativeAge } from "@/components/hooks/use-relative-age";
import { useAppContext } from "@/lib/app-context";
import { contribute, statusItemRegistry } from "@/lib/contributions";
import { countLabel, pageRows, WHOLE_PAGE } from "@/lib/paged";
import { STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { useWorkspaceEvents } from "@/lib/workspace-events";
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

/**
 * How long a request keeps saying "syncing" when nothing tells it otherwise.
 *
 * A pass that changed nothing announces nothing — that is the point of the announcement — so
 * "the mirror moved" cannot be the only way this resolves, or a sync that found no news would
 * spin for ever. The watermark is the reliable signal (it advances on every successful pass,
 * newsworthy or not), and this is the backstop for the third case: a pass that failed, where no
 * watermark advances at all. Thirty seconds because that is longer than a sweep of a realistic
 * number of repositories and shorter than anyone's patience with a spinner that means nothing.
 */
const SYNC_WAIT_CAP_MS = 30_000;
/** How often the local watermark is re-read *while someone is watching a spinner*, and only then. */
const SYNC_WAIT_POLL_MS = 2_000;

/**
 * Has the pass we asked for actually run?
 *
 * Its own function, and exported, because it is the one piece of this segment that is a decision
 * rather than a rendering — and because asserting it through the component would mean waiting out
 * a real `SYNC_WAIT_POLL_MS` in a test, which is a test that measures the machine it runs on.
 *
 * The watermark is the right signal precisely because it is not the announcement: a pass that
 * found no news announces nothing (deliberately — see `sync/announce.ts`) but still advances
 * every repository it read. Strictly greater, never equal: the watermark stamped *before* the
 * request cannot be evidence that the request was served.
 */
export function syncLanded(requestedAt: string, syncedAt: string | null): boolean {
  return syncedAt !== null && syncedAt > requestedAt;
}

/**
 * Sync everything now, and say how current the mirror is.
 *
 * The one thing on this bar that acts on the world rather than describing it, and the escape
 * hatch that makes the background cadences defensible: issues are polled every five minutes and
 * a repository's label vocabulary every six hours, which is right for a mirror nobody is staring
 * at and wrong for the person who just changed something on GitHub and came back here.
 *
 * The reading is deliberately pessimistic — it is the age of the repository that is *furthest*
 * behind, not an average and not the newest. A bar that said "synced just now" while one
 * connection had been rate limited since yesterday would be wrong in exactly the situation it
 * exists for.
 *
 * There is no polling here at rest. The status is a local read served from cache, refreshed when
 * the poll announces it moved. The one interval in this file runs only between pressing the
 * button and the pass landing, which is the one moment polling is the right answer: someone is
 * watching, and the thing they are waiting for has no other way to report in.
 */
function SyncItem() {
  const utils = trpc.useUtils();
  /** When the current request was made, or null when nothing is in flight. */
  const [awaiting, setAwaiting] = useState<string | null>(null);
  /** Set when there was no durable engine to hand the request to — see `requestWorkspaceSync`. */
  const [unavailable, setUnavailable] = useState(false);

  const status = trpc.workspace.syncStatus.useQuery(undefined, {
    refetchInterval: awaiting ? SYNC_WAIT_POLL_MS : false,
    // The interval must run on its own terms, not React Query's focus heuristic. It only ever
    // exists between a click and the pass landing, and someone who pressed sync and switched
    // tabs still wants the answer waiting for them rather than a spinner frozen at the moment
    // they looked away.
    refetchIntervalInBackground: true,
  });

  const syncNow = trpc.workspace.syncNow.useMutation({
    onSuccess: (result) => {
      setUnavailable(!result.accepted);
      if (!result.accepted) setAwaiting(null);
    },
    onError: () => {
      setUnavailable(true);
      setAwaiting(null);
    },
  });

  // The pass landed and had news. The watermark below catches the quieter cases.
  const onMirror = useCallback(() => {
    setAwaiting(null);
    void utils.workspace.syncStatus.invalidate();
  }, [utils]);
  useWorkspaceEvents(onMirror);

  const syncedAt = status.data?.syncedAt ?? null;
  // Ticked rather than computed once: this bar is on screen all day, and after the spinner
  // resolves nothing else schedules a render — the age would freeze at whatever it last said.
  const age = useRelativeAge(syncedAt);
  useEffect(() => {
    // The watermark passed the moment we asked: the pass ran, whether or not it found anything.
    if (awaiting && syncLanded(awaiting, syncedAt)) setAwaiting(null);
  }, [awaiting, syncedAt]);

  useEffect(() => {
    if (!awaiting) return;
    // The backstop, for a pass that failed and advanced no watermark at all. What is shown
    // afterwards is whatever the rows actually say — including "3 behind", which is the truth.
    const timer = setTimeout(() => setAwaiting(null), SYNC_WAIT_CAP_MS);
    return () => clearTimeout(timer);
  }, [awaiting]);

  const request = () => {
    setUnavailable(false);
    setAwaiting(new Date().toISOString());
    syncNow.mutate();
  };

  // Nothing linked to a provider is nothing to sync, and a button that cannot do anything is
  // worse than no button: it invites a press and answers with silence.
  if (!status.data || status.data.repositories === 0) return null;

  const { stale, staleReason } = status.data;
  const pending = awaiting !== null;
  const label = pending
    ? "syncing…"
    : unavailable
      ? "sync unavailable"
      : stale > 0
        ? `${stale} behind`
        : age
          ? `synced ${age}`
          : "not synced yet";

  return (
    <button
      type="button"
      onClick={request}
      disabled={pending}
      // The title carries what the label cannot: which repository is behind and why, and the
      // exact time rather than a rounded age.
      title={
        unavailable
          ? "No orchestrator to run the sync — start the stack, or check SOLOW_ORCHESTRATOR_URL"
          : staleReason
            ? `${stale} of ${status.data.repositories} repositories behind: ${staleReason}`
            : syncedAt
              ? `Oldest watermark: ${new Date(syncedAt).toLocaleString()} — click to sync every linked repository now`
              : "Click to sync every linked repository now"
      }
      className={cn(
        "flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:text-foreground",
        "disabled:cursor-default disabled:hover:text-muted-foreground",
        stale > 0 && !pending && "text-state-parked",
        unavailable && !pending && "text-state-parked",
      )}
    >
      <RefreshCw className={cn("size-3", pending && "animate-spin")} aria-hidden />
      {label}
    </button>
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

contribute(statusItemRegistry, {
  id: "status.sync",
  // Last on the right, which on this bar is the far edge — the conventional home for the one
  // segment that is an action rather than a reading.
  priority: 40,
  render: { label: "Mirror sync", slot: "right", Component: SyncItem },
});
