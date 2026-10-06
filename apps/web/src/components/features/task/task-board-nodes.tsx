"use client";

import type { DecisionWidget, TodoItem } from "@solow/contracts";
import { Diamond } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";
import type { StepCardWidget } from "./todo-list";
import type { PermissionRow, WidgetRow } from "./transcript";

/**
 * The cards the task board stacks under each Step.
 *
 * A card is a label, not a form. It says what kind of thing it is, the one line that names it,
 * and how far along it is — and that is all: the question in full, the options with their
 * reasons, the buttons that answer it, all of it opens in a dialog from the card. A board whose
 * cards carried their own controls grew a column a screen tall for six decisions, and every
 * card fought the canvas for the pointer. Now every card is one button, and the canvas is for
 * seeing where things are.
 *
 * Amber is reserved for the cards waiting on you, as it is on the board and in the badges.
 */

/** The reviewer's answer to one decision, as the draft keeps it. */
export interface DecisionAnswer {
  id: string;
  choice: string;
  note?: string | undefined;
}

type Tone = "plain" | "live" | "attention" | "settled";

/*
 * `live` and `attention` breathe — the card a harness is writing to, and the cards waiting on you
 * (`.board-pulse-*` in globals.css). Brightness only, so it holds under reduced motion too.
 */
const TONE: Record<Tone, string> = {
  plain: "border-border bg-card hover:border-foreground/25",
  live: "board-pulse-running board-pulse-soft border-state-running/60 bg-card hover:border-state-running",
  attention: "board-pulse-waiting board-pulse-soft border-state-review bg-card",
  settled: "border-state-done/50 bg-card hover:border-state-done",
};

/** The frame alone, for the edges drawn behind a stack. */
const EDGE: Record<Tone, string> = {
  plain: "border-border bg-card",
  live: "border-state-running/60 bg-card",
  attention: "border-state-review bg-card",
  settled: "border-state-done/50 bg-card",
};

/**
 * One card: a button that opens its dialog.
 *
 * `kind` leads the accessible name ("Plan. …", "Gate. …") so a screen reader — and a test —
 * hears what the card is before what it says. `stacked` draws the edges of the cards behind it,
 * for a node that stands for several of one kind.
 */
export function NodeCard({
  kind,
  tone = "plain",
  caption,
  aside,
  title,
  meta,
  stacked = 0,
  pass,
  onOpen,
  boardKind,
  ...rest
}: {
  kind: string;
  /** Which pass of its Step the card came from, when the Workflow has looped. */
  pass?: number | undefined;
  tone?: Tone;
  caption: ReactNode;
  aside?: ReactNode;
  title: ReactNode;
  meta?: ReactNode;
  /** How many cards this one stands for, past the first; drawn as edges behind it. */
  stacked?: number;
  onOpen: () => void;
  boardKind: string;
} & Record<`data-${string}`, string | boolean | undefined>) {
  const layers = Math.min(2, Math.max(0, stacked));
  return (
    <div className="relative w-full" style={{ paddingBottom: layers * 5 }}>
      {Array.from({ length: layers }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: decorative layers, positional by design
          key={i}
          aria-hidden
          className={cn("absolute inset-x-0 top-0 rounded-xl border-2", EDGE[tone])}
          style={{
            bottom: i * 5,
            marginLeft: (layers - i) * 6,
            marginRight: (layers - i) * 6,
            opacity: 0.35 + i * 0.2,
          }}
        />
      ))}
      <button
        type="button"
        aria-haspopup="dialog"
        onClick={onOpen}
        data-board-kind={boardKind}
        {...rest}
        className={cn(
          "relative block w-full min-w-0 cursor-pointer space-y-1.5 rounded-xl border-2 p-3 text-left transition-[border-color,box-shadow] duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          TONE[tone],
        )}
      >
        <span className="flex items-center justify-between gap-2">
          <span
            className={cn(
              "flex min-w-0 items-center gap-1.5 font-medium text-2xs uppercase tracking-[0.14em]",
              tone === "attention" ? "text-state-review" : "text-muted-foreground",
            )}
          >
            <span className="sr-only">{kind}. </span>
            {caption}
            {pass ? (
              <span className="whitespace-nowrap font-normal text-muted-foreground normal-case tracking-normal">
                · pass {pass}
              </span>
            ) : null}
          </span>
          {aside}
        </span>
        <span className="line-clamp-2 block break-words font-semibold text-sm leading-snug">
          {title}
        </span>
        {meta ? <span className="block text-muted-foreground text-xs">{meta}</span> : null}
      </button>
    </div>
  );
}

