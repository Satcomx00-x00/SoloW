"use client";

import type { askUserInputWidget } from "@solow/contracts";
import { ArrowDown, ArrowUp } from "lucide-react";
import { useId, useState } from "react";
import type { z } from "zod";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { WidgetRendererProps } from "./registry";

type AskWidget = z.infer<typeof askUserInputWidget>;

/**
 * The agent's question, asked as a list of options you tick.
 *
 * A list, not a row of pill buttons. Pills were fine for three one-word answers and wrong for
 * everything else: an option with a sentence of explanation had nowhere to put it, four options
 * wrapped into an unreadable second line, and — the part that actually mattered — nothing on a
 * pill says whether it is a thing you *pick one of* or a thing you *tick several of* until you
 * click one and watch what happens. A checkbox and a radio answer that before the first click.
 *
 * The rule it inherits from the permission card, and the reason both exist: only the options the
 * agent itself offered, in the order it listed them. A UI that invented a "none of these" would
 * be answering on the agent's behalf.
 *
 * Three modes, one component, because they are the same question with different arity — and
 * splitting them would put "which options were offered" in three places:
 *
 * - `single` is a radio list and submits on pick. The question has one answer, and a confirm step
 *   would add a click to every use.
 * - `multi` is a checkbox list and needs a Send, since nothing else can say when you are done.
 * - `rank` orders every option; the answer *is* the ordering, so it needs a Send too.
 */
