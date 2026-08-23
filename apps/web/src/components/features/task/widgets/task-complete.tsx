"use client";

import type { Widget } from "@gatecontrol/contracts";
import { CircleCheck, CircleSlash, OctagonMinus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

/**
 * The agent saying how its run ended.
 *
 * Worth drawing rather than folding into the state change beneath it, because the two say
 * different things. "This Task is in Review" is GateControl's record; this is the agent's own
 * account, in its own words, and it is the only place a reviewer learns *why* there is nothing to
 * look at — that the brief was already satisfied, or that it stopped because it could not go on.
 *
 * Deliberately inert. It reports; it does not decide, and it must not look like it does: the
 * review gate is a person's, because the party that did the work is not the party that signs it
 * off. So there is no button here and no colour that reads as approval — `nothing_to_do` and
 * `blocked` are the two an eye should catch, and `changes_ready` is the ordinary ending that
 * needs no announcement beyond the diff it points at.
 */
const OUTCOME = {
  changes_ready: {
    icon: CircleCheck,
    label: "Finished — changes ready",
    tone: "border-state-done/30 bg-state-done/8 text-state-done",
  },
  nothing_to_do: {
    icon: CircleSlash,
    label: "Finished — nothing to do",
    tone: "border-state-idle/30 bg-state-idle/8 text-state-idle",
  },
  blocked: {
    icon: OctagonMinus,
    label: "Stopped — blocked",
    tone: "border-state-review/35 bg-state-review/10 text-state-review",
  },
} as const;

export function TaskComplete({
  widget,
}: WidgetRendererProps<Extract<Widget, { kind: "task_complete" }>>) {
  const { icon: Icon, label, tone } = OUTCOME[widget.outcome];
  return (
    <section
      aria-label="Agent report"
      className={cn("space-y-1.5 rounded-lg border px-3.5 py-3", tone)}
    >
      <p className="flex items-center gap-2 font-medium text-sm">
        <Icon aria-hidden className="size-4 shrink-0" />
        {label}
      </p>
      {widget.summary && (
        <p className="whitespace-pre-wrap break-words text-foreground/80 text-xs leading-relaxed">
          {widget.summary}
        </p>
      )}
    </section>
  );
}
