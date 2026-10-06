"use client";

import {
  type DecisionWidget,
  ExplainErrorCode,
  type TaskState,
  type TodoItem,
  type WorkflowStepDto,
} from "@solow/contracts";
import {
  Check,
  Focus,
  MessageCircleQuestion,
  MessagesSquare,
  ScrollText,
  UserCheck,
} from "lucide-react";
import Link from "next/link";
import { type ReactNode, useId, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  type DialogSize,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { HarnessMarkdown } from "./markdown";
import { PermissionCard } from "./permission-card";
import type { BoardColumn } from "./task-board-model";
import { type DecisionAnswer, DecisionMark, questionText } from "./task-board-nodes";
import { type StepCardWidget, TodoList } from "./todo-list";
import type { PermissionRow, WidgetRow } from "./transcript";
import { rendererFor } from "./widgets/registry";
import { StepCard } from "./widgets/step-card";

/**
 * What a board card opens: the thing at full size, with every action it offers.
 *
 * One frame for all of them — a title that names the card, a line that says where it stands,
 * a body that scrolls between them — so a dialog opened from any card reads the same way. The
 * bodies are the page's existing renderings where there is one (the todo table, the step card,
 * the permission card, the widget renderers), so the wording and the rules are the ones the
 * terminal already used.
 */
export function BoardDialog({
  title,
  description,
  size = "lg",
  container,
  onClose,
  onOpenAutoFocus,
  footer,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  size?: DialogSize;
  container: HTMLElement | null;
  onClose: () => void;
  onOpenAutoFocus?: ((event: Event) => void) | undefined;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent size={size} container={container} onOpenAutoFocus={onOpenAutoFocus}>
        <DialogHeader>
          <DialogTitle className="leading-snug">{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <DialogBody className="space-y-3">{children}</DialogBody>
        {footer ? <DialogFooter>{footer}</DialogFooter> : null}
      </DialogContent>
    </Dialog>
  );
}

export function PlanBody({ widget }: { widget: StepCardWidget }) {
  return <StepCard widget={widget} />;
}

export function TodosBody({ items }: { items: readonly TodoItem[] }) {
  return <TodoList items={items} />;
}

/**
 * Every decision of a Step, one after the other, each with every option the harness weighed and
 * why. At the gate they are a form: nothing preselected — the harness's pick is marked as its
 * recommendation, not taken as the answer — and "Something else" for an answer it did not offer.
 * Before the gate they are a record.
 */
export function DecisionsBody({
  widgets,
  answers,
  onAnswer,
  confirming,
  sessionId,
  onChat,
}: {
  widgets: readonly DecisionWidget[];
  answers: readonly DecisionAnswer[];
  onAnswer: (answer: DecisionAnswer) => void;
  confirming: boolean;
  /** The Session the decisions were made in — what "Explain to me" asks about. */
  sessionId: string | null;
  /** "Chat about it": take this decision to the Task's conversation, in the terminal. */
  onChat?: ((widget: DecisionWidget) => void) | undefined;
}) {
  return (
    <ol className="space-y-3">
      {widgets.map((widget, index) => (
        <li key={widget.id}>
          <DecisionEditor
            widget={widget}
            index={index + 1}
            answer={answers.find((a) => a.id === widget.id) ?? null}
            onAnswer={onAnswer}
            confirming={confirming}
            sessionId={sessionId}
            onChat={onChat}
          />
        </li>
      ))}
    </ol>
  );
}

function DecisionEditor({
  widget,
  index,
  answer,
  onAnswer,
  confirming,
  sessionId,
  onChat,
}: {
  widget: DecisionWidget;
  index: number;
  answer: DecisionAnswer | null;
  onAnswer: (answer: DecisionAnswer) => void;
  confirming: boolean;
  sessionId: string | null;
  onChat?: ((widget: DecisionWidget) => void) | undefined;
}) {
  const name = useId();
  const choice = answer?.choice ?? null;
  const settled = choice !== null;
  return (
    <div
      className={cn(
        "space-y-3 rounded-xl border-2 bg-card p-4",
        !confirming ? "border-border" : settled ? "border-state-done/50" : "border-state-review/60",
      )}
    >
      <fieldset
        className="m-0 min-w-0 space-y-2 border-0 p-0"
        data-decision={widget.id}
        // Read by the gate's Approve when it brings the reviewer here: the first unsettled one is
        // where the focus lands.
        data-settled={settled}
        disabled={!confirming}
      >
        <legend className="flex w-full items-start gap-2 px-1 font-semibold text-sm leading-snug">
          <span className="mt-px font-mono text-2xs text-muted-foreground tabular-nums">
            {index}.
          </span>
          <span className="min-w-0 flex-1">{widget.question}</span>
          {confirming ? (
            settled ? (
              <Badge variant="outline" className="shrink-0 border-state-done/50 text-state-done">
                <Check aria-hidden /> confirmed
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="shrink-0 border-state-review/50 text-state-review"
              >
                to confirm
              </Badge>
            )
          ) : null}
        </legend>
        <div className="space-y-1.5">
          {widget.options.map((option) => {
            const recommended = option.id === widget.chosen;
            const checked = confirming ? choice === option.id : recommended;
            return (
              <label
                key={option.id}
                className={cn(
                  "flex items-start gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors",
                  confirming && "cursor-pointer hover:bg-accent/40",
                  checked
                    ? confirming
                      ? "border-state-done/60 bg-state-done/[0.06]"
                      : "border-state-review/40 bg-state-review/[0.05]"
                    : "border-border",
                )}
              >
                <input
                  type="radio"
                  name={name}
                  value={option.id}
                  checked={checked}
                  readOnly={!confirming}
                  onChange={() => onAnswer({ id: widget.id, choice: option.id })}
                  className="mt-1"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{option.label}</span>
                  {recommended ? (
                    <span className="ml-2 inline-flex items-center gap-1 rounded bg-muted px-1.5 text-2xs text-muted-foreground">
                      <DecisionMark /> AI's pick
                    </span>
                  ) : null}
                  {option.why ? (
                    <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
                      {option.why}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
          {confirming ? (
            <label
              className={cn(
                "flex cursor-pointer items-start gap-2.5 rounded-lg border border-dashed px-3 py-2 text-sm hover:bg-accent/40",
                choice === "other" && "border-state-done/60 border-solid",
              )}
            >
              <input
                type="radio"
                name={name}
                value="other"
                checked={choice === "other"}
                onChange={() =>
                  onAnswer({ id: widget.id, choice: "other", note: answer?.note ?? "" })
                }
                className="mt-1"
              />
              <span className="font-medium">Something else</span>
            </label>
          ) : null}
          {choice === "other" ? (
            <div className="space-y-1 pl-1">
              <label htmlFor={`${name}-note`} className="block text-muted-foreground text-xs">
                Your decision — sent to this step's harness verbatim
              </label>
              <Textarea
                id={`${name}-note`}
                rows={3}
                value={answer?.note ?? ""}
                placeholder="e.g. Keep both, but put the migration behind a flag."
                onChange={(e) => onAnswer({ id: widget.id, choice: "other", note: e.target.value })}
                className="text-sm"
              />
            </div>
          ) : null}
        </div>
        {widget.reason ? (
          <p className="text-muted-foreground text-xs leading-relaxed">
            <span className="font-medium text-foreground/80">Harness's reason:</span>{" "}
            {widget.reason}
          </p>
        ) : null}
      </fieldset>
      <DecisionHelp widget={widget} sessionId={sessionId} onChat={onChat} />
    </div>
  );
}

/** What the ask can say when it fails, in words — the code is never shown. */
const EXPLAIN_FAILED: Record<string, string> = {
  [ExplainErrorCode.NoCredential]:
    "This task's harness profile has no usable credential — check the Secret it points at.",
};

/**
 * The two ways to understand a decision before taking a side.
 *
 * "Explain to me" asks the Task's own harness to read the decision back in plain words — billed,
 * so asked on the press and only once, and kept with the dialog — and the answer lands under the
 * decision. "Chat about it" takes the decision to the Task's conversation in the terminal, with a
 * first line typed for you to finish, for when one answer is not enough.
 */
function DecisionHelp({
  widget,
  sessionId,
  onChat,
}: {
  widget: DecisionWidget;
  sessionId: string | null;
  onChat?: ((widget: DecisionWidget) => void) | undefined;
}) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const explain = trpc.session.explainDecision.useMutation();
  const shown = open && Boolean(explain.data);
  const ask = () => {
    setOpen(true);
    if (!sessionId || explain.data || explain.isPending) return;
    explain.mutate({
      sessionId,
      decisionId: widget.id,
      language: typeof navigator === "undefined" ? "en" : navigator.language,
    });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="xs"
          variant="outline"
          disabled={!sessionId}
          loading={explain.isPending}
          aria-expanded={shown}
          aria-controls={explain.data ? panelId : undefined}
          onClick={shown ? () => setOpen(false) : ask}
        >
          <MessageCircleQuestion aria-hidden />
          {shown ? "Hide the explanation" : "Explain to me"}
        </Button>
        {onChat ? (
          <Button type="button" size="xs" variant="outline" onClick={() => onChat(widget)}>
            <MessagesSquare aria-hidden /> Chat about it
          </Button>
        ) : null}
      </div>
      {explain.error && open ? (
        <p className="text-feedback-error text-xs" role="alert">
          {EXPLAIN_FAILED[explain.error.message] ??
            "The task's harness could not answer. Try again in a moment."}{" "}
          <button
            type="button"
            className="underline underline-offset-2"
            onClick={() =>
              sessionId &&
              explain.mutate({
                sessionId,
                decisionId: widget.id,
                language: typeof navigator === "undefined" ? "en" : navigator.language,
              })
            }
          >
            Try again
          </button>
        </p>
      ) : null}
      {shown && explain.data ? (
        <div
          id={panelId}
          className="space-y-2 rounded-lg bg-muted/40 px-4 py-3 text-sm leading-relaxed"
          data-decision-explanation={widget.id}
        >
          <HarnessMarkdown text={explain.data.text} />
          <p className="text-2xs text-muted-foreground-subtle">
            A reading by the task's harness
            {explain.data.model ? ` (${explain.data.model})` : ""}
            {explain.data.cached ? ", kept from an earlier ask" : ""} — not part of the record.
          </p>
        </div>
      ) : null}
    </div>
  );
}

/** Where a dialog of decisions puts the focus: the first one still to settle. */
export function focusFirstUnsettled(event: Event): void {
  const content = event.currentTarget as HTMLElement | null;
  const input = content?.querySelector<HTMLElement>(
    '[data-decision][data-settled="false"] input[type="radio"]',
  );
  if (!input) return;
  event.preventDefault();
  input.focus();
}

/** The permission, in the transcript's own card: the question, the policy note, the options. */
export function PermissionBody({
  row,
  onRespond,
}: {
  row: PermissionRow;
  onRespond: ((optionId: string) => void) | undefined;
}) {
  return (
    <PermissionCard
      row={row}
      onRespond={(optionId) => {
        onRespond?.(optionId);
      }}
    />
  );
}

/** Every question of a Step, numbered, each drawn by its own widget renderer. */
export function AsksBody({
  rows,
  onRespond,
}: {
  rows: readonly WidgetRow[];
  /** Absent once there is no live harness to answer: the questions are then a record. */
  onRespond: ((widgetId: string, values: string[], text?: string) => void) | undefined;
}) {
  return (
    <ol className="space-y-3">
      {rows.map((row, index) => {
        const Renderer = rendererFor(row.widget.kind);
        const open = row.response === null && onRespond !== undefined;
        return (
          <li
            key={row.id}
            className={cn(
              "space-y-2 rounded-xl border-2 p-4",
              open ? "border-state-review/60" : "border-border",
            )}
            data-ask={row.widgetId}
          >
            <p className="flex items-center gap-2 text-2xs text-muted-foreground uppercase tracking-[0.14em]">
              <span className="font-mono tabular-nums">{index + 1}.</span>
              {open ? <span className="text-state-review">Waiting for you</span> : "Answered"}
            </p>
            <Renderer
              widget={row.widget}
              response={row.response}
              {...(open
                ? { onRespond: (values, text) => onRespond?.(row.widgetId, values, text) }
                : {})}
            />
          </li>
        );
      })}
    </ol>
  );
}

export function asksTitle(rows: readonly WidgetRow[]): string {
  const first = rows[0];
  return rows.length === 1 && first ? questionText(first) : `${rows.length} questions`;
}

const STATUS_WORD: Record<BoardColumn["status"] | "gate", string> = {
  done: "Done",
  running: "Running",
  waiting: "Waiting",
  failed: "Failed",
  upcoming: "Not started",
  gate: "At the gate",
};

/** How a Step ends, in the words the Workflow editor uses for its gate. */
const GATE_WORD: Record<WorkflowStepDto["gate"], string> = {
  human: "A person approves it",
  auto: "It moves on by itself",
  "auto-unless-changes": "It moves on by itself, unless it changed files",
  "agent-decides": "The AI decides: a person reviews it unless the harness says REVIEW: no",
};

/**
 * A Step, opened from its header: what it is told to do, how it ends, and the way to read it —
 * the board scoped to its cards (the strip's tab for it).
 */
export function StepBody({
  column,
  step,
  position,
  total,
  workflowId,
  state,
  onShowOnBoard,
  forced = false,
  onForceReview,
}: {
  column: BoardColumn;
  step: WorkflowStepDto | null;
  position: number;
  total: number;
  workflowId: string | null;
  state: TaskState;
  onShowOnBoard: () => void;
  /** A review was forced on this Step for this Task — and the way to change that. */
  forced?: boolean;
  onForceReview?: ((force: boolean) => void) | undefined;
}) {
  const parts: string[] = [];
  for (const item of column.items) {
    if (item.kind === "plan") parts.push("the plan");
    else if (item.kind === "todos") parts.push(`a todo list of ${item.items.length}`);
    else if (item.kind === "decisions")
      parts.push(`${item.widgets.length} ${item.widgets.length === 1 ? "decision" : "decisions"}`);
    else if (item.kind === "asks")
      parts.push(`${item.rows.length} ${item.rows.length === 1 ? "question" : "questions"}`);
    else if (item.kind === "permission") parts.push("a permission");
    else parts.push("the gate");
  }
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5">
        <dt className="text-muted-foreground">Position</dt>
        <dd>
          Step {position} of {total}
        </dd>
        <dt className="text-muted-foreground">Status</dt>
        <dd>
          {STATUS_WORD[column.status === "waiting" && state === "review" ? "gate" : column.status]}
        </dd>
        {step ? (
          <>
            <dt className="text-muted-foreground">Ends when</dt>
            <dd>{GATE_WORD[step.gate]}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">On the board</dt>
        <dd>{parts.length === 0 ? "Nothing yet" : parts.join(" · ")}</dd>
      </dl>
      {step?.promptTemplate ? (
        <section aria-label="The step's prompt" className="space-y-1.5">
          <h3 className="flex items-center gap-1.5 font-medium text-xs text-muted-foreground uppercase tracking-[0.14em]">
            <ScrollText aria-hidden className="size-3.5" /> Prompt
          </h3>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
            {step.promptTemplate}
          </pre>
        </section>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {step ? (
          <Button variant="outline" size="sm" onClick={onShowOnBoard}>
            <Focus aria-hidden /> Show this step on the board
          </Button>
        ) : null}
        {step && onForceReview ? (
          <Button
            variant={forced ? "secondary" : "outline"}
            size="sm"
            aria-pressed={forced}
            onClick={() => onForceReview(!forced)}
          >
            <UserCheck aria-hidden /> {forced ? "Review forced — undo" : "Force review"}
          </Button>
        ) : null}
        {workflowId ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={`/workflows/${workflowId}`}>Open the workflow</Link>
          </Button>
        ) : null}
      </div>
    </div>
  );
}
