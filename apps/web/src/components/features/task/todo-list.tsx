"use client";

import type { SessionEventDto, TodoItem } from "@gatecontrol/contracts";
import { LoaderCircle, Square, SquareCheckBig } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The agent's own todo list, drawn as a checklist.
 *
 * The list is the one artefact in a run that says what the agent thinks it is *going* to do,
 * which is the question a reviewer watching a long run keeps asking and which the transcript
 * answers only in retrospect. It sits beside the Changes panel for that reason: plan on one
 * side, result on the other.
 *
 * **Nothing here is a control.** No `<input>`, no button, no pointer affordance — deliberately,
 * and this is the whole reason the component draws boxes by hand instead of reaching for
 * `ui/checkbox`. The list belongs to the agent, which rewrites it wholesale on its own schedule;
 * a box a person could tick would either be overwritten by the next `TodoWrite` a second later
 * or, worse, leave the reader believing they had recorded something about work only the agent
 * can do. A checkbox that lies about who owns the state is worse than a glyph that cannot be
 * clicked, so these are glyphs.
 *
 * The three states are told apart by shape and by decoration, never by hue alone — an empty box,
 * a spinner, a checked box with the text struck through — because a colour-blind reader is
 * entitled to the same distinction (WCAG 1.4.1; the same rule that shapes `lib/task-states.ts`).
 * The spinner uses the shared `.spinner` class rather than `animate-spin` so it inherits the
 * `prefers-reduced-motion` carve-out in `globals.css`, which swaps rotation for brightness.
 */

const STATE: Record<
  TodoItem["status"],
  { icon: typeof Square; label: string; iconClassName: string; textClassName: string }
> = {
  pending: {
    icon: Square,
    label: "To do",
    iconClassName: "text-muted-foreground/50",
    textClassName: "",
  },
  in_progress: {
    icon: LoaderCircle,
    label: "In progress",
    // The one row worth finding at a glance in a list of a dozen, so it is the one row with
    // weight — and it is already the only row that moves.
    iconClassName: "spinner text-state-running",
    textClassName: "font-medium",
  },
  completed: {
    icon: SquareCheckBig,
    label: "Done",
    iconClassName: "text-state-done",
    textClassName: "text-muted-foreground line-through decoration-muted-foreground/50",
  },
};

export function TodoList({ items }: { items: readonly TodoItem[] }) {
  // Nothing to say and no room to waste saying it: the caller owns the decision about whether an
  // absent list deserves an `EmptyPanel` or simply no panel at all, because only the caller knows
  // whether the run has started.
  if (items.length === 0) return null;

  const done = items.filter((item) => item.status === "completed").length;

  return (
    <div className="surface-edge overflow-hidden rounded-xl border bg-card">
      <table className="w-full table-fixed border-collapse text-xs">
        {/*
          The count goes in the caption rather than in a `<thead>` cell. It is the header band a
          reader wants — how far along is this — but it labels neither column, and a `<th>` would
          have every row announce "3 of 7 done" as the heading of its text cell. A caption is
          announced once, up front, which is exactly how it should be read.
        */}
        <caption className="border-b bg-muted/40 px-3 py-1.5 text-left font-medium text-muted-foreground text-2xs">
          {done} of {items.length} done
        </caption>
        <tbody>
          {items.map((item, index) => {
            const state = STATE[item.status];
            // `activeForm` is the present-tense sentence the agent writes for exactly this
            // moment ("Writing the tests"); it exists only while the item is the live one, and
            // older lists predate the field, so `content` is always the fallback.
            const text =
              item.status === "in_progress" ? (item.activeForm ?? item.content) : item.content;
            return (
              <tr
                // biome-ignore lint/suspicious/noArrayIndexKey: a todo item carries no id, and the agent republishes the list whole and in order rather than splicing it — position is the only identity there is, and these rows hold no state a reused key could strand.
                key={index}
                data-todo-status={item.status}
                className="border-b align-top last:border-b-0"
              >
                <td className="w-7 py-1.5 pr-1 pl-3">
                  <state.icon aria-hidden className={cn("size-3.5", state.iconClassName)} />
                </td>
                <td className={cn("break-words py-1.5 pr-3 pl-1 leading-5", state.textClassName)}>
                  {/* The glyph is decorative, so the state has to reach a screen reader as text. */}
                  <span className="sr-only">{state.label}: </span>
                  {text}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The most recent todo list in a session's events.
 *
 * A scan backwards rather than a fold forwards, because `TodoWrite` always sends the complete
 * list: every `todos` event supersedes the one before it outright, so the last one wins and the
 * earlier ones are only history. Reducing over them would produce the same answer at more cost,
 * and merging them would invent a list the agent never held.
 */
export function latestTodos(events: readonly SessionEventDto[]): TodoItem[] {
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]?.payload;
    if (payload?.kind === "todos") return payload.items;
  }
  return [];
}
