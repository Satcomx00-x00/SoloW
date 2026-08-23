"use client";

import { memo } from "react";
import { cn } from "@/lib/utils";
import { ThinkingDots } from "./agent-activity";
import { AgentMarkdown } from "./markdown";
import { PermissionCard } from "./permission-card";
import { highlightsInline, splitHighlights, type TranscriptMatch } from "./terminal-search";
import { ToolCall } from "./tool-call";
import { fencesBalanced, type TranscriptRow } from "./transcript";
import { rendererFor } from "./widgets/registry";

/**
 * The agent transcript: one memoized component per row.
 *
 * What this replaces is the whole of the reported slowness. The terminal used to be a single
 * `<pre>` holding `preamble + events.map(...).join("") + live.events.map(...).join("")`, computed
 * in the component body on every render. Every arriving chunk therefore re-mapped and re-joined
 * the entire transcript, and replacing one text node that large makes the browser re-wrap every
 * line of it — not just the appended tail.
 *
 * A keyed list of `memo`ised rows makes an append cost one new row. `TranscriptRow.id` is
 * `sessionId:seq`, which is stable and unique, so React reuses every row above the tail; and
 * because `buildTranscript` coalesces a turn's chunks into one block and marks all but the last
 * as settled, the rows above the tail stop changing identity at all.
 */
/**
 * What the find bar is looking for, and which occurrence it is sitting on. Passed down rather
 * than read from a context: a row is memoised on its props, and a context would re-render every
 * row of a long transcript on every keystroke.
 */
export interface TranscriptSearch {
  query: string;
  active: TranscriptMatch | null;
}

export const Transcript = memo(function Transcript({
  rows,
  onRespondPermission,
  onRespondWidget,
  search,
}: {
  rows: readonly TranscriptRow[];
  onRespondPermission: (requestId: string, optionId: string) => void;
  /** Absent when nothing is listening — a finished run, or a socket that is not connected. */
  onRespondWidget?: ((widgetId: string, values: string[], text?: string) => void) | undefined;
  search?: TranscriptSearch | undefined;
}) {
  const query = search?.query.trim() ?? "";
  return (
    <div className="flex flex-col gap-5 p-4">
      {rows.map((row) => (
        <Row
          key={row.id}
          row={row}
          onRespondPermission={onRespondPermission}
          onRespondWidget={onRespondWidget}
          // Only the query and this row's own active occurrence reach the row, so typing in the
          // find bar re-renders the rows that actually change rather than all of them.
          query={query}
          activeIndex={search?.active?.rowId === row.id ? search.active.index : null}
        />
      ))}
    </div>
  );
});

const Row = memo(function Row({
  row,
  onRespondPermission,
  onRespondWidget,
  query,
  activeIndex,
}: {
  row: TranscriptRow;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onRespondWidget?: ((widgetId: string, values: string[], text?: string) => void) | undefined;
  query: string;
  /** Which occurrence in this row is the active match, or null when none is. */
  activeIndex: number | null;
}) {
  // A row that cannot highlight characters still has to be findable, so it lights up whole and
  // carries the marker the viewport scrolls to. Anything else would make search silently skip
  // tool calls and widgets — the rows people search for most.
  const lit = query !== "" && activeIndex !== null && !highlightsInline(row);
  if (lit) {
    return (
      <div
        data-match-active="true"
        className="rounded-lg ring-2 ring-primary/60 ring-offset-2 ring-offset-transparent"
      >
        <RowBody
          row={row}
          onRespondPermission={onRespondPermission}
          onRespondWidget={onRespondWidget}
          query={query}
          activeIndex={activeIndex}
        />
      </div>
    );
  }
  return (
    <RowBody
      row={row}
      onRespondPermission={onRespondPermission}
      onRespondWidget={onRespondWidget}
      query={query}
      activeIndex={activeIndex}
    />
  );
});

function RowBody({
  row,
  onRespondPermission,
  onRespondWidget,
  query,
  activeIndex,
}: {
  row: TranscriptRow;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onRespondWidget?: ((widgetId: string, values: string[], text?: string) => void) | undefined;
  query: string;
  activeIndex: number | null;
}) {
  if (row.kind === "tool") return <ToolCall row={row} />;

  if (row.kind === "widget") return <WidgetBlock row={row} onRespond={onRespondWidget} />;

  if (row.kind === "permission") {
    return (
      <PermissionCard
        row={row}
        onRespond={(optionId) => onRespondPermission(row.requestId, optionId)}
      />
    );
  }

  if (row.kind === "notice") {
    return (
      <p className="font-mono text-2xs text-muted-foreground/70">
        <Highlighted text={row.text} query={query} activeIndex={activeIndex} />
      </p>
    );
  }

  return <TextBlock row={row} query={query} activeIndex={activeIndex} />;
}

/**
 * One widget, drawn by whichever renderer the registry holds for its kind.
 *
 * The row — not the renderer — decides whether the widget can still be answered: a settled
 * widget, or one whose stream is gone, hands its renderer no `onRespond` at all, which is what
 * makes "this is a record" impossible to confuse with "this is waiting for you".
 */
