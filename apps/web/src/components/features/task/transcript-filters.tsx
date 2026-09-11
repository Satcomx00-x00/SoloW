"use client";

import { Brain, TriangleAlert, Wrench } from "lucide-react";
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
}: {
  filters: TranscriptFilters;
  onChange: (next: TranscriptFilters) => void;
}) {
  const { thinking, tools, failuresOnly } = filters;
  return (
    <fieldset className="m-0 flex items-center gap-0.5 border-0 p-0">
      <legend className="sr-only">Transcript filters</legend>
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
  title,
  onClick,
}: {
  icon: typeof Brain;
  label: string;
  pressed: boolean;
  muted?: boolean;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      title={title}
      onClick={onClick}
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-1.5 text-2xs transition-colors duration-100 hover:bg-white/5",
        pressed ? "text-foreground/80" : "text-muted-foreground line-through",
        muted && "opacity-50",
      )}
    >
      <Icon aria-hidden className="size-3" />
      <span className="sr-only @sm:not-sr-only">{label}</span>
    </button>
  );
}
