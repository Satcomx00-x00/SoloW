"use client";

import type {
  DecisionWidget,
  ReviewDecision,
  ReviewDraftFile,
  ReviewNote,
  SessionEventDto,
  SessionRoundDto,
  TaskDiffDto,
  TaskDto,
  TaskEvent,
  TaskInputAck,
  TaskRepositoryDto,
  TaskState,
} from "@solow/contracts";
import {
  canOpenReview,
  isGeneratedPath,
  primaryTaskRepository,
  retentionExpiresAt,
  withinRetention,
} from "@solow/core";
import {
  ArchiveRestore,
  ArrowLeft,
  Check,
  CheckCircle2,
  CircleSlash,
  Copy,
  FileDiff,
  GitBranch,
  ListChecks,
  OctagonAlert,
  SquareTerminal,
  Trash2,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { useBackToProject } from "@/components/features/shared/back-to-project";
import { draftFileKey, useReviewDraft } from "@/components/hooks/use-review-draft";
import { useTaskStream } from "@/components/hooks/use-task-stream";
import { useUrlTab } from "@/components/hooks/use-url-tab";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { settingsHref } from "@/lib/navigation";
import { WHOLE_PAGE } from "@/lib/paged";
import { relativeAge, relativeUntil } from "@/lib/relative-time";
import { taskActionMessage } from "@/lib/task-errors";
import { CREDENTIAL_EXPIRED_REASON, failureReasonLabel, STATE_STYLE } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { ChangesPanel } from "./changes-panel";
import { DeleteTaskAction } from "./delete-task-action";
import { EmptyPanel } from "./empty-panel";
import { gateDecisions } from "./gate-decisions";
import { HarnessComposer } from "./harness-composer";
import { LaunchTaskDialog, useWorkflowChoices } from "./launch-task-dialog";
import { ReviewBriefPanel } from "./review-brief";
import { collateDecisions, collateFeedback, joinFeedback } from "./review-feedback";
import { groupChanges, summariseConsequences } from "./review-groups";
import type { LineAnchor } from "./review-notes";
import { RoundSelector } from "./round-selector";
import { noticesNewRunLink, RunLinks } from "./run-links";
import { ParentChain, SplitTaskButton, SubtaskList } from "./subtasks-panel";
import { TaskAdvance } from "./task-advance";
import { type BoardHandle, TaskBoard } from "./task-board";
import {
  AsksBody,
  asksTitle,
  BoardDialog,
  DecisionsBody,
  focusFirstUnsettled,
  PermissionBody,
  PlanBody,
  StepBody,
  TodosBody,
} from "./task-board-dialogs";
import {
  type BoardColumn,
  type BoardItem,
  boardColumns,
  boardTally,
  needsYou,
  type StepHistory,
  stepFacts,
} from "./task-board-model";
import {
  AsksNode,
  type DecisionAnswer,
  DecisionMark,
  DecisionsNode,
  GateNode,
  PermissionNode,
  PlanNode,
  TodoNode,
} from "./task-board-nodes";
import { TaskDependencies, useBlockedByEditor, useTaskDependencies } from "./task-dependencies";
import { TaskFooter } from "./task-footer";
import { TaskMetaList, TaskRepositories } from "./task-meta";
import { TaskTerminal, type TerminalMode } from "./task-terminal";
import {
  latestCompletion,
  latestStepCard,
  openItemsOf,
  type StepCardWidget,
  type TaskCompleteWidget,
} from "./todo-list";
import { buildTranscript, inStepScope } from "./transcript";
import { useStepScope, WorkflowPosition } from "./workflow-steps";

/**
 * What the harness said about how its run ended, in the header.
 *
 * `changes_ready` on a `running` Task is also the footer's "Open review" moment; the header
 * still names the outcome beside it.
 *
 * Each outcome carries its own glyph as well as its own words. One check-circle for all three
 * said "finished well" over a run that had given up, which is the same failure the labels here
 * were written to fix — the icon is read first, and it was contradicting the sentence beside it.
 */
const COMPLETION_OUTCOME: Record<string, { label: string; icon: typeof CheckCircle2 }> = {
  changes_ready: { label: "Finished — changes ready", icon: CheckCircle2 },
  nothing_to_do: { label: "Nothing to do", icon: CircleSlash },
  blocked: { label: "Stopped — blocked", icon: OctagonAlert },
};

/** Shared empty array, so "no events yet" keeps a stable identity across renders. */
const NO_EVENTS: SessionEventDto[] = [];
/** Stable empties, for the same reason `NO_EVENTS` is one: a fresh literal misses every memo. */
const NO_DIFFS: TaskDiffDto[] = [];
const NO_ATTACHMENTS: TaskRepositoryDto[] = [];
const NO_ROUNDS: SessionRoundDto[] = [];
const NO_STEP_IDS: readonly string[] = [];

const STREAM_LABEL: Record<string, string> = {
  idle: "Not streaming",
  connecting: "Connecting…",
  open: "Live",
  reconnecting: "Reconnecting…",
  error: "Stream offline",
};

/**
 * Connection health, told by colour as well as by word.
 *
 * The feedback family, not the lifecycle one. A socket that is open, retrying or dead says
 * nothing about where the Task is in its life — it used to borrow Done green, Review amber and
 * Failed red, which meant a reconnecting stream wore the exact colour the board reserves for
 * "a person is needed here". Two unrelated facts sharing three tokens is what the Three Families
 * Rule exists to prevent.
 */
const STREAM_TONE: Record<string, string> = {
  idle: "text-muted-foreground-subtle",
  connecting: "text-muted-foreground",
  open: "text-feedback-ok",
  reconnecting: "text-feedback-caution",
  error: "text-feedback-error",
};

/** How the last run ended, as the app's soft badge — one shape, one definition, like every other. */
function CompletionBadge({ outcome }: { outcome: string | null }) {
  const completion = COMPLETION_OUTCOME[outcome ?? "blocked"] ?? COMPLETION_OUTCOME.blocked;
  if (!completion) return null;
  const Icon = completion.icon;
  return (
    <Badge variant="outline" className="shrink-0">
      <Icon aria-hidden />
      {completion.label}
    </Badge>
  );
}

/**
 * The page's views: the board, and the two pieces of evidence a gate is decided on — the brief
 * and the change. The board is where the run is watched and every question answered, and it
 * replaces the Run and Plan tabs it grew out of: the log moved to the terminal beside it and the
 * plan is on the board, under the Step it belongs to. The gate is on the board too, and under
 * the brief and the change as a bar, so it is never a view away.
 */
type WorkspaceTab = "board" | "brief" | "changes";
const TABS: readonly WorkspaceTab[] = ["board", "brief", "changes"];
/** The terminal pane's id, for the button that opens it. */
const TERMINAL_PANE_ID = "task-terminal-pane";

/** A reading panel: scrolls on its own, one comfortable column wide. The Run panel is not one. */
function ReadingPanel({ children }: { children: ReactNode }) {
  return (
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto max-w-5xl p-4">{children}</div>
    </ScrollArea>
  );
}

/**
 * The page's own shape, drawn empty while the Task loads — a header line, the tab strip, one
 * panel, the foot — so what arrives lands in place instead of jumping into it. Held back 300ms:
 * a warm cache answers well inside that, and a skeleton that flashes for two frames reads as a
 * glitch, not as loading. `aria-busy` and a hidden line, because a screen reader gets nothing
 * from a pulse — not a live region, which announces nothing when it is born with its content
 * already in it.
 */
function WorkspaceSkeleton() {
  return (
    <div aria-busy className="delayed-reveal flex h-full flex-col" data-workspace-skeleton>
      <span className="sr-only">Loading task</span>
      <div className="flex h-11 items-center gap-2 border-b px-3">
        <Skeleton className="size-7 rounded-md" />
        <Skeleton className="h-5 w-56" />
        <Skeleton className="h-5 w-16 rounded-full" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex items-center gap-4 border-b px-5 py-3">
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-12" />
            <Skeleton className="h-4 w-10" />
            <Skeleton className="h-4 w-16" />
          </div>
          <Skeleton className="m-0 min-h-0 flex-1 rounded-none" />
        </div>
        <div className="hidden w-[400px] shrink-0 flex-col gap-4 border-l p-4 lg:flex">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="h-10" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-24" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-16" />
          <div className="mt-auto space-y-2 border-t pt-4">
            <Skeleton className="h-4 w-48" />
            <Skeleton className="h-9 w-full" />
          </div>
        </div>
      </div>
    </div>
  );
}

/** A titled block of the rail: a caption, an optional control beside it, and the facts. */
function RailSection({
  title,
  action,
  children,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2 px-4 py-3">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h2 className="font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
          {title}
        </h2>
        {action}
      </div>
      {children}
    </section>
  );
}

/** One sentence per state, for the rail's Status block when the run has not reported itself. */
// Worded apart from the decision card's own sentences, which say what to *do*; this says where
// things stand, and the two must not read as one line said twice.
const STATE_SENTENCE: Record<TaskState, string> = {
  backlog: "In the backlog.",
  ready: "Ready to launch.",
  running: "A run is in progress.",
  review: "At the gate — your decision is what moves it.",
  done: "Finished.",
  failed: "The last run failed.",
  parked: "Paused on quota until the window resets.",
};

/**
 * Why the Task is where it is, beside the state that says where — a stranded Review, an
 * expired credential, a quota park. The rail explains and the decision card offers the way
 * out; this is the header saying the same thing in one chip, so "Review" next to "Decision not
 * applied" is never read as two facts that disagree. Drawn in the card's own style for the
 * reason, so the two are visibly one claim.
 */
function FailureChip({ reason, state }: { reason: string; state: TaskState }) {
  const label = failureReasonLabel(reason);
  if (!label) return null;
  const tone = label.tone ?? state;
  const Icon = label.icon ?? STATE_STYLE[tone].icon;
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-px font-medium text-2xs",
        STATE_STYLE[tone].badgeClassName,
      )}
      data-failure-chip={reason}
    >
      <Icon aria-hidden className="size-3 shrink-0" strokeWidth={2.25} />
      {label.label}
    </span>
  );
}

