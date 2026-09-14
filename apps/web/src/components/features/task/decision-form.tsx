"use client";

import type { DecisionWidget } from "@solow/contracts";
import { Scale } from "lucide-react";
import { useId } from "react";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

/** The reviewer's answer to one decision, as the draft keeps it. */
export interface DecisionAnswer {
  id: string;
  choice: string;
  note?: string | undefined;
}

/**
 * A decision the harness made, as a form on the Plan tab (review analysis, point 3).
 *
 * The harness's pick is marked and preselected as its recommendation, but not *chosen*: the
 * reviewer has to take a side, and the gate waits until every decision has one. "Other" opens a
 * line for the choice the harness did not offer. What is picked here is what the next Step is
 * briefed with, under "Reviewer's decisions" — so the words are the reviewer's, not a click.
 */
export function DecisionForm({
  widget,
  answer,
  onAnswer,
  disabled = false,
}: {
  widget: DecisionWidget;
  answer: DecisionAnswer | null;
  onAnswer: (answer: DecisionAnswer) => void;
  disabled?: boolean;
}) {
  const name = useId();
  const choice = answer?.choice ?? null;
  return (
    <fieldset
      className={cn(
        "m-0 space-y-2 rounded-xl border bg-card/60 p-3",
        choice === null ? "border-state-review/40" : "border-feedback-ok/40",
      )}
      data-decision={widget.id}
      // Read by the gate's Approve when it sends the reviewer here: the first unsettled one is
      // where the focus lands.
      data-settled={choice !== null}
      disabled={disabled}
    >
      <legend className="flex items-center gap-2 px-1 font-medium text-sm">
        <Scale aria-hidden className="size-4 shrink-0 text-state-review" />
        {widget.question}
        {choice === null ? (
          <span className="rounded-full bg-state-review/15 px-1.5 text-2xs text-state-review">
            to settle
          </span>
        ) : null}
      </legend>
      <div className="space-y-1">
        {widget.options.map((option) => {
          const recommended = option.id === widget.chosen;
          return (
            <label
              key={option.id}
              className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-accent/40"
            >
              <input
                type="radio"
                name={name}
                value={option.id}
                checked={choice === option.id}
                onChange={() => onAnswer({ id: widget.id, choice: option.id })}
                className="mt-0.5"
              />
              <span>
                <span className="font-medium">{option.label}</span>
                {recommended ? (
                  <span className="ml-1.5 rounded bg-muted px-1 text-2xs text-muted-foreground">
                    harness's pick
                  </span>
                ) : null}
                {option.why ? <span className="text-muted-foreground"> — {option.why}</span> : null}
              </span>
            </label>
          );
        })}
        <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 text-xs hover:bg-accent/40">
          <input
            type="radio"
            name={name}
            value="other"
            checked={choice === "other"}
            onChange={() => onAnswer({ id: widget.id, choice: "other", note: answer?.note ?? "" })}
            className="mt-0.5"
          />
          <span className="font-medium">Something else</span>
        </label>
        {choice === "other" ? (
          // A label that stays: the placeholder is an example and goes the moment they type.
          <div className="space-y-1 pt-1">
            <label htmlFor={`${name}-note`} className="block text-2xs text-muted-foreground">
              Your decision — sent to the next step's harness verbatim
            </label>
            <Textarea
              id={`${name}-note`}
              rows={2}
              value={answer?.note ?? ""}
              placeholder="e.g. Keep both, but put the migration behind a flag."
              onChange={(e) => onAnswer({ id: widget.id, choice: "other", note: e.target.value })}
              className="min-h-12 text-xs"
            />
          </div>
        ) : null}
      </div>
      {widget.reason ? (
        <p className="text-2xs text-muted-foreground">Harness's reason: {widget.reason}</p>
      ) : null}
    </fieldset>
  );
}
