"use client";

import type {
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
import { DEFAULT_TASK_PANE_LAYOUT, type TaskPaneLayout } from "@solow/contracts";
import { primaryTaskRepository } from "@solow/core";
import {
  ArrowLeft,
  CheckCircle2,
  CircleSlash,
  GitBranch,
  OctagonAlert,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { TaskStateBadge } from "@/components/features/board/task-state-badge";
import { ConfirmDialog } from "@/components/features/confirm-action";
import { useBackToProject } from "@/components/features/shared/back-to-project";
import { draftFileKey, useReviewDraft } from "@/components/hooks/use-review-draft";
import { useTaskStream } from "@/components/hooks/use-task-stream";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { settingsHref } from "@/lib/navigation";
import { WHOLE_PAGE } from "@/lib/paged";
import { taskActionMessage } from "@/lib/task-errors";
import { CREDENTIAL_EXPIRED_REASON } from "@/lib/task-states";
import { cn } from "@/lib/utils";
import { trpc } from "@/trpc/react";
import { ChangesPanel } from "./changes-panel";
import { DeleteTaskAction } from "./delete-task-action";
import { HarnessComposer } from "./harness-composer";
import { LaunchTaskDialog, useWorkflowChoices } from "./launch-task-dialog";
import { collateFeedback } from "./review-feedback";
import { groupChanges, summariseConsequences } from "./review-groups";
import type { LineAnchor } from "./review-notes";
import { RoundSelector } from "./round-selector";
import { SplitPane } from "./split-pane";
import { TaskAdvance } from "./task-advance";
import { TaskDependencies, useBlockedByEditor, useTaskDependencies } from "./task-dependencies";
import { TaskFooter } from "./task-footer";
import { TaskMeta } from "./task-meta";
import { type TerminalScope, TerminalView } from "./terminal-view";
import { latestTodos, TodoList } from "./todo-list";
import { buildTranscript, inStepScope } from "./transcript";
import { selectedTabId, TERMINAL_PANEL_ID, useStepScope, WorkflowSteps } from "./workflow-steps";

/**
 * What the harness said about how its run ended, in the header.
 *
 * `changes_ready` reaches this only once the Task has left `running` — before that the same
 * outcome renders as the "Open review" control above.
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
  idle: "text-muted-foreground/60",
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

type RightTab = "changes" | "plan";
const RIGHT_TAB_ID: Record<RightTab, string> = {
  changes: "task-right-tab-changes",
  plan: "task-right-tab-plan",
};
const RIGHT_PANEL_ID: Record<RightTab, string> = {
  changes: "task-right-panel-changes",
  plan: "task-right-panel-plan",
};

/**
 * The right column's tab strip: Changes, Plan.
 *
 * Hand-rolled like the Workflow strip rather than Radix Tabs, because the strip sits in the
 * column's header row and the panels in its body — two slots of `SplitPane`, and a Radix
 * `TabsList` cannot live outside its root. The pattern is the one `workflow-steps.tsx` already
 * uses: `aria-controls` from tab to panel, manual activation, and a count where one helps.
 */
function RightColumnTabs({
  tab,
  onPick,
  files,
  planItems,
}: {
  tab: RightTab;
  onPick: (tab: RightTab) => void;
  files: number;
  planItems: number;
}) {
  const tabs: Array<{ id: RightTab; label: string; count: number; disabled: boolean }> = [
    { id: "changes", label: "Changes", count: files, disabled: false },
    { id: "plan", label: "Plan", count: planItems, disabled: planItems === 0 },
  ];
  return (
    <div role="tablist" aria-label="Review column" className="flex min-w-0 items-center gap-1">
      {tabs.map(({ id, label, count, disabled }) => {
        const selected = tab === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={RIGHT_TAB_ID[id]}
            aria-controls={RIGHT_PANEL_ID[id]}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={disabled}
            title={disabled ? "The harness has published no plan yet" : undefined}
            onClick={() => onPick(id)}
            className={cn(
              "inline-flex h-6 items-center gap-1.5 rounded-md px-1.5 font-medium text-2xs uppercase tracking-[0.14em] transition-colors",
              selected
                ? "bg-muted text-foreground ring-1 ring-border"
                : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
              disabled && "opacity-50",
            )}
          >
            {label}
            {count > 0 ? (
              <span className="rounded-full bg-background/60 px-1 font-mono text-[10px] normal-case tracking-normal">
                {count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
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

/** The IDE-like Task workspace: harness terminal + git changes + review gate. */
export function TaskWorkspace({ taskId }: { taskId: string }) {
  const utils = trpc.useUtils();
  const task = trpc.task.get.useQuery({ id: taskId });
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
  const onLive = useCallback(
    (event: TaskEvent) => {
      if (event.kind === "status" || event.kind === "diff") {
        utils.task.get.invalidate({ id: taskId });
        utils.session.listForTask.invalidate({ taskId });
        utils.session.get.invalidate();
        // A Step advancing announces the state too, so this is what moves the step strip.
        utils.workflow.taskBinding.invalidate({ taskId });
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
  const isRunning = task.data?.state === "running";
  useEffect(() => {
    if (queued === null) return;
    if (!isRunning) {
      setQueued(null);
      return;
    }
    if (live.status === "open" && live.sendInput(queued)) setQueued(null);
  }, [queued, isRunning, live.status, live.sendInput]);

  /**
   * The split between the run and the change under review — a per-user preference, so the
   * arrangement follows the person rather than the browser (issue #3, AC-3).
   *
   * Optimistic: the divider must track the pointer, and a column that snapped back while a
   * round trip completed would be unusable. The mutation is fired on release, not per move, so
   * one drag is one write.
   */
  const paneQuery = trpc.preference.getTaskPaneLayout.useQuery({});
  const [paneOverride, setPaneOverride] = useState<TaskPaneLayout | null>(null);
  const savePaneMutation = trpc.preference.setTaskPaneLayout.useMutation();
  const pane = paneOverride ?? paneQuery.data?.layout ?? DEFAULT_TASK_PANE_LAYOUT;
  const savePane = useCallback(
    (next: TaskPaneLayout) => {
      setPaneOverride(next);
      savePaneMutation.mutate(next);
    },
    [savePaneMutation],
  );

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

  /**
   * The harness's own plan, read from both of the page's sources for the same reason `rows` is.
   *
   * `session.get` holds the list as it stood when the query ran and the socket holds everything
   * since, so a `TodoWrite` mid-run has to reach the panel from the stream or the plan would sit
   * a reload behind the work it describes.
   *
   * Live wins outright when it has anything to say, rather than being merged: the socket resumes
   * from `seq` -1 on a first connection and from the last seq seen on a reconnect, so its copy of
   * the list is never the older of the two. The narrowing to the session on screen is the part
   * that is not obvious — `seq` restarts per Session, and a replay reaching back into an earlier
   * review round would otherwise let that round's final list win on array position alone.
   *
   * The live side reads `live.events` rather than the Step-scoped copy on purpose: a plan is the
   * harness's, not a Step's, and the panel it feeds sits in the Changes column, which is about
   * the whole Session the way `diffs` and `review` are. The persisted fallback does narrow with
   * the terminal — it is the same `events` — which is the honest reading of a reopened run: the
   * last plan *that Step* published. Live wins whenever there is a live run to have one.
   */
  const liveSessionId = latest?.id;
  const todos = useMemo(() => {
    for (let i = live.events.length - 1; i >= 0; i -= 1) {
      const event = live.events[i];
      if (event?.kind === "todos" && event.sessionId === liveSessionId) return event.items;
    }
    return latestTodos(events);
  }, [events, live.events, liveSessionId]);

  /**
   * Which of the right column's two tabs is showing.
   *
   * The column follows the Task by default — the plan while a run is in progress and nothing has
   * been captured yet, the change once there is one to review — because that is the tab an
   * operator would pick every time. A manual pick sticks until the Task changes state, which is
   * when the default would have changed anyway; pinning it for longer would leave a reviewer who
   * clicked Plan during the run staring at the plan when the diff lands.
   */
  const [tabPick, setTabPick] = useState<{ tab: RightTab; state: TaskState } | null>(null);

  const [input, setInput] = useState("");
  const decide = trpc.review.decide.useMutation({
    onSuccess: () => {
      utils.task.get.invalidate({ id: taskId });
      utils.task.list.invalidate();
      if (latest?.id) utils.session.get.invalidate({ sessionId: latest.id });
      // The decision is the record now; the draft that led to it is spent either way.
      draft.reset();
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
  const fileCount = capturedDiffs.reduce((n, d) => n + d.files.length, 0);
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
    return (
      <div className="space-y-3 p-6" aria-hidden>
        <div className="h-4 w-64 animate-pulse rounded-full bg-muted" />
        <div className="h-[60vh] animate-pulse rounded-xl border bg-card" />
      </div>
    );
  }
  if (task.error || !task.data) {
    return (
      <p className="p-6 text-destructive text-sm" role="alert">
        {task.error?.message ?? "Task not found"}
      </p>
    );
  }

  const t = task.data;
  const summaries = detail.data?.summaries ?? [];
  // Persisted history first, then anything that arrived live since this view mounted. A
  // compacted Session no longer ships the events its summaries stand in for, so the terminal
  // says what it is missing rather than quietly starting mid-run.
  const elided = summaries.reduce((n, s) => n + s.eventCount, 0);
  /**
   * What the terminal says it is showing, when it is showing one Step of several.
   *
   * Nothing at all on the whole run — including every Task on no Workflow, where `selected` is
   * always null. A caption saying "showing everything" over a terminal that has only ever shown
   * everything is a line an operator learns to stop reading.
   */
  const selectedStep = scope.stepped.findIndex((s) => s.step.id === scope.selected);
  const terminalScope: TerminalScope | null =
    selectedStep === -1
      ? null
      : {
          name: scope.stepped[selectedStep]?.step.name ?? "",
          position: selectedStep + 1,
          total: scope.stepped.length,
          current: scope.stepped[selectedStep]?.current ?? false,
        };
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
  const autoTab = todos.length > 0 && diffs.length === 0 && isRunning ? "plan" : "changes";
  const pickedTab = tabPick && tabPick.state === t.state ? tabPick.tab : autoTab;
  // A plan tab with no plan under it is disabled, so a pick that outlived its list falls back.
  const tab = pickedTab === "plan" && todos.length === 0 ? "changes" : pickedTab;
  const runDecision = (decision: "approve" | "reject" | "request_changes") => {
    if (!latest?.id) return;
    // The draft goes with a request for changes and nowhere else (F10 FR-7): an approval has
    // nothing to say to a harness that is done, and a rejection discards the work the notes
    // were about. Omitted, not empty, when there is nothing — the orchestrator has its own
    // sentence for "the reviewer left no notes".
    const feedback =
      decision === "request_changes"
        ? collateFeedback(draft.draft, (id) => (id ? nameFor(id) : null))
        : undefined;
    decide.mutate({ sessionId: latest.id, decision, ...(feedback ? { feedback } : {}) });
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
    <div className="flex h-full flex-col">
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

      {/* Task header */}
      <div className="flex items-center gap-3 border-b px-4 py-3">
        <Button asChild variant="ghost" size="icon" className="shrink-0">
          <Link href={back.href} aria-label={back.label}>
            <ArrowLeft />
          </Link>
        </Button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            {/*
              The Title step (`text-lg`, 16px here), not the control step, and the same one
              `/projects` gives its own heading. This is the one thing on the page that says what
              you are looking at, and at 13px it weighed exactly as much as the branch name under
              it and the chip beside it — a header where nothing was the subject.
            */}
            <h1 className="truncate font-semibold text-lg">{t.title}</h1>
            <TaskStateBadge state={t.state} size="sm" />
            {/*
              Beside the badge rather than in the action cluster on the right: the arrows change
              exactly the thing the badge shows, and a control placed away from its own readout
              leaves the operator checking two corners of the header to see what they just did.
            */}
            <TaskAdvance
              state={t.state}
              onMove={requestMove}
              pending={move.isPending || launch.isPending}
            />
            {/*
              The completion gate, where the operator already is.
              
              The card on the board carries the same control, and someone watching a run happen
              should not have to leave the page it is happening on to act on it. Present only for
              `changes_ready`: a run that finished having changed nothing has nothing to approve,
              and one that gave up has not finished.
            */}
            {t.completedOutcome === "changes_ready" && t.state === "running" ? (
              // The app's own Button, not a styled `<button>`: it brings the control ladder, the
              // one focus ring, the press, and — the reason it matters here — a loading state the
              // component owns, so the gate cannot be opened twice while the first call is in
              // flight. It keeps the done hue because it is the one control on this page that is
              // about a run having succeeded.
              <Button
                size="sm"
                variant="outline"
                className="border-state-done/35 bg-state-done/12 text-state-done hover:border-state-done/50 hover:bg-state-done/20 hover:text-state-done"
                loading={submitForReview.isPending}
                onClick={() => submitForReview.mutate({ id: t.id })}
                title={t.completedSummary ?? undefined}
              >
                <CheckCircle2 />
                Open review
              </Button>
            ) : t.completedAt ? (
              /*
                All three outcomes, named — and drawn as the app's soft badge rather than a
                hand-rolled 4px rectangle, which put two differently-shaped pills side by side in
                one header. This used to be a two-way split on `nothing_to_do`, which sent
                `changes_ready` into the "Stopped — blocked" arm — so the moment a successful run
                entered review, the header called it blocked while the transcript two inches below
                said "Finished — changes ready". Observed on a real run: two opposite claims on one
                screen, and the wrong one is the one in the header a reader trusts.
              */
              <CompletionBadge outcome={t.completedOutcome} />
            ) : null}
          </div>
          {/* The code step (12px mono), not the label step: this is a branch name, read glyph by
              glyph, and it was set at the size reserved for uppercase section captions. */}
          <p className="mt-0.5 flex items-center gap-1.5 truncate font-mono text-muted-foreground text-xs">
            <GitBranch className="size-3 shrink-0" aria-hidden />
            {branch ?? `base ${primary?.baseRef ?? "HEAD"}`}
          </p>
          <TaskDependencies blockedBy={dependencies.blockedBy} blocks={dependencies.blocks} />
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <StreamIndicator status={live.status} />
          <TaskMeta task={t} session={latest ?? null} />
          {blockedBy.button}
          {/*
            Deleting the Task the page is *about* leaves nowhere to stand, so it navigates back
            to the board rather than re-rendering against a Task that no longer exists.
          */}
          <DeleteTaskAction
            onDeleted={() => router.push(back.href)}
            taskId={t.id}
            taskTitle={t.title}
            trigger={(openDialog) => (
              <Button
                aria-label={`Delete ${t.title}`}
                className="text-muted-foreground hover:text-destructive"
                onClick={openDialog}
                size="icon"
                variant="ghost"
              >
                <Trash2 />
              </Button>
            )}
          />
        </div>
      </div>

      {/*
        Which Step of its Workflow the run is on, when it is on one (spec F03) — and, since the
        strip became the terminal's tablist, which Step's output is on screen.
      */}
      <WorkflowSteps scope={scope} />

      {moveMessage ? (
        <p
          className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-state-failed/30 bg-state-failed/10 px-3 py-2 text-state-failed text-sm"
          role="alert"
        >
          <TriangleAlert className="size-3.5 shrink-0" aria-hidden />
          {moveMessage}
        </p>
      ) : null}

      {/* Panels: the run on the left, the change under review in a column beside it. */}
      <SplitPane
        collapsed={pane.changesCollapsed}
        left={
          // Panel padding, the same 12px the Changes column beside it uses. Two halves of one
          // split with two different gutters is a seam you can see along the divider.
          <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
            <TerminalView
              rows={rows}
              elided={elided}
              // What lets the panel say "launching" over an empty terminal and name what the
              // harness is doing under a quiet one — both are only true while a run is alive.
              isRunning={isRunning}
              onRespondPermission={live.respondPermission}
              // Answering means reaching a live harness, so the control is offered only while
              // there is one: a finished run keeps its widgets as a record.
              {...(isRunning ? { onRespondWidget: live.respondWidget } : {})}
              // The other half of the strip's tablist. Only when there is a strip: a Task on no
              // Workflow has no tabs, so the terminal is a plain panel exactly as before.
              {...(scope.binding
                ? { panelId: TERMINAL_PANEL_ID, labelledBy: selectedTabId(scope.selected) }
                : {})}
              {...(terminalScope ? { scope: terminalScope } : {})}
            />

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
              ackError={ack && !ack.ok ? (ack.error ?? "unknown") : null}
            />
          </div>
        }
        onResize={(changesWidth) => savePane({ ...pane, changesWidth })}
        onToggle={(changesCollapsed) => savePane({ ...pane, changesCollapsed })}
        right={
          <>
            {/*
              Both panels stay mounted and one is hidden, rather than unmounting the inactive one:
              the Changes panel holds which file is open and how, and a reviewer who glanced at
              the plan should come back to the diff exactly where they left it.
            */}
            <div
              role="tabpanel"
              id={RIGHT_PANEL_ID.changes}
              aria-labelledby={RIGHT_TAB_ID.changes}
              hidden={tab !== "changes"}
              className="h-full"
            >
              <ScrollArea className="h-full">
                <div className="p-3">
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
                  {/*
                    The source-control panel (spec F22), one per Repository (issue #7 AC-4). A Task
                    can span several, and a reviewer shown one flat file list could not tell which
                    repository a path came from.
                  */}
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
                </div>
              </ScrollArea>
            </div>
            <div
              role="tabpanel"
              id={RIGHT_PANEL_ID.plan}
              aria-labelledby={RIGHT_TAB_ID.plan}
              hidden={tab !== "plan"}
              className="h-full"
            >
              <ScrollArea className="h-full">
                <div className="p-3">
                  {/*
                    The harness's own plan — what it still believes is outstanding — on a tab of its
                    own beside the change, because the two answer the reviewer's question from
                    opposite ends and are read at different moments: the plan while the run is
                    going, the diff once it has stopped.

                    Nothing at all when the harness has published no list: `TodoList` renders `null`
                    on an empty one, and the tab is disabled so a heading over nothing is never shown.
                  */}
                  {todos.length > 0 ? (
                    <section aria-label="Harness plan">
                      <TodoList items={todos} />
                    </section>
                  ) : null}
                </div>
              </ScrollArea>
            </div>
          </>
        }
        rightHeading={
          <RightColumnTabs
            tab={tab}
            onPick={(next) => setTabPick({ tab: next, state: t.state })}
            files={diffs.reduce((n, d) => n + d.files.length, 0)}
            planItems={todos.length}
          />
        }
        rightLabel="Review"
        width={pane.changesWidth}
      />

      <TaskFooter
        task={t}
        outstanding={dependencies.outstanding}
        consequences={summariseConsequences(reviewGroups)}
        viewed={
          t.state === "review" && fileCount > 0 ? { viewed: viewedCount, of: fileCount } : null
        }
        notes={{
          count: draft.draft.notes.length,
          general: draft.draft.general,
          onGeneral: draft.setGeneral,
        }}
        decidePending={decide.isPending ? (decide.variables?.decision ?? null) : null}
        onDecide={runDecision}
        onLaunch={() => requestMove("running")}
        onRetry={() => retry.mutate({ id: t.id })}
        onMove={requestMove}
        actionPending={move.isPending || launch.isPending || retry.isPending}
        renewHref={renewHref}
        error={footerMessage}
      />
    </div>
  );
}
