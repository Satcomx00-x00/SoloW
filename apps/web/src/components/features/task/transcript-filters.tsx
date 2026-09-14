"use client";

import { Brain, Check, TriangleAlert, Wrench } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TranscriptFilters } from "./terminal-search";

/**
 * The chips on the terminal's toolbar that narrow the transcript (see `applyTranscriptFilters`).
 *
 * The thinking toggle grew two neighbours rather than a menu: three chips are readable at a
 * glance and a menu would hide the one fact a reader most needs — that the transcript on screen
 * is *not all of it*. A chip that is off is struck through for the same reason; the eye reads
 * the strike before the label.
 *
 * "Failures only" is a mode: while it is on, the two toggles are dimmed rather than removed,
 * because they still say what the transcript will look like when the mode is switched off.
 */
export function TranscriptFilterBar({
  filters,
  onChange,
  shown,
  total,
}: {
  filters: TranscriptFilters;
  onChange: (next: TranscriptFilters) => void;
  /** Rows on screen after the filters, and rows in all — the count that says a chip did something. */
  shown?: number;
  total?: number;
}) {
  const { thinking, tools, failuresOnly } = filters;
  const narrowed = typeof shown === "number" && typeof total === "number" && shown < total;
  return (
    <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
      <legend className="sr-only">Transcript filters</legend>
      {/*
        The number moves on the same frame as the chip, or the tap reads as "nothing happened"
        and gets a second tap. Announced, because it is the answer to the press.
      */}
      {narrowed ? (
        <span
          className="mr-1 font-mono text-2xs text-muted-foreground tabular-nums"
          aria-live="polite"
          data-transcript-shown={shown}
        >
          {shown} of {total}
        </span>
      ) : null}
      <Chip
        icon={Brain}
        label="Thinking"
        pressed={thinking}
        muted={failuresOnly}
        title={thinking ? "Hide the harness's thinking" : "Show the harness's thinking"}
        onClick={() => onChange({ ...filters, thinking: !thinking })}
      />
      <Chip
        icon={Wrench}
        label="Tools"
        pressed={tools}
        muted={failuresOnly}
        title={tools ? "Hide tool calls" : "Show tool calls"}
        onClick={() => onChange({ ...filters, tools: !tools })}
      />
      <Chip
        icon={TriangleAlert}
        label="Failures only"
        pressed={failuresOnly}
        mode
        title={
          failuresOnly
            ? "Show the whole transcript"
            : "Show only what went wrong, and what was asked"
        }
        onClick={() => onChange({ ...filters, failuresOnly: !failuresOnly })}
      />
    </fieldset>
  );
}

function Chip({
  icon: Icon,
  label,
  pressed,
  muted = false,
  mode = false,
  title,
  onClick,
}: {
  icon: typeof Brain;
  label: string;
  pressed: boolean;
  muted?: boolean;
  /** A mode reads "on" or "off", never struck through: off is the ordinary state, not a removal. */
  mode?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      // Three states a glance can tell apart: on is filled with a check, off is struck through,
      // and a chip that cannot do anything right now (the mode is on) is dimmed. Colour never
      // carries it alone — the check and the strike survive a narrow panel where the label goes.
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-1.5 text-2xs transition-colors duration-100",
        pressed
          ? mode
            ? "bg-feedback-caution/15 text-feedback-caution"
            : "bg-muted text-foreground"
          : mode
            ? "text-muted-foreground hover:bg-white/5 hover:text-foreground"
            : "text-muted-foreground line-through hover:bg-white/5 hover:text-foreground",
        muted && "text-muted-foreground-subtle line-through",
      )}
    >
      {pressed && !mode ? (
        <Check aria-hidden className="size-3" />
      ) : (
        <Icon aria-hidden className="size-3" />
      )}
      <span className="sr-only @sm:not-sr-only">{label}</span>
    </button>
  );
}