const WidgetBlock = memo(function WidgetBlock({
  row,
  onRespond,
}: {
  row: Extract<TranscriptRow, { kind: "widget" }>;
  onRespond?: ((widgetId: string, values: string[], text?: string) => void) | undefined;
}) {
  const Renderer = rendererFor(row.widget.kind);
  const answerable = onRespond !== undefined && row.response === null;
  return (
    <Renderer
      widget={row.widget}
      response={row.response}
      {...(answerable
        ? { onRespond: (values: string[], text?: string) => onRespond(row.widgetId, values, text) }
        : {})}
    />
  );
});

/**
 * One block of text, rendered according to whose text it is.
 *
 * Markdown is for the model and the operator, never for `notice` output: machine lines are not
 * markdown, and a stray backtick or asterisk in a mode switch would eat the line or italicise
 * half of it.
 *
 * A block that is still `open` — the tail of a live turn — stays plain pre-wrapped text. Parsing
 * markdown on a growing string means re-parsing it on every chunk, and a fence that has only
 * half arrived renders as a fence swallowing everything after it, so the tail would flicker
 * between formatted and not on every frame. It switches to markdown the moment the turn closes,
 * which is what `buildTranscript` marks.
 */
const TextBlock = memo(function TextBlock({
  row: { channel, text, open },
  query,
  activeIndex,
}: {
  row: Extract<TranscriptRow, { kind: "text" }>;
  query: string;
  activeIndex: number | null;
}) {
  // Two reasons a block renders as plain text rather than markdown, and only two:
  //
  // 1. A search is running. Markdown and highlighting cannot both own the same string — marking
  //    inside rendered markdown would mean walking its output and re-inserting nodes — and of the
  //    two, the one you asked for by typing in the find bar wins. It reverts when the bar closes.
  // 2. The block is the still-growing tail *and* it has a fence open. A half-arrived fence parsed
  //    as markdown swallows the rest of the turn and re-parses into something else on the next
  //    chunk. A tail whose fences are all closed has neither problem, so it is parsed — which is
  //    what makes an agent's last message readable while the run is still alive.
  const streamingMidFence = open && !fencesBalanced(text);
  const body =
    streamingMidFence || query !== "" ? (
      <PlainText text={text} query={query} activeIndex={activeIndex} />
    ) : (
      <AgentMarkdown text={text} />
    );

  if (channel === "system") {
    return (
      <p className="whitespace-pre-wrap font-mono text-2xs text-muted-foreground/70 leading-[1.75]">
        <Highlighted text={text} query={query} activeIndex={activeIndex} />
      </p>
    );
  }

  if (channel === "user") {
    /*
      The operator's own turns sit on the right, in a filled bubble — the arrangement every chat
      surface uses, and the reason it is worth borrowing here: a transcript is a conversation
      between two parties, and "who said this" should be answerable from across the room rather
      than by reading a small grey label. The agent keeps the full width on the left, because its
      output is the content (code, diffs, tables) and a bubble would only narrow it.
    */
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] min-w-0 rounded-xl rounded-br-sm border border-primary/30 bg-primary/[0.10] px-3.5 py-2.5">
          <p className="mb-1.5 text-right font-medium text-2xs text-primary/80 uppercase tracking-wide">
            You
          </p>
          {body}
        </div>
      </div>
    );
  }

  const thinking = channel === "thinking";
  return (
    <div className={cn(thinking && "border-muted-foreground/25 border-l-2 pl-3 opacity-70")}>
      {thinking && (
        <p className="mb-1.5 flex items-center gap-1.5 font-medium text-2xs text-muted-foreground uppercase tracking-wide">
          Thinking
          {/* Only while the block is still arriving. A settled thought is a record, and a record
              that keeps animating tells the reader something is happening when nothing is. */}
          {open && <ThinkingDots />}
        </p>
      )}
      {body}
    </div>
  );
});

/** The still-arriving tail: shown exactly as it came, so it cannot flicker as it grows. */
function PlainText({
  text,
  query,
  activeIndex,
}: {
  text: string;
  query: string;
  activeIndex: number | null;
}) {
  return (
    <p className="whitespace-pre-wrap break-words text-sm leading-[1.75]">
      <Highlighted text={text} query={query} activeIndex={activeIndex} />
    </p>
  );
}

/**
 * Text with the search term marked. The active occurrence carries `data-match-active`, which is
 * what the terminal's viewport scrolls to — the row is memoised and three components below the
 * thing that has to move, so a DOM marker travels better than a ref would.
 */
function Highlighted({
  text,
  query,
  activeIndex,
}: {
  text: string;
  query: string;
  activeIndex: number | null;
}) {
  if (query === "") return <>{text}</>;
  return (
    <>
      {splitHighlights(text, query).map((segment, i) =>
        segment.match === null ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional by definition —
          // they are a split of one string, and re-splitting is what changes them.
          <span key={i}>{segment.text}</span>
        ) : (
          <mark
            // biome-ignore lint/suspicious/noArrayIndexKey: as above.
            key={i}
            data-match-active={segment.match === activeIndex ? "true" : undefined}
            className={cn(
              "rounded-[3px] px-0.5",
              segment.match === activeIndex
                ? "bg-primary text-primary-foreground"
                : "bg-primary/25 text-foreground",
            )}
          >
            {segment.text}
          </mark>
        ),
      )}
    </>
  );
}
