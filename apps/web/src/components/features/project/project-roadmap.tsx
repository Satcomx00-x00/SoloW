"use client";

import type { ProjectFieldDto } from "@gatecontrol/contracts";
import { normaliseFilterKey } from "@gatecontrol/core";
import { CalendarOff } from "lucide-react";
import { useMemo } from "react";
import type { ProjectRow } from "@/components/features/project/project-table";
import { cn } from "@/lib/utils";

/**
 * The roadmap layout (spec F23 FR-10, issue #129).
 *
 * **A second projection, not a second model** — the same phrasing issue #61 uses for the DAG
 * view, and the same rule: these are the rows the table shows, laid on a timeline by the dates
 * the project already holds. There is no roadmap item, no roadmap date and nothing to keep in
 * step; switch the tab back and the very same rows are in the very same order.
 *
 * The part that is easy to get wrong and matters most: an item with no dates is listed **beside**
 * the timeline, never dropped. "What is not scheduled" is the question a roadmap is most often
 * asked, and a timeline that answers it by omission answers it wrongly.
 */

/** One row on the timeline. `partial` means the project holds one of its two dates, not both. */
export interface RoadmapBar {
  row: ProjectRow;
  start: string;
  end: string;
  partial: boolean;
}

export interface RoadmapPlan {
  bars: RoadmapBar[];
  /** Rows with neither date. Listed, counted, and never silently absent. */
  unscheduled: ProjectRow[];
  /** The span the bars are drawn against — the rows' own extent, not a calendar year. */
  from: string;
  to: string;
}

const DAY = 86_400_000;
const days = (from: string, to: string) => (Date.parse(to) - Date.parse(from)) / DAY;
const isDate = (value: string | undefined): value is string =>
  value !== undefined && !Number.isNaN(Date.parse(value));

/**
 * Which columns carry the two ends of a bar.
 *
 * By name, because that is the only thing every provider agrees on: GitHub Projects' `Start date`
 * and `Target date` are conventions, and GitLab synthesises its own. Never by provider id — a
 * branch on which host this is would be exactly what Decision 0016 forbids.
 *
 * With no name to go on, the project's own field order decides: the first two date columns, in
 * the order the provider lists them. A guess, and a visible one — better than a roadmap that
 * refuses to draw because nobody used the word "target".
 */
export function pickRoadmapDateFields(fields: readonly ProjectFieldDto[]): {
  start: ProjectFieldDto | null;
  target: ProjectFieldDto | null;
} {
  const dates = fields.filter((f) => f.type === "date");
  const named = (words: string[]) =>
    dates.find((f) => {
      const key = normaliseFilterKey(f.name);
      return words.some((word) => key.includes(word));
    }) ?? null;

  const start = named(["start", "begin"]);
  const target = named(["target", "due", "end", "finish", "ship"]);
  if (start || target) {
    return {
      start: start ?? null,
      // Two names for one column would draw a zero-length bar for every row; the fallback is the
      // other date column, if the project has one.
      target: target && target !== start ? target : (dates.find((f) => f !== start) ?? null),
    };
  }
  return { start: dates[0] ?? null, target: dates[1] ?? null };
}

function dateValue(row: ProjectRow, field: ProjectFieldDto | null): string | undefined {
  if (!field) return undefined;
  const value = row.item.values[field.id];
  return value?.type === "date" ? value.date : undefined;
}

/**
 * Lay the rows out: what is scheduled, what is not, and over what span.
 *
 * A row holding one date is *partial*, not unscheduled — it is drawn as a point on the day it
 * knows. Hiding it beside the timeline would lose the one fact it has, and stretching it to the
 * edge of the chart would invent the one it does not.
 */
export function planRoadmap(
  rows: readonly ProjectRow[],
  startField: ProjectFieldDto | null,
  targetField: ProjectFieldDto | null,
): RoadmapPlan {
  const bars: RoadmapBar[] = [];
  const unscheduled: ProjectRow[] = [];

  for (const row of rows) {
    const rawStart = dateValue(row, startField);
    const rawEnd = dateValue(row, targetField);
    const start = isDate(rawStart) ? rawStart : undefined;
    const end = isDate(rawEnd) ? rawEnd : undefined;

    if (start === undefined && end === undefined) {
      unscheduled.push(row);
      continue;
    }
    const known = (start ?? end) as string;
    const other = (end ?? start) as string;
    // A target before its start is the provider's data, not a reason to drop a row: the bar is
    // drawn between the two dates whichever way round they are, and the row stays visible.
    const [from, to] = days(known, other) < 0 ? [other, known] : [known, other];
    bars.push({ row, start: from, end: to, partial: start === undefined || end === undefined });
  }

  const from = bars.reduce<string | null>(
    (min, bar) => (min === null || bar.start < min ? bar.start : min),
    null,
  );
  const to = bars.reduce<string | null>(
    (max, bar) => (max === null || bar.end > max ? bar.end : max),
    null,
  );
  return { bars, unscheduled, from: from ?? "", to: to ?? "" };
}

