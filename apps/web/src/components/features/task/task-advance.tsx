"use client";

import type { TaskState } from "@solow/contracts";
import { nextTaskState, previousTaskState } from "@solow/core";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { STATE_LABELS } from "@/lib/task-states";

/**
 * Move a Task one column along the lifecycle, from the Task page.
 *
 * Until this existed the only way to advance a Task was to drag its card on `/board` — which
 * meant leaving the page that holds the evidence you are advancing it *on*. Someone reading a
 * finished run had to memorise the verdict, navigate away, find the card again and drag it.
 *
 * The pair is deliberately presentational: it takes a state and hands back a destination, and it
 * never touches tRPC. The workspace already owns the `move` mutation — its optimistic update,
 * its error toast, its pending flag — and a second call site issuing the same mutation is a
 * second place for those three to be got wrong. It also means this file is testable by rendering
 * it, with no query client and no harness.
 *
 * Where a direction may go is asked of `@solow/core`, which derives it from the same
 * transition table the server validates against, so an arrow can never offer a move the server
 * then refuses.
 */
export function TaskAdvance({
  state,
  onMove,
  pending,
}: {
  state: TaskState;
  onMove: (to: TaskState) => void;
  pending?: boolean;
}) {
  const back = previousTaskState(state);
  // Running is the one state whose forward exit is not the operator's to write. `review`,
  // `parked` and `failed` are all outcomes the orchestrator announces when the run ends; writing
  // `review` by hand puts the review gate on screen while the agent is still mid-turn, before
  // the workflow is waiting for a decision. An Approve pressed there is recorded and published
  // into nothing — the run reaches its own gate afterwards and waits out the seven-day timeout
  // for a decision that was already given, and the work is discarded with nothing committed.
  const forward = state === "running" ? null : nextTaskState(state);
  const busy = pending ?? false;

  return (
    <TooltipProvider delayDuration={200}>
      <div className="flex shrink-0 items-center gap-0.5">
        <Step direction="back" to={back} onMove={onMove} pending={busy} />
        <Step direction="forward" to={forward} onMove={onMove} pending={busy} />
      </div>
    </TooltipProvider>
  );
}

/**
 * One arrow. A direction with no legal target is disabled rather than dropped: a control that
 * appears and disappears as a Task moves is one people stop reaching for, because they can no
 * longer predict whether it will be there — and a `backlog` Task would lose its back arrow, a
 * `done` Task both, shifting the other arrow under the cursor at the moment it is clicked.
 *
 * The label names the destination — "Move to Review", not "Forward". Seven states in a line are
 * nothing an icon-only arrow can convey, and a screen-reader user given "next" has to hold the
 * whole lifecycle in their head to know what pressing it does.
 */
function Step({
  direction,
  to,
  onMove,
  pending,
}: {
  direction: "back" | "forward";
  to: TaskState | null;
  onMove: (to: TaskState) => void;
  pending: boolean;
}) {
  const Icon = direction === "back" ? ChevronLeft : ChevronRight;
  const label = to
    ? `Move to ${STATE_LABELS[to]}`
    : direction === "back"
      ? "No state to move back to"
      : "No state to move forward to";

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {/* A disabled button fires no pointer events, so the tooltip hangs off a wrapper. */}
        <span className="inline-flex">
          <Button
            aria-label={label}
            className="text-muted-foreground"
            disabled={to === null || pending}
            onClick={() => to && onMove(to)}
            size="icon-sm"
            variant="ghost"
          >
            <Icon />
          </Button>
        </span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
