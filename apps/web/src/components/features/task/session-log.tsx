"use client";

import type { SessionEventDto, SessionSummaryDto } from "@solow/contracts";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * The Conversation, rendered as what it is (issue #2).
 *
 * This replaces `eventText()` — a function that probed a payload for `text`, then for `name`,
 * then gave up and stringified it — with a render per variant. The sniffing was not a style
 * problem: a reviewer could not tell their own steering from the model's answer, and a tool call
 * appeared as the word "tool" followed by a name with nothing behind it.
 *
 * A summarised range appears as one collapsed row, and the events it stands for are fetched only
 * if an operator opens it. That is where compaction actually pays: `session.get` leaves those
 * events out of the response, and nothing mounts them, so a run that has been compacted costs
 * the workspace one row instead of a few hundred. Expanding still reaches the events themselves,
 * because compaction never deleted them (AC-2).
 */

const ROLE: Record<string, { label: string; variant: "default" | "secondary" | "outline" }> = {
  user_turn: { label: "You", variant: "default" },
  assistant_turn: { label: "Agent", variant: "secondary" },
};

export function SessionLog({
  events,
  summaries,
  loadRange,
}: {
  events: SessionEventDto[];
  summaries: SessionSummaryDto[];
  /**
   * Reads one summarised range back out of the log. Optional: a caller that already holds the
   * whole log — a test, or a client reading a Session nothing has compacted — passes nothing and
   * the range expands from the events it was given.
   */
  loadRange?: (summary: SessionSummaryDto) => Promise<SessionEventDto[]>;
}) {
  if (events.length === 0 && summaries.length === 0) {
    return (
      <div className="flex h-full min-h-40 items-center justify-center p-8 text-center text-sm text-muted-foreground/60">
        No conversation yet.
      </div>
    );
  }

  // One ordered list of what the log *shows*: every event outside a summarised range, plus one
  // row for each range, placed where the range starts. Covered events are dropped rather than
  // rendered inside the row — the response does not normally carry them at all, and a caller
  // that does hold them should not pay to mount them while the row is closed.
  const covered = (seq: number) => summaries.some((s) => seq >= s.fromSeq && seq <= s.toSeq);
  const rows: Array<
    | { sort: number; kind: "event"; event: SessionEventDto }
    | { sort: number; kind: "range"; summary: SessionSummaryDto }
  > = [
    ...events
      .filter((e) => !covered(e.seq))
      .map((event) => ({ sort: event.seq, kind: "event" as const, event })),
    ...summaries.map((summary) => ({
      sort: summary.fromSeq,
      kind: "range" as const,
      summary,
    })),
  ].sort((a, b) => a.sort - b.sort);

  return (
    <ul className="divide-y">
      {rows.map((row) =>
        row.kind === "range" ? (
          <RangeRow
            key={`summary-${row.summary.id}`}
            summary={row.summary}
            held={events.filter((e) => e.seq >= row.summary.fromSeq && e.seq <= row.summary.toSeq)}
            {...(loadRange ? { loadRange } : {})}
          />
        ) : (
          <EventRow key={row.event.id} event={row.event} />
        ),
      )}
    </ul>
  );
}

/**
 * One collapsed range, and the events behind it once someone asks.
 *
 * The fetch is deliberately on open rather than on mount: a compacted Session can hold several
 * ranges, and loading them all to keep them hidden would be the behaviour compaction exists to
 * end. What was already fetched is kept, so closing and reopening the row costs nothing.
 */
function RangeRow({
  summary,
  held,
  loadRange,
}: {
  summary: SessionSummaryDto;
  held: SessionEventDto[];
  loadRange?: (summary: SessionSummaryDto) => Promise<SessionEventDto[]>;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<SessionEventDto[] | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (!next || loaded || pending || !loadRange) return;
    setPending(true);
    setFailed(false);
    loadRange(summary)
      .then((rows) => setLoaded(rows))
      .catch(() => setFailed(true))
      .finally(() => setPending(false));
  };

  const shown = loaded ?? held;
  return (
    <li className="px-4 py-2.5 text-sm" data-summary-range={`${summary.fromSeq}-${summary.toSeq}`}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="cursor-pointer text-left text-muted-foreground text-xs"
      >
        {summary.eventCount} event{summary.eventCount === 1 ? "" : "s"} summarised —{" "}
        {open ? "collapse" : "expand"}
        <span className="ml-2 text-muted-foreground/70">{summary.text}</span>
      </button>
      {open && (
        <div className="mt-2 border-l pl-3">
          {pending && <p className="text-muted-foreground text-xs">Reading the range…</p>}
          {failed && (
            <p className="text-destructive text-xs">Could not read this range. Try again.</p>
          )}
          {!pending && !failed && (
            <ul className="divide-y">
              {shown.map((e) => (
                <EventRow key={e.id} event={e} />
              ))}
            </ul>
          )}
        </div>
      )}
    </li>
  );
}

function EventRow({ event }: { event: SessionEventDto }) {
  const p = event.payload;
  return (
    <li className="flex gap-3 px-4 py-2.5 text-sm" data-event-kind={p.kind}>
      <span className="w-16 shrink-0 pt-px">
        {ROLE[p.kind] ? (
          <Badge variant={ROLE[p.kind]?.variant} className="text-2xs">
            {ROLE[p.kind]?.label}
          </Badge>
        ) : (
          <span className="font-mono text-2xs text-muted-foreground/70 uppercase tracking-wider">
            {p.kind.replace(/_/g, " ")}
          </span>
        )}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
        <EventBody event={event} />
      </span>
    </li>
  );
}

function EventBody({ event }: { event: SessionEventDto }) {
  const p = event.payload;
  switch (p.kind) {
    case "user_turn":
    case "notice":
      return <span className={cn(p.kind === "notice" && "text-muted-foreground")}>{p.text}</span>;
    case "assistant_turn":
      return <span className={cn(p.thinking && "text-muted-foreground italic")}>{p.text}</span>;
    case "tool_call":
      return (
        <details>
          <summary className="cursor-pointer font-mono text-xs">{p.name}</summary>
          {/*
            Input is shown only when a producer supplied it, and none does yet — a tool call's
            raw input can hold the contents of a file being written, so it is deliberately not
            captured (Principle IV). The disclosure is here so that when one does, it has a home.
          */}
          {p.input === undefined ? (
            <p className="mt-1 text-muted-foreground text-xs">No input recorded.</p>
          ) : (
            <pre className="mt-1 overflow-x-auto text-xs">{JSON.stringify(p.input, null, 2)}</pre>
          )}
        </details>
      );
    case "tool_result":
      return (
        <span className={cn(!p.ok && "text-destructive")}>
          {p.ok ? "succeeded" : "failed"}
          {p.callId ? ` (${p.callId})` : ""}
        </span>
      );
    case "usage":
      return (
        <span className="font-mono text-xs">
          {p.model ?? "unknown model"} · {p.inputTokens} in · {p.outputTokens} out
        </span>
      );
    case "state":
      return (
        <span>
          {p.from} → {p.to}
          {p.reason ? ` (${p.reason})` : ""}
        </span>
      );
    case "permission_request":
      return (
        <span>
          asked to {p.title}
          {p.options.length > 0 ? ` — ${p.options.map((o) => o.name).join(", ")}` : ""}
        </span>
      );
    case "permission_resolved":
      return (
        <span>
          {p.optionId ?? "declined"} ({p.decidedBy})
        </span>
      );
    case "diff":
      return (
        <span>
          {p.files.length} file{p.files.length === 1 ? "" : "s"} on{" "}
          <span className="font-mono text-xs">{p.diffRef}</span>
        </span>
      );
    case "todos": {
      // A line, not the checklist. The Plan panel beside the diff draws the list itself and
      // draws only the latest one; what this tab is for is *when* the plan changed and what it
      // said at that point in the run, which a dozen stacked copies of the same twelve items
      // would bury. Without a case at all the row rendered blank — the log holding the whole
      // plan and the one view whose job is to show the log saying nothing about it.
      const done = p.items.filter((i) => i.status === "completed").length;
      const current = p.items.find((i) => i.status === "in_progress");
      return (
        <span>
          {done} of {p.items.length} done
          {current ? ` — ${current.activeForm ?? current.content}` : ""}
        </span>
      );
    }
  }
}