/** Where a bar sits, as percentages of the span. A single-day span fills the row rather than dividing by zero. */
function geometry(bar: RoadmapBar, plan: RoadmapPlan): { left: number; width: number } {
  const span = days(plan.from, plan.to);
  if (span <= 0) return { left: 0, width: 100 };
  const left = (days(plan.from, bar.start) / span) * 100;
  // A minimum width, so a one-day item is a mark somebody can see and click rather than a hairline.
  const width = Math.max((days(bar.start, bar.end) / span) * 100, 1.5);
  return { left, width: Math.min(width, 100 - left) };
}

/** Month boundaries inside the span, so a bar can be read against something. */
function monthTicks(plan: RoadmapPlan): Array<{ label: string; left: number }> {
  const span = days(plan.from, plan.to);
  if (span <= 0) return [];
  const ticks: Array<{ label: string; left: number }> = [];
  const cursor = new Date(`${plan.from.slice(0, 7)}-01T00:00:00.000Z`);
  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  const end = Date.parse(plan.to);
  while (cursor.getTime() <= end && ticks.length < 24) {
    const at = cursor.toISOString().slice(0, 10);
    ticks.push({
      label: cursor.toLocaleDateString(undefined, { month: "short", year: "2-digit" }),
      left: (days(plan.from, at) / span) * 100,
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return ticks;
}

export function ProjectRoadmap({
  fields,
  rows,
}: {
  fields: readonly ProjectFieldDto[];
  rows: readonly ProjectRow[];
}) {
  const { start, target } = useMemo(() => pickRoadmapDateFields(fields), [fields]);
  const plan = useMemo(() => planRoadmap(rows, start, target), [rows, start, target]);
  const ticks = useMemo(() => monthTicks(plan), [plan]);

  if (!start && !target) {
    return (
      <p className="px-4 py-6 text-muted-foreground text-sm">
        {/* Named plainly rather than drawn empty: the project has no dates to lay out, which is a
            fact about the project and not a failure of this view (F23 FR-5's habit). */}
        This project has no date field, so there is nothing to place on a timeline.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 gap-4 overflow-auto p-4">
      <section aria-label="Timeline" className="min-w-0 flex-1">
        {plan.bars.length === 0 ? (
          <p className="text-muted-foreground text-sm">Nothing in this view has a date yet.</p>
        ) : (
          <>
            <div className="relative mb-2 h-4 border-b text-2xs text-muted-foreground">
              <span className="absolute left-0 font-mono tabular-nums">{plan.from}</span>
              {ticks.map((tick) => (
                <span
                  key={tick.label + tick.left}
                  className="absolute -translate-x-1/2"
                  style={{ left: `${tick.left}%` }}
                >
                  {tick.label}
                </span>
              ))}
              <span className="absolute right-0 font-mono tabular-nums">{plan.to}</span>
            </div>
            <ul className="flex flex-col gap-1">
              {plan.bars.map((bar) => {
                const { left, width } = geometry(bar, plan);
                return (
                  <li key={bar.row.item.id} className="flex items-center gap-2">
                    <span className="w-48 shrink-0 truncate text-xs" title={bar.row.title}>
                      {bar.row.title}
                    </span>
                    <span className="relative h-5 min-w-0 flex-1 rounded bg-accent/20">
                      <span
                        className={cn(
                          "absolute inset-y-0 flex items-center truncate rounded px-1.5 text-2xs",
                          bar.partial
                            ? // Dashed, because half a date is not a duration: the bar shows the
                              // one day the project knows and claims nothing about the other end.
                              "border border-dashed border-state-idle/60 text-state-idle"
                            : "bg-state-running/25 text-foreground",
                        )}
                        style={{ left: `${left}%`, width: `${width}%` }}
                        title={
                          bar.partial
                            ? `${bar.row.title} — ${bar.start} (one date only)`
                            : `${bar.row.title} — ${bar.start} → ${bar.end}`
                        }
                      >
                        <span className="sr-only">
                          {bar.partial
                            ? `${bar.row.title}, ${bar.start}, one date only`
                            : `${bar.row.title}, ${bar.start} to ${bar.end}`}
                        </span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </section>

      {/* Beside the timeline, always — this is AC-4, and the answer a roadmap is most often
          asked for. A count, so "nothing is unscheduled" is also said out loud. */}
      <aside aria-label="Not scheduled" className="w-56 shrink-0 border-l pl-4">
        <h3 className="flex items-center gap-1.5 pb-2 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
          <CalendarOff aria-hidden className="size-3" />
          Not scheduled
          <span className="font-mono tabular-nums">{plan.unscheduled.length}</span>
        </h3>
        {plan.unscheduled.length === 0 ? (
          <p className="text-2xs text-muted-foreground/70">Everything here has a date.</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {plan.unscheduled.map((row) => (
              <li key={row.item.id} className="truncate text-xs" title={row.title}>
                {row.title}
                {row.issueNumber !== null && (
                  <span className="pl-1.5 font-mono text-2xs text-muted-foreground/60">
                    #{row.issueNumber}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </aside>
    </div>
  );
}
