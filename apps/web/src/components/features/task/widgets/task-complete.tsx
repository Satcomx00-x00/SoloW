"use client";

import type { Widget } from "@solow/contracts";
import { CircleCheck, CircleDashed, CircleSlash, OctagonMinus } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

/**
 * The harness saying how its run ended.
 *
 * Worth drawing rather than folding into the state change beneath it, because the two say
 * different things. "This Task is in Review" is SoloW's record; this is the harness's own
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
      aria-label="Harness report"
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
      {widget.openItems && widget.openItems.length > 0 && (
        // Said as a list rather than folded into the summary: "not done" at the end of a
        // paragraph is the sentence a reviewer skips, and it is the one the gate repeats.
        <ul className="space-y-0.5 text-xs" aria-label="Open items">
          {widget.openItems.map((item) => (
            <li key={item.label} className="flex items-start gap-1.5">
              <CircleDashed aria-hidden className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <span className="font-medium">{item.label}</span>
                {item.why ? <span className="text-foreground/70"> — {item.why}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      )}
      {widget.decision && (
        // The answer to the Step's branch question, as a fact of the report — it is what the
        // workflow routes on, so a reviewer should be able to see it without reading for it.
        <p className="font-mono text-2xs text-foreground/70">
          Decision: <span className="font-semibold">{widget.decision}</span>
        </p>
      )}
    </section>
  );
}
