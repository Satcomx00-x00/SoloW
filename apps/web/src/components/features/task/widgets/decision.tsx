"use client";

import type { DecisionWidget } from "@solow/contracts";
import { CircleDot, Scale } from "lucide-react";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

/**
 * A decision the harness made, as a record in the transcript (review analysis, point 3).
 *
 * The transcript copy is inert — it shows the question, every option the harness weighed, the
 * one it took and why. The copy that can be answered is on the Plan tab (`DecisionForm`), where
 * the reviewer's pick is kept in their draft and sent with the approval. Two renderings of one
 * widget, on purpose: a form inside a scrolling log is a form nobody finds again.
 */
export function Decision({ widget }: WidgetRendererProps<DecisionWidget>) {
  return (
    <section
      data-widget="decision"
      aria-label={`Decision: ${widget.question}`}
      className="min-w-0 space-y-2 rounded-xl border border-state-review/30 bg-card/60 p-3"
    >
      <p className="flex items-start gap-2 font-medium text-sm">
        <Scale aria-hidden className="mt-0.5 size-4 shrink-0 text-state-review" />
        <span>{widget.question}</span>
      </p>
      <ol className="space-y-1">
        {widget.options.map((option) => {
          const taken = option.id === widget.chosen;
          return (
            <li
              key={option.id}
              className={cn("flex items-start gap-2 text-xs", !taken && "text-muted-foreground")}
            >
              <CircleDot
                aria-label={taken ? "the harness chose this" : undefined}
                aria-hidden={!taken}
                className={cn(
                  "mt-0.5 size-3.5 shrink-0",
                  taken ? "text-state-review" : "opacity-30",
                )}
              />
              <span>
                <span className={cn(taken && "font-medium text-foreground")}>{option.label}</span>
                {option.why ? <span className="text-muted-foreground"> — {option.why}</span> : null}
              </span>
            </li>
          );
        })}
      </ol>
      {widget.reason ? (
        <p className="text-2xs text-muted-foreground">Why: {widget.reason}</p>
      ) : null}
      <p className="text-2xs text-muted-foreground">
        The reviewer settles this on the Plan tab before the next step runs.
      </p>
    </section>
  );
}
