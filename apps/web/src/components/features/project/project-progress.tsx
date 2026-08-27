"use client";

import { cn } from "@/lib/utils";

/**
 * Sub-issue progress, as a **segmented** bar (GitHub Projects §4).
 *
 * One segment per sub-issue, not a continuous fill: `3/4` and `75%` are the same number, but four
 * discrete marks say "there are four things and one is left" at a glance, which a continuous bar
 * cannot. Done segments are opaque, the rest are drawn at low opacity — present, so the total is
 * still legible, and clearly not counted.
 *
 * Neutral by decision: the reference paints these `#8256D0`, and every colour in this build now
 * belongs to provider data rather than to chrome. Progress is SoloW's own arithmetic over
 * `closed` flags, so it is chrome, and it renders in the foreground tone.
 *
 * The count and the percentage both, because they answer different questions — "how much is
 * left" is a count, "how far along" is a ratio, and a bar alone answers neither precisely.
 */

/**
 * Above this many sub-issues the bar stops being segmented and becomes one continuous fill.
 *
 * A segment has to be at least a pixel or two wide to read as a segment; past roughly this many
 * the gaps eat the bar and it turns into a dotted smear that is harder to read than a plain fill.
 * The count beside it keeps the exact answer available either way, so nothing is lost — this is a
 * rendering fallback, not a truncation.
 */
const MAX_SEGMENTS = 24;

export function SubIssueProgress({
  done,
  total,
  className,
}: {
  done: number;
  total: number;
  className?: string;
}) {
  // Nothing to report rather than "0 / 0": a row with no sub-issues is not a row at 0%.
  if (total <= 0) return null;

  const percent = Math.round((done / total) * 100);
  const segmented = total <= MAX_SEGMENTS;

  return (
    <span
      className={cn("inline-flex shrink-0 items-center gap-1.5", className)}
      // One label for the whole control: three separate nodes would be read as three unrelated
      // numbers by a screen reader, where this is a single fact.
      title={`${done} of ${total} sub-issues closed on the provider`}
    >
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">
        {done}/{total}
      </span>
      <span
        aria-hidden
        className="flex h-2 w-16 items-stretch gap-px overflow-hidden rounded-[3px] bg-muted"
      >
        {segmented ? (
          Array.from({ length: total }, (_, index) => (
            <span
              // A segment is a position in a count, not an entity: there is no id to key it by,
              // and the list only ever grows or shrinks at its end, so an index key cannot
              // mis-associate state — these nodes hold none.
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positions, not entities
              key={index}
              className={cn(
                "min-w-px flex-1 bg-foreground",
                index < done ? "opacity-100" : "opacity-25",
              )}
            />
          ))
        ) : (
          <span className="bg-foreground" style={{ width: `${percent}%` }} />
        )}
      </span>
      <span className="font-mono text-2xs text-muted-foreground tabular-nums">{percent}%</span>
    </span>
  );
}