/** The outline diamond of an AI decision; filled, it is the mark of something that needs you. */
export function DecisionMark({ filled = false }: { filled?: boolean }) {
  return (
    <Diamond
      aria-hidden
      className={cn("size-3 shrink-0", filled && "fill-current")}
      strokeWidth={2.25}
    />
  );
}

/** "new" beside a card that arrived while you were looking. */
export function NewBadge() {
  return (
    <span className="rounded-full bg-state-review px-1.5 font-medium text-2xs text-background">
      new
    </span>
  );
}

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="shrink-0 font-mono text-2xs text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

function Progress({ done, of, label }: { done: number; of: number; label: string }) {
  return (
    <span
      className="mt-1 block h-1 overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={of}
      aria-valuenow={done}
    >
      <span
        className="block h-full rounded-full bg-state-done transition-[width]"
        style={{ width: of === 0 ? "0%" : `${(done / of) * 100}%` }}
      />
    </span>
  );
}

export function PlanNode({
  widget,
  approved,
  onOpen,
  pass,
}: {
  widget: StepCardWidget;
  approved: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  const done = widget.steps.filter((s) => s.state === "done").length;
  const total = widget.steps.length;
  return (
    <NodeCard
      pass={pass}
      kind="Plan"
      boardKind="plan"
      caption="Plan"
      aside={
        <Count>
          {done}/{total}
        </Count>
      }
      title={
        widget.title ??
        widget.steps.find((s) => s.state === "active")?.label ??
        "The harness's plan"
      }
      meta={
        <>
          {approved ? <span className="text-state-done">✓ approved</span> : null}
          <Progress done={done} of={total} label="Plan progress" />
        </>
      }
      onOpen={onOpen}
    />
  );
}

export function TodoNode({
  items,
  live,
  onOpen,
  pass,
}: {
  items: readonly TodoItem[];
  live: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  const done = items.filter((i) => i.status === "completed").length;
  const working = items.find((i) => i.status === "in_progress");
  const next = items.find((i) => i.status === "pending");
  return (
    <NodeCard
      pass={pass}
      kind="Todo list"
      boardKind="todos"
      tone={live && working ? "live" : "plain"}
      caption="Todo"
      aside={
        <Count>
          {done}/{items.length}
          <span className="sr-only"> done</span>
        </Count>
      }
      title={
        working
          ? (working.activeForm ?? working.content)
          : done === items.length
            ? "All done"
            : (next?.content ?? "")
      }
      meta={<Progress done={done} of={items.length} label="Todo progress" />}
      onOpen={onOpen}
    />
  );
}

/**
 * Every decision the harness made on a Step, as one stack: inert while the run is going, amber
 * at the gate while any is unsettled, green once all are.
 */
export function DecisionsNode({
  widgets,
  answers,
  confirming,
  onOpen,
  pass,
}: {
  widgets: readonly DecisionWidget[];
  answers: readonly DecisionAnswer[];
  confirming: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  const settled = widgets.filter((w) => answers.some((a) => a.id === w.id)).length;
  const open = confirming && settled < widgets.length;
  const first = widgets[0];
  const picked = first?.options.find((o) => o.id === first.chosen);
  const many = widgets.length > 1;
  return (
    <NodeCard
      pass={pass}
      kind="AI decisions"
      boardKind="decisions"
      data-settled={!open}
      tone={open ? "attention" : confirming ? "settled" : "plain"}
      stacked={widgets.length - 1}
      caption={
        <>
          <DecisionMark filled={open} />
          {open ? "Confirm AI decisions" : confirming ? "Confirmed" : "AI decided"}
        </>
      }
      aside={<Count>{confirming ? `${settled}/${widgets.length}` : widgets.length}</Count>}
      title={
        many ? (
          `${widgets.length} decisions`
        ) : first ? (
          <>
            {first.question}
            {picked ? (
              <span className="font-normal text-muted-foreground"> → {picked.label}</span>
            ) : null}
          </>
        ) : null
      }
      meta={
        many && first ? (
          <span className="line-clamp-1">
            {first.question} +{widgets.length - 1} more
          </span>
        ) : open ? (
          "Yours to confirm before approving"
        ) : null
      }
      onOpen={onOpen}
    />
  );
}

/** A permission the harness is stopped on — or, once answered, the record of it. */
export function PermissionNode({
  row,
  fresh,
  onOpen,
  pass,
}: {
  row: PermissionRow;
  fresh: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  if (row.resolution) {
    const chosen = row.options.find((o) => o.optionId === row.resolution?.optionId);
    return (
      <NodeCard
        pass={pass}
        kind="Permission"
        boardKind="permission"
        data-permission={row.requestId}
        data-resolution="settled"
        caption={
          <>
            <DecisionMark /> Permission
          </>
        }
        title={row.title}
        meta={`${chosen?.name ?? row.resolution.optionId ?? "Declined"}, ${
          row.resolution.decidedBy === "operator" ? "chosen by the operator" : "settled by policy"
        }`}
        onOpen={onOpen}
      />
    );
  }
  return (
    <NodeCard
      pass={pass}
      kind="Permission"
      boardKind="permission"
      data-permission={row.requestId}
      data-resolution="open"
      tone="attention"
      caption={
        <>
          <DecisionMark filled /> Needs you · permission
        </>
      }
      aside={fresh ? <NewBadge /> : null}
      title={row.title}
      meta="The harness is waiting — open to answer"
      onOpen={onOpen}
    />
  );
}

/** Every question the harness asked on a Step, as one stack. */
export function AsksNode({
  rows,
  answerable,
  fresh,
  onOpen,
  pass,
}: {
  rows: readonly WidgetRow[];
  /** A live harness to answer: unanswered questions are then waiting, not a record. */
  answerable: boolean;
  fresh: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  const waiting = answerable ? rows.filter((r) => r.response === null) : [];
  const shown = waiting[0] ?? rows[0];
  const open = waiting.length > 0;
  const many = rows.length > 1;
  return (
    <NodeCard
      pass={pass}
      kind={many ? "Questions" : "Question"}
      boardKind="asks"
      tone={open ? "attention" : "plain"}
      stacked={rows.length - 1}
      caption={
        <>
          <DecisionMark filled={open} />
          {open ? "Needs you · " : ""}
          {many ? "questions" : "question"}
        </>
      }
      aside={
        open && fresh ? (
          <NewBadge />
        ) : many ? (
          <Count>{open ? `${waiting.length} open` : rows.length}</Count>
        ) : null
      }
      title={shown ? questionText(shown) : ""}
      meta={
        open
          ? many
            ? `${waiting.length} of ${rows.length} waiting for your answer`
            : "Open to answer"
          : "Answered"
      }
      onOpen={onOpen}
    />
  );
}

/** What a question widget asks, in its own words. */
export function questionText(row: WidgetRow): string {
  const widget = row.widget as { prompt?: string; title?: string; question?: string };
  return widget.prompt ?? widget.question ?? widget.title ?? "A question from the harness";
}

/**
 * The gate: whatever the Task needs from a person to move on, at the foot of the Step it is at.
 * The card says what kind of decision it is and what stands in the way; the decision itself is
 * the page's own `TaskFooter`, in the dialog.
 */
export function GateNode({
  title,
  headline,
  detail,
  attention,
  onOpen,
  pass,
}: {
  title: string;
  headline: string;
  detail: string;
  attention: boolean;
  onOpen: () => void;
  pass?: number | undefined;
}) {
  return (
    <NodeCard
      pass={pass}
      kind="Gate"
      boardKind="gate"
      tone={attention ? "attention" : "plain"}
      caption={
        <>
          <DecisionMark filled={attention} /> {title}
        </>
      }
      title={headline}
      meta={detail}
      onOpen={onOpen}
    />
  );
}