/** The one thing anyone does with a branch name, next to the branch name. */
function CopyBranch({ branch }: { branch: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      aria-label={copied ? "Branch name copied" : "Copy branch name"}
      className={cn(
        "-my-1 inline-flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors duration-100 hover:bg-accent hover:text-foreground",
        copied && "text-feedback-ok",
      )}
      onClick={() => {
        // A clipboard write can be refused (an insecure origin); the name is on screen either way.
        void navigator.clipboard
          ?.writeText(branch)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {copied ? <Check aria-hidden className="size-3" /> : <Copy aria-hidden className="size-3" />}
    </button>
  );
}

/** Live connection indicator: a dot that pulses only while the stream is actually open. */
function StreamIndicator({ status }: { status: string }) {
  return (
    <span
      className={cn("flex items-center gap-1.5 text-2xs", STREAM_TONE[status])}
      aria-live="polite"
      data-stream-status={status}
    >
      <span className="relative flex size-1.5">
        {status === "open" && (
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />
        )}
        <span className="relative inline-flex size-1.5 rounded-full bg-current" />
      </span>
      {STREAM_LABEL[status]}
    </span>
  );
}

/** What the gate node is called, by where the Task stands. */
function gateTitle(state: TaskState, stepName: string): string {
  switch (state) {
    case "review":
      return `Review · ${stepName}`;
    case "failed":
      return "Failed";
    case "parked":
      return "Parked";
    case "ready":
      return "Ready to launch";
    case "backlog":
      return "Backlog";
    case "done":
      return "Done";
    default:
      return "Finished";
  }
}

/**
 * The left pane's index of the board: what kinds of card are on it and how many, each a way to
 * pan to the first of its kind. "Needs you" is amber and counts only what is still open.
 */
function BoardLegend({
  tally,
  needsYou: open,
  files,
  onReveal,
  onFiles,
}: {
  tally: ReturnType<typeof boardTally>;
  needsYou: number;
  files: number;
  onReveal: (kind: "plan" | "todos" | "decisions" | "needs") => void;
  onFiles: () => void;
}) {
  const row =
    "flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm transition-colors hover:bg-accent/50 disabled:pointer-events-none disabled:opacity-50";
  return (
    <nav aria-label="On the board" className="px-2 pt-4 pb-3">
      <p className="px-2 pb-1.5 font-medium text-2xs text-muted-foreground uppercase tracking-[0.14em]">
        On the board
      </p>
      <ul className="space-y-px">
        <li>
          <button
            type="button"
            className={row}
            disabled={tally.plans === 0}
            onClick={() => onReveal("plan")}
          >
            <Check aria-hidden className="size-3.5 shrink-0 text-state-done" />
            Plan
          </button>
        </li>
        <li>
          <button
            type="button"
            className={row}
            disabled={tally.todos.of === 0}
            onClick={() => onReveal("todos")}
          >
            <ListChecks aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            Todos
            {tally.todos.of > 0 ? (
              <span className="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
                {tally.todos.done}/{tally.todos.of}
              </span>
            ) : null}
          </button>
        </li>
        <li>
          <button
            type="button"
            className={row}
            disabled={tally.decisions === 0}
            onClick={() => onReveal("decisions")}
          >
            <span className="text-muted-foreground">
              <DecisionMark />
            </span>
            AI decisions
            {tally.decisions > 0 ? (
              <span className="ml-auto font-mono text-2xs text-muted-foreground tabular-nums">
                {tally.decisions}
              </span>
            ) : null}
          </button>
        </li>
        <li>
          <button
            type="button"
            className={cn(row, open > 0 && "text-state-review")}
            disabled={open === 0}
            onClick={() => onReveal("needs")}
            data-needs-you={open}
          >
            <span className={open > 0 ? "text-state-review" : "text-muted-foreground"}>
              <DecisionMark filled={open > 0} />
            </span>
            Needs you
            <span className="ml-auto font-mono text-2xs tabular-nums">{open}</span>
          </button>
        </li>
        <li>
          <button type="button" className={row} disabled={files === 0} onClick={onFiles}>
            <FileDiff aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            {files} {files === 1 ? "file" : "files"}
          </button>
        </li>
      </ul>
    </nav>
  );
}

interface BoardRenderContext {
  state: TaskState;
  /** Whether a card is the one that just arrived, which earns it a "new". */
  fresh: (key: string) => boolean;
  /** A live harness is there to answer: an unanswered question is waiting, not a record. */
  answerable: boolean;
  answers: readonly DecisionAnswer[];
  /** At the gate, where the decisions are confirmed. */
  confirming: boolean;
  /** The decisions that gate is about — the latest round's. Older ones are a record. */
  gateDecisionIds: ReadonlySet<string>;
  /** What the gate card says: its headline, and what stands in the way. */
  gate: { headline: string; detail: string };
  open: (key: string) => void;
}

/** One board card, by kind. Every card is a button; what it opens is `boardDialog`'s. */
function renderBoardItem(item: BoardItem, column: BoardColumn, ctx: BoardRenderContext): ReactNode {
  const open = () => ctx.open(item.key);
  switch (item.kind) {
    case "plan":
      return (
        <PlanNode
          widget={item.widget}
          approved={column.status === "done"}
          onOpen={open}
          pass={item.pass}
        />
      );
    case "todos":
      return (
        <TodoNode
          items={item.items}
          live={column.status === "running"}
          onOpen={open}
          pass={item.pass}
        />
      );
    case "decisions":
      return (
        <DecisionsNode
          widgets={item.widgets}
          answers={ctx.answers}
          confirming={ctx.confirming && item.widgets.some((w) => ctx.gateDecisionIds.has(w.id))}
          onOpen={open}
          pass={item.pass}
        />
      );
    case "permission":
      return (
        <PermissionNode row={item.row} fresh={ctx.fresh(item.key)} onOpen={open} pass={item.pass} />
      );
    case "asks":
      return (
        <AsksNode
          rows={item.rows}
          answerable={ctx.answerable}
          fresh={ctx.fresh(item.key)}
          onOpen={open}
          pass={item.pass}
        />
      );
    case "gate":
      return (
        <GateNode
          title={gateTitle(ctx.state, column.name)}
          headline={ctx.gate.headline}
          detail={ctx.gate.detail}
          attention={needsYou(item, ctx.state)}
          onOpen={open}
          pass={item.pass}
        />
      );
  }
}

/**
 * What the gate says before it is opened: one line on what the decision is, and one on what
 * stands in its way — so the board, and the strip under the brief and the change, tell a
 * reviewer whether the gate is ready for them without opening it.
 */
function gateLines(
  t: TaskDto,
  facts: { decisionsPending: number; openItems: number; files: number; outstanding: number },
): { headline: string; detail: string } {
  const parts: string[] = [];
  switch (t.state) {
    case "review":
      if (facts.decisionsPending > 0)
        parts.push(
          `${facts.decisionsPending} AI ${facts.decisionsPending === 1 ? "decision" : "decisions"} to confirm`,
        );
      if (facts.openItems > 0)
        parts.push(
          `${facts.openItems} ${facts.openItems === 1 ? "thing" : "things"} left undone (open ${facts.openItems === 1 ? "item" : "items"})`,
        );
      if (facts.files > 0)
        parts.push(`${facts.files} changed ${facts.files === 1 ? "file" : "files"}`);
      return {
        headline: "Your decision is needed",
        detail: parts.join(" · ") || "Nothing flagged",
      };
    case "failed":
    case "parked":
      return {
        headline:
          failureReasonLabel(t.failureReason ?? "")?.label ??
          (t.state === "parked" ? "Paused on quota" : "The run failed"),
        detail: t.state === "parked" ? "Run it now, or let the window reset" : "Retry from here",
      };
    case "ready":
      return {
        headline: "Ready to launch",
        detail:
          facts.outstanding > 0
            ? `Waits on ${facts.outstanding} ${facts.outstanding === 1 ? "task" : "tasks"}`
            : "Launch from here",
      };
    case "backlog":
      return { headline: "In the backlog", detail: "Move it to Ready when it can be worked on" };
    case "done":
      return { headline: t.completedSummary ?? "Finished", detail: "Reopen from here" };
    default:
      return {
        headline:
          t.completedOutcome === "changes_ready"
            ? "Finished — changes ready"
            : "Finished — open the review",
        detail: "Open the review to decide",
      };
  }
}

/** The gate, under the brief and the change: one line, and the way into the gate itself. */
function GateStrip({
  title,
  lines,
  attention,
  onOpen,
}: {
  title: string;
  lines: { headline: string; detail: string };
  attention: boolean;
  onOpen: () => void;
}) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-3 border-t px-4 py-2.5",
        attention && "border-state-review/30 bg-state-review/[0.06]",
      )}
      data-gate-strip
    >
      <span className={cn("shrink-0", attention ? "text-state-review" : "text-muted-foreground")}>
        <DecisionMark filled={attention} />
      </span>
      <p className="min-w-0 flex-1 truncate text-sm">
        <span className="font-medium">{title}</span>
        <span className="text-muted-foreground">
          {" "}
          — {lines.headline} · {lines.detail}
        </span>
      </p>
      <Button size="sm" variant={attention ? "default" : "outline"} onClick={onOpen}>
        Open the gate
      </Button>
    </div>
  );
}

/** The terminal pane's width, remembered per browser. */
const TERMINAL_WIDTH_KEY = "solow.task.terminalWidth";
const TERMINAL_MIN = 360;
const TERMINAL_DEFAULT = 520;
/** Never so wide that the board beside it has nothing left. */
const terminalMax = () =>
  typeof window === "undefined" ? 1200 : Math.max(TERMINAL_MIN, window.innerWidth * 0.65);

type TerminalWidth = ReturnType<typeof useTerminalWidth>;

/**
 * How wide the terminal is: the operator's to set, by dragging its edge or with the arrow keys
 * on it, and kept in this browser — a convenience, so a storage that refuses is simply the
 * default width every time.
 */
