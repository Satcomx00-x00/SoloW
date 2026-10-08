"use client";

import type { AttentionItemDto } from "@solow/contracts";
import { CircleAlert, CircleCheck, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { type ComponentProps, useEffect, useRef } from "react";
import { useRelativeAge } from "@/components/hooks/use-relative-age";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { contribute, statusItemRegistry } from "@/lib/contributions";
import { relativeAge } from "@/lib/relative-time";
import { attentionCopy, type HealthTone, healthSummary } from "@/lib/run-health";
import { taskHref } from "@/lib/task-href";
import { cn } from "@/lib/utils";
import { useWorkspaceEventStatus } from "@/lib/workspace-events";
import { trpc } from "@/trpc/react";

/**
 * The product's own health on the status bar (FINDINGS F3): whether the services a run needs are
 * answering, and which Tasks need a person because their run failed or stopped moving. The
 * notice when one joins the list is `AttentionNotices`, mounted by the shell, so hiding these
 * segments from the bar never silences it.
 */

/**
 * How often the bar re-asks whether the services are up.
 *
 * The one poll on this bar, and it has to be one: an engine that stops answering announces
 * nothing, and the hub that would carry an announcement is one of the two things being checked.
 * A minute is a local request to this machine, and short enough that "why did my run not start"
 * finds the answer already on screen.
 */
export const HEALTH_POLL_MS = 60_000;

const TONE_TEXT: Record<HealthTone, string> = {
  ok: "text-muted-foreground",
  caution: "text-feedback-caution",
  error: "text-feedback-error",
};

const TONE_DOT: Record<HealthTone, string> = {
  ok: "bg-feedback-ok",
  caution: "bg-feedback-caution",
  error: "bg-feedback-error",
};

function HealthItem() {
  const utils = trpc.useUtils();
  const health = trpc.health.status.useQuery(undefined, { refetchInterval: HEALTH_POLL_MS });

  // The hub is the orchestrator: when the shared socket drops or comes back, the answer above has
  // probably just changed, so ask now rather than at the next tick. Not on mount — the query has
  // only just asked.
  const stream = useWorkspaceEventStatus();
  const firstStream = useRef(true);
  useEffect(() => {
    if (firstStream.current) {
      firstStream.current = false;
      return;
    }
    if (stream === "open" || stream === "reconnecting" || stream === "error") {
      void utils.health.status.invalidate();
    }
  }, [stream, utils]);

  const checked = useRelativeAge(health.data?.checkedAt ?? null);
  if (!health.data) return null;
  const summary = healthSummary(health.data);

  return (
    <Popover>
      <PopoverTrigger
        className={cn(
          "flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:text-foreground",
          TONE_TEXT[summary.tone],
        )}
        aria-label={`Service health: ${summary.label}`}
      >
        <span className={cn("size-1.5 rounded-full", TONE_DOT[summary.tone])} aria-hidden />
        {summary.label}
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-80 p-3 text-xs">
        <p className="font-medium text-sm">
          {summary.tone === "ok" ? "Everything a run needs is answering" : "Runs are affected"}
        </p>
        <ul className="mt-2 flex flex-col gap-2">
          {summary.services.map((line) => {
            const Icon = line.ok ? CircleCheck : CircleAlert;
            return (
              <li key={line.name} className="flex gap-2">
                <Icon
                  aria-hidden
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    line.ok ? "text-feedback-ok" : "text-feedback-error",
                  )}
                />
                <span>
                  <span className="font-medium">{line.name}</span>
                  <span className="text-muted-foreground"> — {line.text}</span>
                </span>
              </li>
            );
          })}
        </ul>
        {checked ? <p className="mt-2 text-2xs text-muted-foreground">Checked {checked}</p> : null}
      </PopoverContent>
    </Popover>
  );
}

/** How many rows the list shows before it says how many more there are. */
const MAX_LISTED = 8;

/**
 * One row of the list. Spreads what the menu item hands it (`asChild`): its ref, role and key
 * handling are what make the row reachable from the keyboard, and dropping them leaves a link the
 * menu cannot focus.
 */
function AttentionRow({
  item,
  className,
  ...props
}: { item: AttentionItemDto } & Omit<ComponentProps<typeof Link>, "href">) {
  const { label, detail } = attentionCopy(item);
  const Icon = item.kind === "failed" ? CircleAlert : TriangleAlert;
  return (
    <Link
      {...props}
      href={taskHref({ id: item.taskId, state: item.state })}
      title={detail}
      className={cn("flex w-full min-w-0 items-center gap-2", className)}
    >
      <Icon
        aria-hidden
        className={cn(
          "size-3.5 shrink-0",
          item.kind === "failed" ? "text-state-failed" : "text-feedback-caution",
        )}
      />
      <span className="min-w-0 flex-1 truncate">{item.title}</span>
      <span className="shrink-0 text-muted-foreground text-xs">
        {label} · {relativeAge(item.since)}
      </span>
    </Link>
  );
}

/**
 * The "needs attention" list: every Task whose run failed or is stuck, in one place. A segment
 * rather than a page because the list is short when things are well and one glance is the whole
 * job; each row opens the Task, which is where the fix (Retry, Stop, decide again) lives.
 */
function AttentionItem() {
  const attention = trpc.health.attention.useQuery();
  const items = attention.data?.items ?? [];
  if (items.length === 0) return null;

  const failed = items.some((i) => i.kind === "failed");
  const listed = items.slice(0, MAX_LISTED);
  const plus = attention.data?.truncated ? "+" : "";
  const more = items.length - listed.length;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          "flex items-center gap-1.5 rounded-sm px-1 transition-colors hover:text-foreground",
          failed ? "text-state-failed" : "text-feedback-caution",
        )}
      >
        <TriangleAlert className="size-3" aria-hidden />
        {items.length}
        {plus} need{items.length === 1 && !plus ? "s" : ""} attention
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-96 max-w-[calc(100vw-2rem)]">
        <DropdownMenuLabel className="text-muted-foreground text-xs">
          Failed or stuck runs
        </DropdownMenuLabel>
        {listed.map((item) => (
          <DropdownMenuItem key={`${item.taskId}:${item.cause}`} asChild>
            <AttentionRow item={item} />
          </DropdownMenuItem>
        ))}
        {more > 0 ? (
          <p className="px-2 py-1.5 text-muted-foreground text-xs">
            and {more}
            {plus} more
          </p>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

contribute(statusItemRegistry, {
  id: "status.attention",
  // Left, beside the running and in-review tabs (25): it is the other "look at this" on the bar.
  priority: 30,
  render: { label: "Failed and stuck runs", slot: "left", Component: AttentionItem },
});

contribute(statusItemRegistry, {
  id: "status.health",
  // Right, before the sync action (40): a reading, so it sits with the other readings.
  priority: 30,
  render: { label: "Service health", slot: "right", Component: HealthItem },
});