export function AskUserInput({ widget, onRespond, response }: WidgetRendererProps<AskWidget>) {
  const [picked, setPicked] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const groupName = useId();
  const settled = response ?? null;
  const answering = onRespond !== undefined && settled === null;

  // Ranking starts from the agent's own order and is rearranged from there — an empty list would
  // make the operator build the answer out of nothing.
  const order = picked.length > 0 ? picked : widget.options.map((o) => o.id);

  if (!answering) return <AnsweredQuestion widget={widget} response={settled} />;

  const choose = (id: string) => {
    if (widget.mode === "single") {
      onRespond([id], other.trim() || undefined);
      return;
    }
    setPicked((prev) => (prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]));
  };

  const move = (id: string, by: -1 | 1) => {
    const next = [...order];
    const from = next.indexOf(id);
    const to = from + by;
    if (to < 0 || to >= next.length) return;
    const [moved] = next.splice(from, 1);
    if (moved) next.splice(to, 0, moved);
    setPicked(next);
  };

  return (
    <fieldset
      data-widget="ask_user_input"
      data-mode={widget.mode}
      className="surface-edge min-w-0 space-y-2.5 rounded-xl border border-primary/30 bg-primary/[0.04] p-3.5"
    >
      <legend className="sr-only">{widget.prompt}</legend>
      <p className="font-medium text-sm">{widget.prompt}</p>

      {widget.mode === "rank" ? (
        <ol className="space-y-1">
          {order.map((id, index) => {
            const option = widget.options.find((o) => o.id === id);
            if (!option) return null;
            return (
              <li key={id} className={cn(ROW, "bg-card")}>
                <span className="w-4 shrink-0 text-center font-mono text-2xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{option.label}</span>
                  {option.description && (
                    <span className="block text-muted-foreground text-xs">
                      {option.description}
                    </span>
                  )}
                </span>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  aria-label={`Move ${option.label} up`}
                  disabled={index === 0}
                  onClick={() => move(id, -1)}
                >
                  <ArrowUp />
                </Button>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-6 shrink-0"
                  aria-label={`Move ${option.label} down`}
                  disabled={index === order.length - 1}
                  onClick={() => move(id, 1)}
                >
                  <ArrowDown />
                </Button>
              </li>
            );
          })}
        </ol>
      ) : (
        <ul className="space-y-1">
          {widget.options.map((option) => {
            const chosen = picked.includes(option.id);
            const optionId = `${groupName}-${option.id}`;
            return (
              <li key={option.id}>
                {/*
                  The whole row is the control, not just the 16px box beside the label — picking
                  an answer is the entire task here. A `label` bound to the input gives that for
                  free, keyboard included, with no click handler to keep in step.
                */}
                <label
                  htmlFor={optionId}
                  className={cn(
                    ROW,
                    "cursor-pointer transition-colors duration-100 hover:bg-accent/40",
                    chosen ? "border-primary/50 bg-primary/[0.08]" : "bg-card",
                  )}
                >
                  {widget.mode === "multi" ? (
                    <Checkbox
                      id={optionId}
                      checked={chosen}
                      onCheckedChange={() => choose(option.id)}
                      className="mt-0.5 shrink-0"
                    />
                  ) : (
                    // A radio, not a checkbox styled round: this is a one-of-many question, and
                    // the role is what tells a screen reader (and the arrow keys) so.
                    <input
                      type="radio"
                      id={optionId}
                      name={groupName}
                      checked={chosen}
                      onChange={() => choose(option.id)}
                      className="mt-0.5 size-4 shrink-0 appearance-none rounded-full border border-input bg-background/40 transition-colors duration-100 checked:border-primary checked:bg-primary checked:shadow-[inset_0_0_0_3px_var(--color-background)] hover:border-ring/40"
                    />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm">{option.label}</span>
                    {option.description && (
                      <span className="block text-muted-foreground text-xs leading-relaxed">
                        {option.description}
                      </span>
                    )}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
      )}

      {widget.allowOther && (
        <Input
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder="Something else…"
          aria-label="Answer in your own words"
        />
      )}

      {/* `single` needs no Send — the pick is the answer — unless the operator typed instead. */}
      {(widget.mode !== "single" || other.trim().length > 0) && (
        <Button
          type="button"
          size="sm"
          disabled={widget.mode === "multi" && picked.length === 0 && other.trim() === ""}
          onClick={() =>
            onRespond(widget.mode === "rank" ? order : picked, other.trim() || undefined)
          }
        >
          Send answer
        </Button>
      )}
    </fieldset>
  );
}

/** One option row, in every mode and in both states — so a settled list is the same list. */
const ROW = "flex items-start gap-2.5 rounded-lg border px-2.5 py-2";

/**
 * The same question once it has an answer.
 *
 * Still the list, not a sentence naming the winner. What was *offered* is half of what a
 * reviewer needs — "they picked Red" says nothing without the three colours it beat — so the
 * options stay, ticked and dimmed, in the order the agent gave them.
 */
function AnsweredQuestion({
  widget,
  response,
}: {
  widget: AskWidget;
  response: { values: string[]; text: string | null } | null;
}) {
  const chosen = response?.values ?? [];
  // A ranking's answer is its order, so the settled list is re-ordered to match it; every other
  // mode keeps the agent's own order, where the ticks carry the meaning.
  const rows =
    widget.mode === "rank" && chosen.length > 0
      ? chosen.map((id) => widget.options.find((o) => o.id === id)).filter((o) => o !== undefined)
      : widget.options;

  return (
    <div
      data-widget="ask_user_input"
      data-resolution={response ? "settled" : "unanswered"}
      className="min-w-0 space-y-2 rounded-xl border border-dashed bg-card/40 p-3"
    >
      <p className="font-medium text-sm">{widget.prompt}</p>
      <ul className="space-y-1">
        {rows.map((option, index) => {
          const picked = chosen.includes(option.id);
          return (
            <li
              key={option.id}
              className={cn(
                ROW,
                "border-transparent px-2 py-1",
                picked ? "bg-primary/[0.07]" : "opacity-50",
              )}
            >
              {widget.mode === "rank" ? (
                <span className="w-4 shrink-0 text-center font-mono text-2xs text-muted-foreground tabular-nums">
                  {index + 1}
                </span>
              ) : (
                // Disabled rather than swapped for a tick glyph: the same control in the same
                // place, no longer operable, reads as "this is what was chosen" without the
                // reader having to learn a second vocabulary for the settled state. Left in the
                // accessibility tree on purpose — "checked, disabled" is *how* a screen reader
                // is told which option won, and hiding it would leave a bare list of labels.
                <Checkbox checked={picked} disabled className="mt-0.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 text-sm">{option.label}</span>
            </li>
          );
        })}
      </ul>
      {response?.text ? (
        <p className="text-muted-foreground text-xs">They also wrote: “{response.text}”</p>
      ) : null}
      {!response && <p className="text-muted-foreground text-xs">Unanswered — the run moved on.</p>}
    </div>
  );
}
