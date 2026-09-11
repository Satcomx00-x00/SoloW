"use client";

import type { ReviewDecision, SessionDto, SessionRoundDto } from "@solow/contracts";
import { ChevronLeft, ChevronRight, History } from "lucide-react";
import { Button } from "@/components/ui/button";
import { relativeAge } from "@/lib/relative-time";
import { cn } from "@/lib/utils";

/** The decision on a round, in the words the gate's buttons use. */
const DECISION_LABEL: Record<ReviewDecision, string> = {
  approve: "Approved",
  reject: "Rejected",
  request_changes: "Changes requested",
};

/**
 * Which review round the Changes tab is showing (F10 FR-7).
 *
 * A Session accrues a round per request-changes, and until now the page showed only the last:
 * the moment a new round started, what the reviewer had said and what the harness had shown them
 * were both gone from the screen. This walks them. The current round is the default, and the
 * only one the gate acts on — an older round is read-only and says so, because approving what
 * you are looking at is the whole contract of the gate and an older diff is not what would be
 * committed.
 *
 * Launches — separate Sessions from a Retry — are a second, rarer axis, offered only when there
 * is more than one. They are not rounds: a retried Task starts over from the brief.
 */
export function RoundSelector({
  rounds,
  selected,
  onSelect,
  launches,
}: {
  rounds: readonly SessionRoundDto[];
  /** 1-based, one of `rounds[].index`. */
  selected: number;
  onSelect: (index: number) => void;
  launches?: {
    sessions: readonly SessionDto[];
    selectedId: string;
    onSelect: (sessionId: string) => void;
  };
}) {
  const round = rounds.find((r) => r.index === selected) ?? null;
  const latest = rounds[rounds.length - 1]?.index ?? 0;
  const superseded = round !== null && round.index !== latest;
  const manyLaunches = (launches?.sessions.length ?? 0) > 1;
  if (rounds.length < 2 && !manyLaunches) return null;

  return (
    <div
      className={cn(
        "surface-edge mb-3 space-y-1 rounded-lg border bg-card px-2.5 py-1.5 text-xs",
        superseded && "border-feedback-caution/40",
      )}
      data-round-selector
    >
      <div className="flex flex-wrap items-center gap-2">
        {manyLaunches && launches ? (
          <label className="flex items-center gap-1.5 text-muted-foreground">
            <History aria-hidden className="size-3.5" />
            <span className="sr-only">Launch</span>
            <select
              className="rounded-md border bg-background px-1.5 py-0.5 text-xs"
              value={launches.selectedId}
              onChange={(e) => launches.onSelect(e.target.value)}
            >
              {launches.sessions.map((session, i) => (
                <option key={session.id} value={session.id}>
                  Launch {launches.sessions.length - i} · {relativeAge(session.startedAt)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {rounds.length > 1 ? (
          <div className="flex items-center gap-1">
            <Button
              aria-label="Previous round"
              size="icon-xs"
              variant="ghost"
              disabled={round === null || round.index <= 1}
              onClick={() => onSelect(selected - 1)}
            >
              <ChevronLeft />
            </Button>
            <span className="font-medium tabular-nums">
              Round {selected} of {rounds.length}
            </span>
            <Button
              aria-label="Next round"
              size="icon-xs"
              variant="ghost"
              disabled={round === null || round.index >= latest}
              onClick={() => onSelect(selected + 1)}
            >
              <ChevronRight />
            </Button>
          </div>
        ) : null}
        {superseded ? <span className="text-feedback-caution">Superseded — read-only.</span> : null}
      </div>
      {round ? <Decision round={round} /> : null}
    </div>
  );
}

/** What was decided on the round, and what the reviewer said — the part a new round loses. */
function Decision({ round }: { round: SessionRoundDto }) {
  if (!round.review) {
    return (
      <p className="text-2xs text-muted-foreground">
        {round.closedAtSeq === null ? "The current round." : "No decision recorded."}
      </p>
    );
  }
  const label = DECISION_LABEL[round.review.decision];
  return (
    <p className="text-2xs text-muted-foreground">
      <span className="font-medium text-foreground/80">{label}</span>
      {" · "}
      {relativeAge(round.review.createdAt)}
      {round.review.feedback ? (
        <>
          {" — "}
          <q className="text-foreground/80">{round.review.feedback}</q>
        </>
      ) : null}
    </p>
  );
}