function useTerminalWidth() {
  const [width, setWidthState] = useState(() => {
    try {
      const stored = Number(window.localStorage.getItem(TERMINAL_WIDTH_KEY));
      return Number.isFinite(stored) && stored >= TERMINAL_MIN ? stored : TERMINAL_DEFAULT;
    } catch {
      return TERMINAL_DEFAULT;
    }
  });
  const setWidth = useCallback((next: number) => {
    const clamped = Math.round(Math.min(terminalMax(), Math.max(TERMINAL_MIN, next)));
    setWidthState(clamped);
    try {
      window.localStorage.setItem(TERMINAL_WIDTH_KEY, String(clamped));
    } catch {
      // Not remembered; the width still holds for this visit.
    }
  }, []);
  return { width, setWidth };
}

/** The terminal's left edge: drag it, or focus it and use the arrows, to change the width. */
function TerminalResizer({ handle }: { handle: TerminalWidth }) {
  const { width, setWidth } = handle;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a pane splitter is the ARIA `separator` pattern; <hr> cannot take focus or a value
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the terminal"
      aria-valuemin={TERMINAL_MIN}
      aria-valuemax={Math.round(terminalMax())}
      aria-valuenow={width}
      tabIndex={0}
      className="-left-1 absolute inset-y-0 z-10 hidden w-2 cursor-col-resize touch-none outline-none after:absolute after:inset-y-0 after:left-1/2 after:w-px after:bg-transparent after:transition-colors hover:after:bg-ring focus-visible:after:bg-ring md:block"
      onPointerDown={(event) => {
        event.preventDefault();
        const startX = event.clientX;
        const start = width;
        const move = (e: PointerEvent) => setWidth(start + (startX - e.clientX));
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 80 : 20;
        if (event.key === "ArrowLeft") setWidth(width + step);
        else if (event.key === "ArrowRight") setWidth(width - step);
        else return;
        event.preventDefault();
      }}
    />
  );
}

