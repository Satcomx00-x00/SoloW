"use client";

import type { stepCardWidget } from "@solow/contracts";
import type { LucideIcon } from "lucide-react";
import { Check, Circle, CircleDot, TriangleAlert } from "lucide-react";
import type { z } from "zod";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

type StepCardWidget = z.infer<typeof stepCardWidget>;

/**
 * The agent's own plan, as a checklist it re-emits as work proceeds (`step_card`).
 *
 * Presentational: nothing here is answered. Its value is that "what is this run doing and how far
 * in is it" stops being a question you answer by reading two hundred lines of transcript.
 *
 * Each emission is a new row rather than an update of the last one. That is deliberate — the log
 * is append-only and a plan that rewrote its own history would destroy the evidence of what the
 * agent believed earlier, which is often the interesting part of a review.
 */
export function StepCard({ widget }: WidgetRendererProps<StepCardWidget>) {
  const done = widget.steps.filter((s) => s.state === "done").length;

  return (
    <section
      data-widget="step_card"
      aria-label={widget.title ?? "Plan"}
      className="min-w-0 space-y-2 rounded-xl border bg-card/60 p-3"
    >
      <div className="flex items-baseline justify-between gap-2">
        {widget.title && <h3 className="font-medium text-sm">{widget.title}</h3>}
        <span className="font-mono text-2xs text-muted-foreground tabular-nums">
          {done}/{widget.steps.length}
        </span>
      </div>
      <ol className="space-y-1">
        {widget.steps.map((step) => {
          const { icon: Icon, tone } = STEP_STYLE[step.state];
          return (
            <li key={step.id} className="flex items-start gap-2 text-sm">
              <Icon aria-hidden className={cn("mt-0.5 size-3.5 shrink-0", tone)} />
              <span className="min-w-0 flex-1">
                <span
                  className={cn(
                    step.state === "done" && "text-muted-foreground line-through",
                    step.state === "active" && "font-medium",
                  )}
                >
                  {step.label}
                </span>
                {step.note && (
                  <span className="block text-muted-foreground text-xs">{step.note}</span>
                )}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Reuses the board's state hues, so "in progress" is the same blue everywhere in the app. */
const STEP_STYLE: Record<
  StepCardWidget["steps"][number]["state"],
  { icon: LucideIcon; tone: string }
> = {
  todo: { icon: Circle, tone: "text-muted-foreground/50" },
  active: { icon: CircleDot, tone: "text-state-running" },
  done: { icon: Check, tone: "text-state-done" },
  blocked: { icon: TriangleAlert, tone: "text-state-failed" },
};