/** The IDE-like Task workspace: harness terminal + git changes + review gate. */
export function TaskWorkspace({ taskId }: { taskId: string }) {
  const utils = trpc.useUtils();
  // `includeDeleted`: this page is one of the two readers History points at, and a Task opened
  // from there is in History — readable, restorable, and nothing else (Decision 0025).
  const task = trpc.task.get.useQuery({ id: taskId, includeDeleted: true });
  const deleted = task.data?.deletedAt ?? null;
  const restore = trpc.task.restore.useMutation({
    onSuccess: async () => {
      // Cancelled before invalidating: a list still on its first read (this page opened a moment
      // ago — the rail's Sub-tasks) would otherwise have the invalidation join that read, which
      // began while the Task was in History, and settle on its answer (see `SplitTaskButton`).
      // A cancelled read with no data yet goes back to unloaded, and the invalidation reads anew.
      await utils.task.list.cancel();
      void utils.task.get.invalidate({ id: taskId });
      void utils.task.list.invalidate();
      void utils.history.list.invalidate();
    },
  });
  // Back goes to the board of the Project holding this Task's Issue (see `useBackToProject`).
  const back = useBackToProject(task.data?.issueId, "/board");
  /**
   * Which Workflow Step the terminal is showing — the strip below owns the gesture, this owns
   * the consequence (see `useStepScope`).
   *
   * Above the Session queries because it is an *argument* to them. A Session spans the whole
   * pipeline, and filtering its events after they arrived would still transfer every Step's
   * output and hold all of it in memory — which is the entire problem. Null means the whole run,
   * and is what every Task on no Workflow gets: the request is then byte-for-byte the one this
   * page has always made.
   */
  const scope = useStepScope(task.data ?? null);
  const sessions = trpc.session.listForTask.useQuery({ taskId });
  const latest = sessions.data?.[0];
  /**
   * Which Session the transcript and the Changes tab show (F10 FR-7).
   *
   * The newest, unless an earlier launch — a Session from a Retry — was picked from the round
   * selector. Only the *reading* follows the pick: decisions, steering and the plan stay on
   * `latest`, because that is the run a gate or a harness could still be waiting on.
   */
  const [sessionPick, setSessionPick] = useState<string | null>(null);
  const viewing = sessions.data?.find((s) => s.id === sessionPick) ?? latest;
  const detail = trpc.session.get.useQuery(
    {
      sessionId: viewing?.id ?? "",
      ...(scope.selected ? { workflowStepId: scope.selected } : {}),
    },
    // Held until the scope is settled: firing unscoped and refiring a moment later would fetch
    // the whole pipeline exactly once per page load, which is the cost being removed.
    { enabled: Boolean(viewing?.id) && scope.settled },
  );

  /**
   * Live harness stream (TASK-018). Output arrives as the harness produces it; this is about
   * everything *around* the output, which the transcript does not carry.
   *
   * The rule the page needs is that nothing here is ever true only after a reload. Two things
   * broke it. The orchestrator announced state changes on the board channel alone, so a run that
   * finished left this page — the one dedicated to that Task — saying the harness was still
   * writing; that is fixed on the publishing side. And this handler never invalidated
   * `session.get`, which is where the diffs, the summaries and the persisted events live: a
   * `diff` event arrived, the Task refetched, and the Changes panel beside it kept showing the
   * previous round's files.
   *
   * `session.get` is keyed by session id and the Session that matters can *change* — a Retry
   * opens a new one (a `request_changes` resumes the same one) — so the invalidation is unkeyed
   * on purpose. Naming `latest.id` would refresh the Session this render happens to know about,
   * which is precisely the one that has just been superseded.
   */
  /**
   * Links this page has already accounted for, so the same MR printed by every later
   * `glab mr view` costs nothing. Per mount, which is exactly the lifetime of the socket whose
   * frames fill it; a reload starts over and the first frame carrying a known link refetches
   * once, which is harmless.
   */
  const seenLinks = useRef<Set<string>>(new Set());
  const onLive = useCallback(
    (event: TaskEvent) => {
      // A merge request opened mid-run produces no `status` and no `diff`, so nothing below
      // would refetch the Session that holds the link. Noticing it here is what puts the button
      // on the page while the run is still going (see `noticesNewRunLink`).
      if (noticesNewRunLink(event, seenLinks.current)) utils.session.get.invalidate();
      if (event.kind === "status" || event.kind === "diff") {
        utils.task.get.invalidate({ id: taskId });
        utils.session.listForTask.invalidate({ taskId });
        utils.session.get.invalidate();
        // A Step advancing announces the state too, so this is what moves the step strip.
        utils.workflow.taskBinding.invalidate({ taskId });
        // …and what tells a Step's passes apart on the board, when the Workflow loops.
        utils.session.stepDecisions.invalidate({ taskId });
        // Readiness is derived from the blockers' states, so a predecessor finishing is what
        // un-refuses Launch here — the board re-reads the edges on every status for the same reason.
        utils.task.dependencies.invalidate();
        // The Issue above this Task derives its status from the Tasks under it, so a run that
        // finishes changes what the Issues list and the board card would say. Both are a
        // navigation away and would otherwise be stale on arrival.
        utils.issue.list.invalidate();
        utils.task.list.invalidate();
      }
    },
    [utils, taskId],
  );
  const [ack, setAck] = useState<TaskInputAck | null>(null);
  const onAck = useCallback((next: TaskInputAck) => setAck(next), []);
  const live = useTaskStream(taskId, { onEvent: onLive, onAck });
  const router = useRouter();
  /**
   * A steer typed while the stream was away (TASK-022).
   *
   * The socket blinks — a hub restart, a laptop lid — and `sendInput` drops what it cannot
   * deliver. Rather than disable the box for those seconds, the workspace holds the one message
   * here and sends it the moment the stream is back. One message, not a queue: a second send
   * while the first is waiting replaces it, which is what an operator who has just rephrased
   * wants. It is thrown away if the Task stops Running first, because then there is no harness
   * for it to reach and a message that arrives at the *next* run would be steering blind.
   */
  const [queued, setQueued] = useState<string | null>(null);
  // A stop pressed while the stream was away, held by the same rule as a steer: it goes the
  // moment the stream is back, and is dropped if the Task leaves Running first.
  const [stopQueued, setStopQueued] = useState(false);
  // A Task in History is never steered: its run was stopped on the way out, whatever its row
  // still says, and a message to it would reach the next run or nothing.
  const isRunning = task.data?.state === "running" && deleted === null;
  useEffect(() => {
    if (queued === null) return;
    if (!isRunning) {
      setQueued(null);
      return;
    }
    if (live.status === "open" && live.sendInput(queued)) setQueued(null);
  }, [queued, isRunning, live.status, live.sendInput]);
  useEffect(() => {
    if (!stopQueued) return;
    if (!isRunning) {
      setStopQueued(false);
      return;
    }
    if (live.status === "open") {
      live.stopHarness();
      setStopQueued(false);
    }
  }, [stopQueued, isRunning, live.status, live.stopHarness]);

  /**
   * Which view is showing, when the operator has said.
   *
   * The board by default, in every state: the run, its questions and its gate are all on it. A
   * manual pick sticks until the Task changes state — a reviewer who opened the change during the
   * run is taken back to the board when the gate opens on it. The pick is also in the URL
   * (`?tab=`), so a refresh stays put and a link to the Changes view is a link to the Changes
   * view; it is read once, on arrival, and written on every pick. An old `?tab=run` or `?tab=plan`
   * is not a view any more, and reads as no pick at all — which lands on the board, where both went.
   */
  const [urlTab, setUrlTab] = useUrlTab("tab", TABS);
  const [tabPick, setTabPick] = useState<{ tab: WorkspaceTab; state: TaskState | null } | null>(
    () => (urlTab ? { tab: urlTab, state: null } : null),
  );
  /**
   * The terminal pane, beside the board rather than instead of it: the board stays in the middle
   * and in sync, and an answer typed in the terminal settles the node on the board as well,
   * because both are drawn from the one stream. Closed until asked for — the board is the page.
   */
  const [terminalOpen, setTerminalOpen] = useState(false);
  // Whether the shell has been started at all: the pane is mounted from then on, hidden or not.
  const terminalStarted = useRef(false);
  /** What the terminal mounted — the Task's conversation, or a shell — for the pane's header. */
  const [terminalMode, setTerminalMode] = useState<TerminalMode | null>(null);
  /** A line "Chat about it" asked the terminal to type into the conversation. */
  const [terminalInject, setTerminalInject] = useState<{ id: number; text: string } | null>(null);
  if (terminalOpen) terminalStarted.current = true;
  const terminalWidth = useTerminalWidth();
  /**
   * Which card's dialog is open, by its key — never the item itself, so the dialog reads the
   * card as it is *now*: a permission settled from the terminal, a decision answered, a gate
   * that has moved on. A key that no longer names a card closes the dialog.
   */
  const [opened, setOpened] = useState<
    { type: "item"; key: string } | { type: "step"; id: string } | null
  >(null);
  /** The page's own root: the board's dialogs mount here, inside `main`, not at the body. */
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const terminalButton = useRef<HTMLButtonElement | null>(null);
  const boardPanel = useRef<HTMLDivElement | null>(null);
  const board = useRef<BoardHandle | null>(null);

  /**
   * The transcript, built once per change rather than per render.
   *
   * Above the loading and error guards on purpose: it is a hook, and a hook after an early
   * return is a hook that sometimes does not run — which React detects as a change in hook
   * order and refuses.
   *
   * `buildTranscript` also deduplicates its two sources against each other. The socket replays
   * from the beginning on its first connection, so every event of an already-started Task
   * arrives both here and from `session.get`; the old terminal concatenated the two and showed
   * the whole run twice.
   */
  // `?? NO_EVENTS` rather than `?? []`: a fresh literal is a new identity on every render, which
  // would make the memo below miss every time and rebuild the whole transcript per render —
  // reintroducing, quietly, the cost this replaced.
  const events = detail.data?.events ?? NO_EVENTS;
  /**
   * The live half of the same narrowing.
   *
   * `session.get` answered a question at a moment; the socket keeps answering it, and a Step
   * scope that the server applied and the stream did not would show one Step's history with the
   * next Step's output arriving underneath it. `inStepScope` owns which frames survive — briefly:
   * anything carrying no Step at all does, because unattributed is not a Step to be filtered to.
   *
   * `live.events` is returned as-is when nothing is selected, so the unscoped page allocates no
   * array and the memo below sees the identity it always did.
   */
  const liveEvents = useMemo(
    () =>
      scope.selected === null
        ? live.events
        : live.events.filter((event) => inStepScope(event, scope.selected)),
    [live.events, scope.selected],
  );
  const rows = useMemo(() => buildTranscript(events, liveEvents), [events, liveEvents]);

  const liveSessionId = latest?.id;
  // The harness's plan as a `step_card` widget, from both of the page's sources: `session.get` holds
  // it as it stood when the query ran and the socket holds everything since, so live wins — from
  // the Session on screen only, because `seq` restarts per Session (see `latestStepCard`).
  const stepCard = useMemo<StepCardWidget | null>(() => {
    for (let i = live.events.length - 1; i >= 0; i -= 1) {
      const event = live.events[i];
      if (
        event?.kind === "widget" &&
        event.sessionId === liveSessionId &&
        event.widget.kind === "step_card"
      )
        return event.widget;
    }
    return latestStepCard(events);
  }, [events, live.events, liveSessionId]);
  /**
   * The decisions the harness emitted, latest per id, from both sources (point 3). They are on
   * the board as nodes, and the gate waits for each to be settled.
   */
  const decisions = useMemo<DecisionWidget[]>(() => {
    const byId = new Map<string, DecisionWidget>();
    for (const event of events) {
      const payload = event.payload;
      if (payload.kind === "widget" && payload.widget.kind === "decision") {
        byId.set(payload.widget.id, payload.widget);
      }
    }
    for (const event of live.events) {
      if (
        event.kind === "widget" &&
        event.sessionId === liveSessionId &&
        event.widget.kind === "decision"
      ) {
        byId.set(event.widget.id, event.widget);
      }
    }
    return [...byId.values()];
  }, [events, live.events, liveSessionId]);
  /**
   * What the board files under each Step: its plan, its todo list, its decisions. The workspace's
   * own `stepCard` and `decisions` above are the Session-wide answers the gate needs; this is the
   * same reading split by where it happened.
   */
  const facts = useMemo(
    () => stepFacts(events, live.events, liveSessionId),
    [events, live.events, liveSessionId],
  );
  /**
   * Which Steps finished, and when (`session.stepDecisions`): how the board tells a Step that
   * ran before a loop from one that has not started. Only for a Task on a Workflow.
   */
  /**
   * "Force review" on a Step (the board's right-click, and the Step's dialog): a Step of this
   * Task's Workflow that waits for a person at its next finish, whatever its gate says.
   */
  const forceReview = trpc.workflow.forceReview.useMutation({
    onSuccess: () => utils.workflow.taskBinding.invalidate({ taskId }),
  });
  const forcedReview = scope.binding?.forcedReviewStepIds ?? NO_STEP_IDS;
  const stepDecisions = trpc.session.stepDecisions.useQuery(
    { taskId },
    { enabled: Boolean(task.data?.workflowId) },
  );
  const stepHistory = useMemo<StepHistory | null>(() => {
    if (!stepDecisions.data || !sessions.data) return null;
    // `listForTask` is newest first; the history ranks Sessions oldest first.
    const sessionOrder = new Map(
      [...sessions.data].reverse().map((s, index) => [s.id, index] as const),
    );
    return { decisions: stepDecisions.data, sessionOrder };
  }, [stepDecisions.data, sessions.data]);
  // The harness's own report, for what it left open (point 5 of the review analysis).
  const completion = useMemo<TaskCompleteWidget | null>(() => {
    for (let i = live.events.length - 1; i >= 0; i -= 1) {
      const event = live.events[i];
      if (
        event?.kind === "widget" &&
        event.sessionId === liveSessionId &&
        event.widget.kind === "task_complete"
      )
        return event.widget;
    }
    return latestCompletion(events);
  }, [events, live.events, liveSessionId]);
  const openItems = useMemo(() => openItemsOf(completion, stepCard), [completion, stepCard]);
  // The count on the Review tab: how many criteria the reviewer has not ticked. The same query
  // the panel makes — React Query hands both the one response.
  const briefQuery = trpc.session.reviewBrief.useQuery(
    { sessionId: latest?.id ?? "" },
    { enabled: Boolean(latest?.id) },
  );
  const briefCriteria = briefQuery.data?.criteria.length ?? null;

  const [input, setInput] = useState("");
  // The decision this page last sent, held until the Task row moves on (see `decisionSent`).
  const [sent, setSent] = useState<{
    sessionId: string;
    decision: ReviewDecision;
    mark: string;
  } | null>(null);
  const decide = trpc.review.decide.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
      // The decision is the record now; the draft that led to it is spent either way.
      draft.reset();
    },
    // A refusal means the page drew a gate the Task is no longer at; re-read it so it stops.
    onError: () => {
      utils.task.get.invalidate({ id: taskId });
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
    },
  });

  /**
   * Moving the Task along its lifecycle without going back to the board.
   *
   * The board owns the same mutation, and this is a second call site for it rather than a shared
   * one on purpose: the two disagree about everything except the request. The board spins one
   * card out of dozens and re-reads the dependency graph; here there is one Task, and what has to
   * be re-read is the Task itself, because the header badge and the review gate below are both
   * drawn from it.
   */
  const move = trpc.task.move.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
    },
  });
  /**
   * The completion gate, from the page the run is happening on.
   *
   * A mutation of its own rather than `move`, for the reason the board gives: moving is a
   * gesture the state machine may refuse, and this asserts the work is ready to judge — refused
   * server-side when the harness has not said so.
   */
  const submitForReview = trpc.task.submitForReview.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
    },
  });
  /**
   * Starting the harness, from the same arrow that would otherwise only have written the state.
   *
   * `task.move` into `running` is accepted by the server — the transition is legal — and does
   * nothing else: no Session is created and no launch is published. The Task page has no Launch
   * button of its own, so the forward arrow on a Ready Task is the obvious way to begin a run
   * here, and a bare move would leave a Task that reads as Running with no harness behind it,
   * holding one of the Harness Profile's concurrency slots and with no way back — `running` has no
   * legal retreat, and `task.launch` refuses a Task that is no longer Ready.
   */
  const launch = trpc.task.launch.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      utils.session.listForTask.invalidate({ taskId });
    },
  });
  /**
   * Starting again after a failure, from the page that shows the failure.
   *
   * The board's rule, not a new one: `task.retry` opens a fresh Session and re-enqueues the run
   * (`startTaskRun`), so the Session list has to be re-read as well as the Task — the terminal
   * would otherwise keep showing the failed run's log under a badge that says Running.
   */
  const retry = trpc.task.retry.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      utils.session.listForTask.invalidate({ taskId });
    },
  });
  /**
   * Which Secret a credential-expired Task's "Renew" should open (spec AC-013, issue #63), the
   * way the board finds it. Both lists are fetched only when there is a Renew to point somewhere:
   * every other Task pays nothing for a control it will never show.
   */
  const credentialExpired = task.data?.failureReason === CREDENTIAL_EXPIRED_REASON;
  const harnessProfiles = trpc.profile.agent.list.useQuery(
    { ...WHOLE_PAGE },
    { enabled: credentialExpired },
  );
  const secrets = trpc.secret.list.useQuery({}, { enabled: credentialExpired });
  const renewHref = useMemo(() => {
    if (!credentialExpired) return null;
    const profile = harnessProfiles.data?.items.find((p) => p.id === task.data?.agentProfileId);
    const secret = secrets.data?.find((s) => s.id === profile?.secretId);
    return `${settingsHref("secrets")}&renewSecret=${encodeURIComponent(secret?.name ?? "")}`;
  }, [credentialExpired, harnessProfiles.data, secrets.data, task.data?.agentProfileId]);
  // What holds this Task back, and what it holds back (issue #6). Above the guards: hooks.
  const dependencies = useTaskDependencies(taskId);
  const blockedBy = useBlockedByEditor(task.data ?? null, dependencies.blockedBy);
  const [pendingMove, setPendingMove] = useState<TaskState | null>(null);
  // The forward arrow on a Ready Task asks which Workflow first, when there is one (spec F03).
  const workflowChoices = useWorkflowChoices();
  const [launching, setLaunching] = useState<TaskDto | null>(null);

  /**
   * Every group this one decision covers (issue #70).
   *
   * Built from the Task's attachments joined to the captured diffs, not from the diffs alone: a
   * Task attached to three repositories routinely reaches the gate having changed one, and
   * approving still records a branch for the other two. A reviewer shown only the changed
   * repository would be wrong about what they had just approved — which is the whole of "one
   * decision, all consequences visible".
   *
   * Above the guards below because these are hooks, for the same reason `rows` is.
   */
  const repositoryNames = trpc.repository.list.useQuery({ ...WHOLE_PAGE });
  const nameFor = useCallback(
    (repositoryId: string) =>
      repositoryNames.data?.items.find((r) => r.id === repositoryId)?.name ?? null,
    [repositoryNames.data],
  );
  const capturedDiffs = detail.data?.diffs ?? NO_DIFFS;
  const attachments = task.data?.repositories ?? NO_ATTACHMENTS;
  /**
   * Which review round the Changes tab shows (F10 FR-7).
   *
   * The latest by default. A pick is remembered with the count it was made against, so it holds
   * while the reviewer walks back through the history and lets go the moment a new round lands —
   * a reviewer left staring at round 1 while round 3 waits for them is the failure this avoids.
   */
  const rounds = detail.data?.rounds ?? NO_ROUNDS;
  const [roundPick, setRoundPick] = useState<{ index: number; of: number } | null>(null);
  const latestRound = rounds[rounds.length - 1]?.index ?? 0;
  const selectedRound =
    roundPick && roundPick.of === rounds.length && rounds.some((r) => r.index === roundPick.index)
      ? roundPick.index
      : latestRound;
  const shownRound = rounds.find((r) => r.index === selectedRound) ?? null;
  /**
   * The reviewer's own state on the latest round: which files they have read (and, next, what
   * they mean to say). Against `latest`, not `viewing` — a draft is only ever written for the
   * round the gate would act on, and an older round or launch is read, not reviewed.
   */
  const draft = useReviewDraft(taskId, latest?.id ?? null, latestRound);
  // The latest round's decisions only — see `gateDecisions` for why not the whole Session's.
  const gateDecisionList = useMemo(
    () => gateDecisions(decisions, facts.origin, latest?.id ?? null, rounds),
    [decisions, facts, latest?.id, rounds],
  );
  const gateDecisionIds = useMemo(
    () => new Set(gateDecisionList.map((w) => w.id)),
    [gateDecisionList],
  );
  const decisionsPending = gateDecisionList.filter(
    (w) => !draft.draft.decisions.some((d) => d.id === w.id),
  ).length;
  const viewedCount = useMemo(() => {
    let n = 0;
    for (const diff of capturedDiffs) {
      for (const file of diff.files) {
        if (
          draft.viewed.has(
            draftFileKey({ repositoryId: diff.repositoryId ?? null, path: file.path }),
          )
        )
          n += 1;
      }
    }
    return n;
  }, [capturedDiffs, draft.viewed]);
  // What is there to read: a tool's output is listed but is nobody's to tick off.
  const fileCount = capturedDiffs.reduce(
    (n, d) => n + d.files.filter((f) => !isGeneratedPath(f.path)).length,
    0,
  );
  /**
   * The three edits the editor can make to the draft's notes, closed over the draft so the
   * panel below never holds a note list of its own. Identity by value — a note is where it is
   * and what it says — because the draft is a plain array that a reload re-reads from the server.
   */
  const noteEdits = useMemo(
    () => ({
      onAddNote: (file: ReviewDraftFile, anchor: LineAnchor, text: string) =>
        draft.setNotes([...draft.draft.notes, { ...file, ...anchor, text }]),
      onEditNote: (note: ReviewNote, text: string) =>
        draft.setNotes(draft.draft.notes.map((n) => (n === note ? { ...n, text } : n))),
      onRemoveNote: (note: ReviewNote) =>
        draft.setNotes(draft.draft.notes.filter((n) => n !== note)),
    }),
    [draft.setNotes, draft.draft.notes],
  );
  const reviewGroups = useMemo(
    () => groupChanges(capturedDiffs, attachments, nameFor),
    [capturedDiffs, attachments, nameFor],
  );

  if (task.isLoading) {
    return <WorkspaceSkeleton />;
  }
  if (task.error || !task.data) {
    // A page that could not load still has somewhere to go: the way back is the one action
    // every failure here has to offer, or the operator is left with a sentence and no exit.
    return (
      <div className="flex flex-col items-start gap-3 p-6" role="alert">
        <p className="flex items-center gap-2 text-feedback-error text-sm">
          <TriangleAlert className="size-4 shrink-0" aria-hidden />
          {task.error ? taskActionMessage(task.error.message) : "This task could not be found."}
        </p>
        <p className="text-muted-foreground text-sm">
          It may have been deleted, or the link may be stale.
        </p>
        <Button asChild variant="outline" size="sm">
          <Link href="/board">
            <ArrowLeft /> Back to the board
          </Link>
        </Button>
      </div>
    );
  }

  const t = task.data;
  // Steering only makes sense while a harness is actually working; once the Task is in review
  // the way to ask for more is "request changes", which is recorded (Principle I).
  const canSteer = isRunning && live.status === "open";
  // The primary attachment's branch (issue #7). The header has room for one line, so it names
  // the repository the harness actually ran in; the Changes tab is where every repository's own
  // branch and change is shown.
  const primary = t.repositories.length > 0 ? primaryTaskRepository(t.repositories) : null;
  const branch = primary?.resultBranch ?? latest?.diffRef ?? null;
  // The gate's scope is always the latest capture; the tab may be showing an older round.
  const diffs = shownRound && shownRound.index !== latestRound ? shownRound.diffs : capturedDiffs;
  // The board, whatever the state: the gate is a node on it (see `TaskBoard`).
  const autoTab: WorkspaceTab = "board";
  // A pick from the URL has no state yet: it holds until the first state change after arrival.
  const tab =
    tabPick && (tabPick.state === null || tabPick.state === t.state) ? tabPick.tab : autoTab;
  const pickTab = (next: WorkspaceTab) => {
    setTabPick({ tab: next, state: t.state });
    setUrlTab(next);
  };
  /**
   * The gate's footer — Approve, Retry, Launch, Open review — said once on the page: in the gate
   * dialog, which the gate card on the board and the strip under the brief and the change both
   * open. One copy, so there is one control of each name on the page and one remark box bound to
   * the draft. It never points at a question the harness is stopped on (`waiting`): that question
   * is a card on the board, answered from its own dialog.
   */
  const gateShown =
    deleted === null && (t.state !== "running" || canOpenReview(t) || t.completedAt !== null);
  const renderFooter = () =>
    deleted !== null ? null : (
      <TaskFooter
        layout="stack"
        task={t}
        outstanding={dependencies.outstanding}
        // Never "0 files" for a change that has not arrived yet: the capture is large and slow.
        consequences={
          detail.isPending ? "the change (still loading)" : summariseConsequences(reviewGroups)
        }
        viewed={
          t.state === "review" && fileCount > 0 ? { viewed: viewedCount, of: fileCount } : null
        }
        openItems={openItems}
        decisionsPending={decisionsPending}
        decisionsToApply={t.workflowId ? gateDecisionList.length : 0}
        waiting={null}
        notes={{
          count: draft.draft.notes.length,
          general: draft.draft.general,
          onGeneral: draft.setGeneral,
        }}
        decidePending={decide.isPending ? (decide.variables?.decision ?? null) : null}
        decisionSent={
          sent && sent.sessionId === latest?.id && sent.mark === gateMark(t) ? sent.decision : null
        }
        onDecide={runDecision}
        onSettleDecisions={goToDecisions}
        onDismissError={() => {
          retry.reset();
          decide.reset();
        }}
        onLaunch={() => requestMove("running")}
        onRetry={() => retry.mutate({ id: t.id })}
        onOpenReview={() => submitForReview.mutate({ id: t.id })}
        onReopen={() => requestMove("ready")}
        nextStepName={nextStepName}
        criteria={
          latest && (briefCriteria ?? 0) > 0
            ? { verified: draft.draft.verified.length, of: briefCriteria ?? 0 }
            : null
        }
        onOpenChanges={() => {
          setOpened(null);
          pickTab("changes");
        }}
        onOpenBrief={() => {
          setOpened(null);
          pickTab("brief");
        }}
        openReviewPending={submitForReview.isPending}
        actionPending={move.isPending || launch.isPending || retry.isPending}
        renewHref={renewHref}
        error={footerMessage}
      />
    );

  const columns = boardColumns({
    stepped: scope.stepped,
    state: t.state,
    home: scope.selected,
    facts,
    rows,
    showGate: gateShown,
    history: stepHistory,
  });
  const tally = boardTally(columns);
  const everyItem = columns.flatMap((column) => column.items);
  const openAsks = everyItem.filter((item) => needsYou(item, t.state));
  /**
   * What Follow live pans to: the newest thing waiting on a person, else the newest card under
   * the Step the run is on. A todo ticking is not news; a question arriving is.
   */
  const currentColumn = columns.find((column) => column.current);
  const latestKey = openAsks.at(-1)?.key ?? currentColumn?.items.at(-1)?.key ?? null;
  const gateItem = everyItem.find((item) => item.kind === "gate");
  // The Step an approval hands on to — what "Approve" says it will do. Null on the last Step, and
  // on a Task with no Workflow, where approving finishes the Task.
  const gateAt = columns.findIndex((c) => c.items.some((i) => i.kind === "gate"));
  const nextStepName = scope.stepped.length > 0 ? (columns[gateAt + 1]?.name ?? null) : null;
  const gateColumn = columns.find((column) => column.items.some((item) => item.kind === "gate"));
  const lines = gateLines(t, {
    decisionsPending,
    openItems: openItems.length,
    files: fileCount,
    outstanding: dependencies.outstanding.length,
  });

  /**
   * Approve pressed with decisions still unsettled: rather than a greyed button and a sentence
   * about somewhere else, the dialog of the Step's decisions opens in place of the gate's, with
   * the focus on the first one still open — the blocker itself, where it is answered.
   */
  const goToDecisions = () => {
    const group = everyItem.find(
      (item) =>
        item.kind === "decisions" &&
        item.widgets.some(
          (w) => gateDecisionIds.has(w.id) && !draft.draft.decisions.some((d) => d.id === w.id),
        ),
    );
    if (group) setOpened({ type: "item", key: group.key });
  };
  /**
   * "Chat about it" on a decision: the dialog gives way to the terminal, which mounts the Task's
   * conversation, and the decision's first line is typed there for the person to finish.
   */
  const chatAbout = (widget: DecisionWidget) => {
    const picked = widget.options.find((o) => o.id === widget.chosen)?.label;
    setOpened(null);
    setTerminalOpen(true);
    setTerminalInject({
      id: Date.now(),
      text: `About your decision "${widget.question}"${picked ? ` — you picked "${picked}"` : ""}: `,
    });
  };
  const revealOnBoard = (item: BoardItem | undefined) => {
    if (!item) return;
    pickTab("board");
    requestAnimationFrame(() => board.current?.reveal(item.key));
  };
  const openGate = () => {
    if (gateItem) setOpened({ type: "item", key: gateItem.key });
  };
  /**
   * A plan with unfinished items, on the Step at the gate, while that Step has decisions for the
   * reviewer: the unfinished items are what the decisions settle. Said in the plan's dialog,
   * because that dialog is read-only and a reviewer who opens it to "fix" a red item otherwise
   * finds nothing to press.
   */
  const planWaitsOnYou = (column: BoardColumn, widget: { steps: { state: string }[] }) =>
    t.state === "review" &&
    deleted === null &&
    column === gateColumn &&
    gateDecisionList.length > 0 &&
    widget.steps.some((step) => step.state !== "done");
  const gateStrip =
    gateItem && gateColumn ? (
      <GateStrip
        title={gateTitle(t.state, gateColumn.name)}
        lines={lines}
        attention={needsYou(gateItem, t.state)}
        onOpen={openGate}
      />
    ) : null;

  /**
   * The open card's dialog, read from the board as it is now. Each closes itself once there is
   * nothing left in it to do — an answered permission, the last open question — and a card that
   * is gone (a gate the Task moved past) closes it by not being found.
   */
  const close = () => setOpened(null);
  const boardDialog = (): ReactNode => {
    if (!opened) return null;
    if (opened.type === "step") {
      const index = columns.findIndex((column) => column.id === opened.id);
      const column = columns[index];
      if (!column) return null;
      const step = scope.stepped.find((s) => s.step.id === column.id)?.step ?? null;
      return (
        <BoardDialog
          key={`step:${column.id}`}
          container={root}
          onClose={close}
          title={`Step · ${column.name}`}
          description={
            step
              ? `Step ${index + 1} of ${columns.length} of this task's workflow.`
              : "This task's run."
          }
        >
          <StepBody
            column={column}
            step={step}
            position={index + 1}
            total={columns.length}
            workflowId={t.workflowId}
            state={t.state}
            onShowOnBoard={() => {
              if (step) scope.select(step.id);
              close();
            }}
            forced={forcedReview.includes(column.id)}
            onForceReview={(force) => forceReview.mutate({ taskId, stepId: column.id, force })}
          />
        </BoardDialog>
      );
    }
    const column = columns.find((c) => c.items.some((item) => item.key === opened.key));
    const item = column?.items.find((i) => i.key === opened.key);
    if (!column || !item) return null;
    const common = { container: root, onClose: close };
    switch (item.kind) {
      case "plan":
        return (
          <BoardDialog
            key={item.key}
            {...common}
            title={item.widget.title ?? "The harness's plan"}
            description={`The plan the harness published on ${column.name}, as it now stands.`}
            footer={
              planWaitsOnYou(column, item.widget) ? (
                decisionsPending > 0 ? (
                  <Button onClick={goToDecisions}>Answer the decisions</Button>
                ) : (
                  <Button onClick={openGate}>Go to the gate</Button>
                )
              ) : null
            }
          >
            <PlanBody widget={item.widget} />
            {planWaitsOnYou(column, item.widget) ? (
              <p className="mt-3 rounded-lg border-state-review/40 border-l-2 bg-state-review/[0.06] px-3 py-2 text-sm leading-relaxed">
                This is the harness's own checklist — nothing here is yours to tick. What is left
                waits on your {gateDecisionList.length === 1 ? "decision" : "decisions"}
                {decisionsPending > 0
                  ? `: answer ${decisionsPending === 1 ? "it" : "them"}, then approve.`
                  : ", which you have confirmed."}{" "}
                Approving sends your answers back to {column.name}, and the harness settles these
                items before the workflow moves on.
              </p>
            ) : null}
          </BoardDialog>
        );
      case "todos":
        return (
          <BoardDialog
            key={item.key}
            {...common}
            title="Todo list"
            description="The harness's own list. It rewrites it as it works; nothing here is yours to tick."
          >
            <TodosBody items={item.items} />
          </BoardDialog>
        );
      case "decisions": {
        const confirming =
          t.state === "review" &&
          deleted === null &&
          item.widgets.some((w) => gateDecisionIds.has(w.id));
        const settled = item.widgets.filter((w) =>
          draft.draft.decisions.some((d) => d.id === w.id),
        ).length;
        return (
          <BoardDialog
            key={item.key}
            {...common}
            size="xl"
            title={
              item.widgets.length === 1
                ? "A decision the harness made"
                : `${item.widgets.length} decisions the harness made`
            }
            description={
              confirming
                ? `${settled} of ${item.widgets.length} confirmed. Pick an answer for each — the harness's pick is marked, not taken. On approval, the harness applies your answers to this step before the workflow moves on.`
                : "The harness decided these while it worked. You confirm or overturn them at the step's gate."
            }
            onOpenAutoFocus={focusFirstUnsettled}
            footer={
              confirming && gateItem ? (
                <Button
                  variant={settled === item.widgets.length ? "default" : "outline"}
                  onClick={openGate}
                >
                  Back to the gate
                </Button>
              ) : null
            }
          >
            <DecisionsBody
              widgets={item.widgets}
              answers={draft.draft.decisions}
              onAnswer={draft.setDecision}
              confirming={confirming}
              sessionId={latest?.id ?? null}
              onChat={chatAbout}
            />
          </BoardDialog>
        );
      }
      case "permission":
        return (
          <BoardDialog
            key={item.key}
            {...common}
            title={item.row.title}
            description={
              item.row.resolution
                ? "What was asked, and how it was answered."
                : "The harness is stopped until this is answered."
            }
          >
            <PermissionBody
              row={item.row}
              onRespond={
                isRunning
                  ? (optionId) => {
                      live.respondPermission(item.row.requestId, optionId);
                      close();
                    }
                  : undefined
              }
            />
          </BoardDialog>
        );
      case "asks":
        return (
          <BoardDialog
            key={item.key}
            {...common}
            size="xl"
            title={asksTitle(item.rows)}
            description={
              isRunning
                ? "The harness asked these while it worked. An answer goes to it straight away."
                : "What the harness asked, and what it was told."
            }
          >
            <AsksBody
              rows={item.rows}
              onRespond={
                isRunning
                  ? (widgetId, values, text) => {
                      live.respondWidget(widgetId, values, text);
                      const left = item.rows.filter(
                        (r) => r.response === null && r.widgetId !== widgetId,
                      );
                      if (left.length === 0) close();
                    }
                  : undefined
              }
            />
          </BoardDialog>
        );
      case "gate": {
        // Said as the decision it is: which step, of how many, and what the reviewer is to do.
        const at = columns.findIndex((c) => c.id === column.id);
        const stepped = scope.stepped.length > 0;
        return (
          <BoardDialog
            key={item.key}
            {...common}
            size={t.state === "review" ? "lg" : "md"}
            title={
              t.state === "review"
                ? stepped
                  ? `Decide on step ${at + 1} of ${columns.length}: ${column.name}`
                  : "Decide on this task's work"
                : gateTitle(t.state, column.name)
            }
            description={
              t.state === "review"
                ? "The harness has finished. Check what it did, then choose what happens next."
                : lines.headline
            }
          >
            {/* The footer brings its own rule and padding; inside the dialog the frame is the dialog's. */}
            <div className="-mx-4 [&>[data-task-footer]]:border-t-0 [&>[data-task-footer]]:bg-transparent">
              {renderFooter()}
            </div>
          </BoardDialog>
        );
      }
    }
  };
  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (!latest?.id) return;
    // The notes and remark go with a request for changes and nowhere else (F10 FR-7): an
    // approval has nothing to say to a harness that is done, and a rejection discards the work
    // the notes were about. Decisions the reviewer settled on the board are the exception —
    // on an approval they go back to this Step's harness, which applies them before the Workflow
    // moves on (and then into the next Step's handoff); on a request for changes they join the
    // notes. Omitted, not empty, when there is nothing — the orchestrator has its own
    // sentence for "the reviewer left no notes".
    const settled = collateDecisions(gateDecisionList, draft.draft.decisions);
    const feedback =
      decision === "request_changes"
        ? joinFeedback(
            collateFeedback(draft.draft, (id) => (id ? nameFor(id) : null)),
            settled,
          )
        : decision === "approve"
          ? settled
          : undefined;
    const mark = gateMark(t);
    const sessionId = latest.id;
    decide.mutate(
      { sessionId, decision, ...(feedback ? { feedback } : {}) },
      { onSuccess: () => setSent({ sessionId, decision, mark }) },
    );
  };
  // Refusals from the foot of the page, through the same mapping as the banner above: a wire
  // code is never the sentence an operator reads.
  const footerMessage = taskActionMessage(retry.error?.message ?? decide.error?.message);

  /**
   * One step along the lifecycle, from the arrows beside the state badge.
   *
   * Two of the steps are not the plain state write they look like. Starting a Ready Task is a
   * launch, and goes through the mutation that actually creates a Session. Leaving Review throws
   * something away — the harness's proposed changes are abandoned and no review decision is
   * recorded — so it asks first, in the words the board asks in (TASK-022) when the move is
   * backwards, and in its own words for Done, where the thing being lost is the commit.
   */
  const requestMove = (to: TaskState) => {
    if (to === "running" && t.state === "ready") {
      if (workflowChoices.available) setLaunching(t);
      else launch.mutate({ id: t.id });
      return;
    }
    if (t.state === "review") {
      setPendingMove(to);
      return;
    }
    move.mutate({ id: t.id, to });
  };

  // Every server refusal arrives as a wire code, so none of them may reach the banner as-is —
  // `taskActionMessage` owns the whole mapping, the same one the board's banner reads through.
  const moveMessage = taskActionMessage(move.error?.message ?? launch.error?.message);

  const submitInput = () => {
    const text = input.trim();
    if (!text || !isRunning) return;
    setAck(null);
    // Straight through when there is a stream to send on; held for it otherwise.
    if (canSteer && live.sendInput(text)) {
      setInput("");
      return;
    }
    setQueued(text);
    setInput("");
  };

  return (
    // The root is a row: the page, and the terminal at its right edge, full height — beside the
    // Task's header as well as the board, the way an editor's side panel sits.
    <div ref={setRoot} className="relative flex h-full">
      <div className="flex min-w-0 flex-1 flex-col">
        {/*
        Leaving Review, asked in the terms of the direction being taken.

        Backwards is the board's own question, in the board's words (TASK-022): an operator who
        learned what it means there should not have to learn it again here. Forwards is a
        different act and cannot borrow that wording — pointing someone who just pressed "Move to
        Done" at Reject describes the opposite of what they asked for. What Done actually skips is
        the approve step: `task.move` writes the state and nothing else, so the harness's branch is
        never committed and the run is left waiting at a gate no decision ever reaches.
      */}
        {blockedBy.dialogs}
        <LaunchTaskDialog
          task={launching}
          onOpenChange={(open) => {
            if (!open) setLaunching(null);
          }}
          onLaunch={(task) => launch.mutate({ id: task.id })}
        />
        <ConfirmDialog
          open={pendingMove !== null}
          onOpenChange={(open) => {
            if (!open) setPendingMove(null);
          }}
          title={
            pendingMove === "done"
              ? "Mark this task done without approving?"
              : "Move this task out of review?"
          }
          description={
            pendingMove === "done"
              ? "No review decision is recorded and nothing is committed — the harness's changes stay on their branch and the task cannot be moved again. To accept the work and commit it, use Approve below."
              : "The harness's proposed changes are left behind and no review decision is recorded. To reject the work properly, and keep the audit trail, use Reject below."
          }
          confirmLabel="Move it anyway"
          onConfirm={() => {
            if (pendingMove) move.mutate({ id: t.id, to: pendingMove });
            setPendingMove(null);
          }}
        />

        {/*
        Evidence and dossier. The header names the Task and its state in one 44px line; the
        main column is the evidence — the run, the brief, the plan, the change — as four tabs
        that fill the height; the rail beside it is everything that is true *about* the Task
        (its outcome and the harness's own summary, where it is in its Workflow, its branch, what
        it waits on, which harness ran it) with the decision pinned at the foot, next to what is
        being decided on. Roughly 62/38 at 1600px, which is the split the evidence deserves.
        Below `lg` the rail stacks under the evidence and keeps its own scroll.
      */}
        <header className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          {/* No back arrow: the breadcrumb above already reads Projects › Project › Board › this
              Task, every crumb a link, so a third way back on one screen was one too many. */}
          {/* Where a sub-task was split from, as the crumbs before its title (issue #56): a
            sub-task's title on its own is often meaningless without them. */}
          {t.parentTaskId ? <ParentChain parentTaskId={t.parentTaskId} /> : null}
          {/* The one thing on the page that says what you are looking at — the Title step. */}
          <h1 className="min-w-0 truncate font-semibold text-base">{t.title}</h1>
          <TaskStateBadge state={t.state} size="sm" />
          {t.failureReason &&
          (t.state === "review" || t.state === "failed" || t.state === "parked") ? (
            <FailureChip reason={t.failureReason} state={t.state} />
          ) : null}
          {/* Beside the badge: the arrows change exactly the thing the badge shows. */}
          {deleted === null ? (
            <TaskAdvance
              state={t.state}
              onMove={requestMove}
              pending={move.isPending || launch.isPending}
            />
          ) : null}
          {/* Where the run is in its Workflow — its name and Step, past a hairline from the title
              group. Nothing at all for a Task on no Workflow. */}
          {scope.binding ? (
            <>
              <span aria-hidden className="mx-1 h-4 w-px shrink-0 bg-border" />
              <div className="min-w-0 flex-1">
                <WorkflowPosition scope={scope} />
              </div>
            </>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Deleting the Task the page is *about* leaves nowhere to stand, so it navigates
              back to the board. Past a hairline, so it is never a graze from a reading control. */}
            {deleted !== null ? null : (
              <DeleteTaskAction
                onDeleted={() => router.push(back.href)}
                taskId={t.id}
                taskTitle={t.title}
                trigger={(press, busy) => (
                  <Button
                    aria-label={`Delete ${t.title}`}
                    className="text-muted-foreground hover:text-destructive"
                    onClick={press}
                    loading={busy}
                    size="icon-sm"
                    variant="ghost"
                  >
                    {busy ? null : <Trash2 />}
                  </Button>
                )}
              />
            )}
          </div>
        </header>

        <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
          {/*
          The left pane: the terminal's switch, the gate's, what is on the board, and the
          dossier — everything true *about* the Task (how it ended, its branch, where the run
          went, what it waits on, which harness ran it). The decision itself is in the gate's
          dialog, which this, the gate card and the strip under the evidence all open.
        */}
          <aside
            aria-label="About this task"
            className="flex max-h-[40vh] shrink-0 flex-col border-b lg:max-h-none lg:w-60 lg:border-r lg:border-b-0 2xl:w-64"
          >
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-2 px-3 pt-3">
                <Button
                  ref={terminalButton}
                  variant={terminalOpen ? "default" : "outline"}
                  className="w-full justify-start font-mono"
                  aria-expanded={terminalOpen}
                  aria-controls={TERMINAL_PANE_ID}
                  onClick={() => setTerminalOpen((was) => !was)}
                  // A Task in History is read, not worked on: no shell in its worktree.
                  disabled={deleted !== null}
                >
                  <SquareTerminal aria-hidden /> Terminal
                </Button>
                <div className="flex justify-center">
                  <StreamIndicator status={live.status} />
                </div>
                {/*
                  The gate, from wherever the board has been panned to: its card is at the foot
                  of a Step and can be off screen; this is the same dialog, always in reach.
                */}
                {gateItem && gateColumn ? (
                  <button
                    type="button"
                    aria-haspopup="dialog"
                    onClick={openGate}
                    data-gate-open
                    className={cn(
                      "flex w-full flex-col gap-0.5 rounded-lg border-2 px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      needsYou(gateItem, t.state)
                        ? "border-state-review/70 bg-state-review/[0.06] hover:bg-state-review/[0.12]"
                        : "hover:bg-accent/50",
                    )}
                  >
                    <span
                      className={cn(
                        "flex items-center gap-1.5 font-medium text-2xs uppercase tracking-[0.14em]",
                        needsYou(gateItem, t.state) ? "text-state-review" : "text-muted-foreground",
                      )}
                    >
                      <span className="sr-only">Open the gate: </span>
                      <DecisionMark filled={needsYou(gateItem, t.state)} />
                      {gateTitle(t.state, gateColumn.name)}
                    </span>
                    <span className="line-clamp-2 text-muted-foreground text-xs">
                      {lines.detail}
                    </span>
                  </button>
                ) : null}
              </div>
              <BoardLegend
                tally={tally}
                needsYou={openAsks.length}
                files={fileCount}
                onReveal={(kind) =>
                  revealOnBoard(
                    kind === "needs" ? openAsks[0] : everyItem.find((item) => item.kind === kind),
                  )
                }
                onFiles={() => pickTab("changes")}
              />
              <div className="divide-y border-t">
                <RailSection title="Status">
                  {t.completedAt ? (
                    <div className="space-y-2">
                      <CompletionBadge outcome={t.completedOutcome} />
                      {t.completedSummary ? (
                        // The harness's own report — the most useful sentences on the page.
                        <p
                          className="text-foreground/90 text-xs leading-relaxed"
                          data-completed-summary
                        >
                          {t.completedSummary}
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="text-muted-foreground text-xs">{STATE_SENTENCE[t.state]}</p>
                  )}
                  {/* The reason's sentence lives in the decision card beside Retry; it is said
                  here only for a Task in History, which has no card. */}
                  {t.failureReason && deleted !== null ? (
                    <p className="text-muted-foreground text-xs">
                      {failureReasonLabel(t.failureReason)?.detail ?? null}
                    </p>
                  ) : null}
                </RailSection>

                <RailSection title="Repository">
                  <p className="flex items-center gap-1.5 font-mono text-xs">
                    <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="min-w-0 truncate">
                      {branch ?? `base ${primary?.baseRef ?? "HEAD"}`}
                    </span>
                    {branch ? <CopyBranch branch={branch} /> : null}
                  </p>
                  {t.repositories.length > 1 ? (
                    <TaskRepositories task={t} />
                  ) : primary ? (
                    <p className="text-muted-foreground text-xs">
                      from {primary.baseRef ?? "HEAD"}
                    </p>
                  ) : null}
                </RailSection>

                {/* Where the run went outside this app, beneath the branch it went there from.
                Never hidden when empty: "it opened nothing" is an answer a reviewer needs
                before going to look for a merge request that was never created. */}
                <RailSection title="Links">
                  <RunLinks links={detail.data?.links ?? []} />
                </RailSection>

                <RailSection
                  title="Dependencies"
                  action={deleted === null ? blockedBy.button : undefined}
                >
                  {dependencies.blockedBy.length === 0 && dependencies.blocks.length === 0 ? (
                    <p className="text-muted-foreground text-xs">
                      Waits on nothing; blocks nothing.
                    </p>
                  ) : (
                    <TaskDependencies
                      blockedBy={dependencies.blockedBy}
                      blocks={dependencies.blocks}
                    />
                  )}
                </RailSection>

                {/* Beside Dependencies because it is the same kind of fact — how this Task relates
                to others — and splitting is decided while reading a run that has outgrown
                itself, not back on the board (issue #56). */}
                <RailSection
                  title="Sub-tasks"
                  action={
                    deleted === null ? (
                      <SplitTaskButton hasTranscript={latest !== undefined} task={t} />
                    ) : undefined
                  }
                >
                  <SubtaskList task={t} />
                </RailSection>

                <RailSection title="Run">
                  <TaskMetaList task={t} session={latest ?? null} />
                </RailSection>
              </div>
            </ScrollArea>
          </aside>

          {/* The board, or the evidence the gate is decided on. */}
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {deleted !== null ? (
              /*
            In History (Decision 0025). Said at the top, in the caution tone rather than the
            failed one — nothing went wrong, the Owner did this — with the one control that
            changes it. Everything below stays readable: the transcript, the change, the rounds
            are the record this window exists to keep.
          */
              <div
                className="mx-4 mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-feedback-caution/40 bg-feedback-caution/10 px-3 py-2 text-sm"
                role="status"
                data-task-deleted
              >
                <ArchiveRestore aria-hidden className="size-4 shrink-0 text-feedback-caution" />
                <span className="min-w-0 flex-1">
                  Deleted {relativeAge(deleted)} — in History until{" "}
                  {relativeUntil(retentionExpiresAt(deleted))}
                  {withinRetention(deleted) ? ", then purged with its sessions and worktree." : "."}
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  loading={restore.isPending}
                  disabled={!withinRetention(deleted)}
                  onClick={() => restore.mutate({ id: t.id })}
                >
                  <ArchiveRestore /> Restore
                </Button>
                {restore.error ? (
                  <span className="text-feedback-error text-xs" role="alert">
                    {taskActionMessage(restore.error.message)}
                  </span>
                ) : null}
              </div>
            ) : null}

            {moveMessage ? (
              /*
            A refusal, in the feedback family (not the lifecycle one — Failed red is the Task's
            colour, and this is the server's). Closable: an alert nobody can dismiss is one that
            gets read around.
          */
              <div
                className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-feedback-error/30 bg-feedback-error/10 px-3 py-2 text-feedback-error text-sm"
                role="alert"
              >
                <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 flex-1">{moveMessage}</span>
                <Button
                  aria-label="Dismiss"
                  size="icon-xs"
                  variant="ghost"
                  className="text-feedback-error hover:text-feedback-error"
                  onClick={() => {
                    move.reset();
                    launch.reset();
                  }}
                >
                  <X />
                </Button>
              </div>
            ) : null}

            <Tabs
              value={tab}
              onValueChange={(next) => pickTab(next as WorkspaceTab)}
              // Manual, like the Step strip: arrowing across the views should not switch them.
              activationMode="manual"
              className="min-h-0 flex-1 gap-0"
            >
              <TabsList variant="line" size="lg" aria-label="Task" className="w-full border-b px-4">
                {/*
                Every count is what is left for *you*, on the round the gate is about: decisions not
                settled, criteria not verified, files not viewed. Nothing at all outside Review,
                where none of them is anyone's to do.
              */}
                <TabsTrigger
                  value="board"
                  count={t.state === "review" ? decisionsPending : 0}
                  countLabel="decisions still to settle"
                >
                  Board
                </TabsTrigger>
                <TabsTrigger
                  value="brief"
                  count={
                    t.state === "review" && latest
                      ? Math.max(0, (briefCriteria ?? 0) - draft.draft.verified.length)
                      : 0
                  }
                  countLabel="criteria still to verify"
                >
                  Brief
                </TabsTrigger>
                <TabsTrigger
                  value="changes"
                  count={t.state === "review" ? Math.max(0, fileCount - viewedCount) : 0}
                  countLabel="files not yet viewed"
                >
                  Changes
                </TabsTrigger>
              </TabsList>

              {/* All three stay mounted: the board holds its viewport, the Changes panel its file. */}
              <TabsContent value="board" keepMounted className="flex min-h-0 flex-col">
                {/*
                  The board is what the Workflow strip's tabs scope — the cards are read for the
                  Step picked — so it is that strip's panel as well as this tab's.
                */}
                <div ref={boardPanel} tabIndex={-1} className="min-h-0 flex-1 outline-none">
                  <TaskBoard
                    handle={board}
                    label={`Board for ${t.title}`}
                    columns={columns}
                    state={t.state}
                    live={isRunning && live.status === "open"}
                    latestKey={latestKey}
                    onOpenStep={(id) => setOpened({ type: "step", id })}
                    forcedReview={forcedReview}
                    {...(scope.binding && deleted === null
                      ? {
                          onForceReview: (stepId: string, force: boolean) =>
                            forceReview.mutate({ taskId, stepId, force }),
                        }
                      : {})}
                    renderItem={(item, column) =>
                      renderBoardItem(item, column, {
                        state: t.state,
                        fresh: (key) => key === latestKey && isRunning,
                        answerable: isRunning,
                        answers: draft.draft.decisions,
                        confirming: t.state === "review" && deleted === null,
                        gateDecisionIds,
                        gate: lines,
                        open: (key) => setOpened({ type: "item", key }),
                      })
                    }
                  />
                </div>
                {/*
                  Steering the headless run: a message to the harness, and the held Stop. Only
                  while there is a run to reach — the shell in the terminal is a different
                  process and cannot.
                */}
                {isRunning || queued !== null || stopQueued ? (
                  <HarnessComposer
                    value={input}
                    onChange={setInput}
                    onSubmit={submitInput}
                    onStop={() => {
                      setAck(null);
                      live.stopHarness();
                    }}
                    canSteer={canSteer}
                    isRunning={isRunning}
                    queued={queued}
                    onDiscardQueued={() => setQueued(null)}
                    stopQueued={stopQueued}
                    onQueueStop={() => setStopQueued(true)}
                    onDiscardStop={() => setStopQueued(false)}
                    ackError={ack && !ack.ok ? (ack.error ?? "unknown") : null}
                  />
                ) : null}
              </TabsContent>

              <TabsContent value="brief" keepMounted className="flex min-h-0 flex-col">
                {latest ? (
                  <ReviewBriefPanel
                    sessionId={latest.id}
                    openItems={openItems}
                    verified={draft.draft.verified}
                    onToggleVerified={draft.toggleVerified}
                    canVerify={t.state === "review" && deleted === null}
                  />
                ) : (
                  <ReadingPanel>
                    <EmptyPanel
                      label="Nothing to review yet."
                      hint="The brief — the criteria to verify — is drawn up from the first run."
                    />
                  </ReadingPanel>
                )}
                {tab === "brief" ? gateStrip : null}
              </TabsContent>

              <TabsContent value="changes" keepMounted className="flex min-h-0 flex-col">
                <ReadingPanel>
                  <RoundSelector
                    rounds={rounds}
                    selected={selectedRound}
                    onSelect={(index) => setRoundPick({ index, of: rounds.length })}
                    {...(sessions.data && sessions.data.length > 1 && viewing
                      ? {
                          launches: {
                            sessions: sessions.data,
                            selectedId: viewing.id,
                            onSelect: (id: string) => {
                              setSessionPick(id);
                              setRoundPick(null);
                            },
                          },
                        }
                      : {})}
                  />

                  <ChangesPanel
                    diffs={diffs}
                    repositories={attachments}
                    repositoryName={nameFor}
                    /*
                     * The change is read once, when the run reaches its review gate — so before a
                     * Task has ever got there, "no changes" is a claim nobody has checked. A capture
                     * having happened is what `diffs` being non-empty means; a Task past the gate
                     * with genuinely nothing to show is the other case, and `completedAt` is the tell
                     * that the run got far enough to look.
                     */
                    captured={diffs.length > 0 || t.completedAt !== null}
                    // Ticks and notes only while there is a review to draft — the Task at its gate,
                    // on the round the gate is about. An older round, or a Task that is Done or
                    // still Running, is read, not reviewed.
                    {...(t.state === "review" &&
                    (shownRound === null || shownRound.index === latestRound)
                      ? {
                          ticks: {
                            viewed: draft.viewed,
                            onToggle: draft.toggleViewed,
                            notes: draft.draft.notes,
                            ...noteEdits,
                          },
                        }
                      : {})}
                  />
                </ReadingPanel>
                {tab === "changes" ? gateStrip : null}
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </div>

      {/*
        The terminal, opened from the left pane: a real shell in the Task's worktree, at the
        page's right edge and its full height. Mounted from the first open and only hidden after,
        so closing the pane does not hang up the shell; leaving the page does.
      */}
      {terminalStarted.current ? (
        <section
          id={TERMINAL_PANE_ID}
          aria-label="Terminal"
          hidden={!terminalOpen}
          // Beside the page from `md`, at the width the operator dragged it to; over it below,
          // where there is no room for both.
          className="absolute inset-0 z-30 flex flex-col bg-background md:relative md:inset-auto md:z-auto md:w-[var(--terminal-width)] md:shrink-0 md:border-l [&[hidden]]:hidden"
          style={{ "--terminal-width": `${terminalWidth.width}px` } as CSSProperties}
        >
          <TerminalResizer handle={terminalWidth} />
          <div className="flex h-11 shrink-0 items-center gap-2 border-b pr-1.5 pl-3 text-xs">
            <SquareTerminal aria-hidden className="size-3.5 shrink-0" />
            <span className="font-medium">Terminal</span>
            <span className="truncate text-muted-foreground">
              {terminalMode?.mode === "chat"
                ? "· the task's conversation"
                : terminalMode?.mode === "shell"
                  ? "· shell in the worktree"
                  : "· connecting…"}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              aria-label="Close terminal"
              onClick={() => {
                setTerminalOpen(false);
                terminalButton.current?.focus();
              }}
            >
              <X aria-hidden />
            </Button>
          </div>
          <TaskTerminal
            taskId={t.id}
            visible={terminalOpen}
            onMode={setTerminalMode}
            inject={terminalInject}
          />
        </section>
      ) : null}

      {boardDialog()}
    </div>
  );
}

/**
 * What changes on the Task row when a sent decision has been dealt with: the run moves the state,
 * or the reconciler stamps it "Decision not applied". Either ends the gate's hold.
 */
function gateMark(t: Pick<TaskDto, "state" | "failureReason" | "updatedAt">): string {
  return `${t.state}|${t.failureReason ?? ""}|${t.updatedAt}`;
}
