import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseSessionEventPayload,
  reviewDecisionSchema,
  type SessionEventPayload,
  stopReasonMeansTruncated,
  type TodoItem,
  todoItemSchema,
  validateWidgetResponse,
  WIDGET_ANSWER_PREFIX,
  type Widget,
  type WidgetResponse,
  widgetExpectsResponse,
  widgetOptions,
} from "@solow/contracts";
import {
  CREDENTIAL_EXPIRED_REASON,
  carryHarnessDecision,
  carryHarnessReview,
  classifyRunFailure,
  handoffWith,
  reopenAfterApplyingDecisions,
  stepCanEndWorkflow,
} from "@solow/core";
import { renderForkDigest } from "@solow/core/session-log";
import { createDb, loadHarnessLibrariesForRun } from "@solow/db";
import {
  captureException,
  createLogger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "@solow/observability";
import { z } from "zod";
import { prepareHarnessEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  compactSession,
  forgetHarnessConversations,
  hasEarlierSession,
  isMissingParentRow,
  loadForkOrigin,
  loadHarnessProbeContext,
  loadTaskRunContext,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordHarnessSessionId,
  recordSessionUsage,
  recordTaskCompletion,
  recordWorktree,
  resolveResumeHarnessSessionId,
  setSessionState,
  setTaskState,
  type TaskRepositoryBinding,
  type TaskRunContext,
  takeUpReviewDecision,
  updateHarnessCatalogCapabilities,
} from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import { createExecutorFor, probeExecutorFor } from "../../executor/factory.js";
import { worktreeNameForTask } from "../../harness/claude-code-runner.js";
import { clientDirectives } from "../../harness/client-directives.js";
import { profileHarnessConfig } from "../../harness/harness-config.js";
import { resolveHarnessConfigEnv } from "../../harness/hermetic-home.js";
import { materializeLibraries } from "../../harness/libraries.js";
import { harnessRegistry } from "../../harness/registry.js";
import type { HarnessRunner, HarnessTextChannel } from "../../harness/runner.js";
import { createHarnessRunner } from "../../harness/runners.js";
import { WIDGET_BRIEF_INSTRUCTIONS, WidgetFenceScanner } from "../../harness/widget-fence.js";
import {
  adoptWorktree,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  harnessHomePath,
  hasChanges,
  prepareRepository,
  provisionWorktree,
  publishWorktreeBranch,
  pushWorktreeBranch,
  type Worktree,
  worktreePath,
} from "../../worktree/manager.js";
import { seedSetupFiles } from "../../worktree/setup-files.js";
import { hub } from "../../ws/hub.js";
import { toTaskEvent } from "../../ws/replay.js";
import { inngest } from "../client.js";
import { reportStepFinished, type StepTransition, takeAdvance } from "./task-run/advance.js";
import { applyDecision } from "./task-run/decision.js";
import { prepareWorkspace, resolveEntry, TASK_RUN_RETRIES } from "./task-run/prepare.js";
import { createRunScope } from "./task-run/scope.js";
import { failRound, failRun, parkRound } from "./task-run/terminal.js";
import {
  type LoopState,
  patternsFor,
  type TaskRunArgs,
  type TaskRunDeps,
} from "./task-run/types.js";

export { executorBindPaths } from "./task-run/prepare.js";
export { PARK_SLEEP_MS } from "./task-run/terminal.js";
export type {
  HubLike,
  StepLike,
  TaskRunArgs,
  TaskRunDeps,
  WorktreeOps,
} from "./task-run/types.js";

/**
 * Durable Task lifecycle (plan §9 / task TASK-019). Steps are resumable: an orchestrator
 * restart resumes from the last completed step (Principle III). The review gate is a state in
 * the database, not a pause in the engine: a run ends when it opens one, and the decision starts
 * the next run (Principle I — no integration without a recorded human decision).
 *
 * The lifecycle body is factored into `runTaskLifecycle(deps, …)` so its collaborators (harness
 * runner, worktree ops, hub, db) can be injected — the Inngest function wires the real ones,
 * and the integration test (TASK-020) drives it with a fake ACP agent + a controllable step.
 */

/**
 * What starts a run: a launch, or a person's decision at a review gate.
 *
 * A run never waits at a gate. It records the work, opens the gate and ends; the decision is a
 * row in `review`, and `review.decide` starts the next run with that row's id and contents here.
 * Waiting inside the engine (`waitForEvent`) made the gate as durable as the engine's pause
 * index, and the local Dev Server loses that on a restart: decisions were published to a run that
 * no longer existed, the gate kept its Approve button, and nothing anywhere failed. The database
 * holds the gate now, so a decision is either delivered as a run or refused where it was clicked.
 */
const launchData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
  review: z
    .object({
      id: z.string().min(1),
      decision: reviewDecisionSchema,
      feedback: z.string().nullish(),
    })
    .optional(),
});

const MAX_REVIEW_ROUNDS = 5;

/**
 * How many extra rounds a harness may have to carry on a conversation its own budget cut short.
 *
 * A separate budget from `MAX_REVIEW_ROUNDS` because it answers a different question.
 * `roundsOnStep` is the *reviewer's* patience: how many times a person is willing to send work
 * back before the run gives up on them. This is the *model's*: how many times a harness that ran
 * out of turns or context mid-task may pick the same conversation up and keep going. Spending one
 * out of the other is how a Task that simply had a lot to do arrives at review with the reviewer's
 * rounds already gone, and how a Task the reviewer keeps rejecting quietly gets extra attempts.
 *
 * Three. One is not a budget — a harness that hits `max_turns` has usually only just started, and
 * the first continuation is the ordinary case this whole mechanism exists for. Ten would let a
 * `max_tokens` stop — a conversation whose context is genuinely full, and which will therefore
 * truncate again a few turns after every resume — spend the run going round in a circle nobody is
 * watching. Three is enough for a long job to finish and few enough that a conversation which is
 * not converging reaches a person while there is still something for them to decide.
 *
 * Exhausting it is not a failure and never throws: the round falls through to exactly the path a
 * finished round takes, with a notice saying the budget was spent, so the operator is given the
 * work and the reason rather than a stall.
 */
const MAX_AUTO_CONTINUE_ROUNDS = 3;

/**
 * How long a declared-finished harness is given to say anything more before the round is ended.
 *
 * Long enough that a model which declares and then adds a closing paragraph is not cut off;
 * short enough that a run does not spend a meaningful part of Inngest's execution budget waiting
 * on a process that has nothing left to do. Every further event re-arms it, so this is a
 * *silence* budget rather than a deadline on the harness.
 */
const COMPLETION_GRACE_MS = 15_000;

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  return {
    db: createDb(),
    // The executor is no longer built here (issue #96). It cannot be: the Executor Profile
    // belongs to the Task, and no Task exists yet at this point — which is exactly why every
    // consumer below now takes one rather than closing over one.
    executorFor: createExecutorFor,
    preflight: probeExecutorFor,
    runner: (protocol, settings, executor) =>
      createHarnessRunner(protocol, {
        executor,
        permissionMode: settings.permissionMode,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
        ...(settings.checkpoints ? { checkpoints: settings.checkpoints } : {}),
        ...(settings.version ? { version: settings.version } : {}),
        ...(settings.autoApprove ? { autoApprove: true } : {}),
        unattendedPermissionPosture: env.SOLOW_ACP_UNATTENDED_PERMISSION,
      }),
    worktreeRoot: env.SOLOW_WORKTREE_ROOT,
    repoCacheRoot: env.SOLOW_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: (executor) => ({
      prepare: (params) => prepareRepository(executor, params),
      provision: (params) => provisionWorktree(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      seed: (params) => seedSetupFiles(executor, params),
      commit: (path, message, patterns) => commitWorktree(executor, path, message, patterns),
      discard: (path) => discardWorktreeChanges(executor, path),
      publish: (repoPath, upstreamPath, branch) =>
        publishWorktreeBranch(executor, repoPath, upstreamPath, branch),
      push: (upstreamPath, remoteUrl, branch, credential) =>
        pushWorktreeBranch(executor, upstreamPath, remoteUrl, branch, credential),
      cleanup: (repoPath, worktree, ownRepository) =>
        cleanupWorktree(executor, repoPath, worktree, { ownRepository }),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    }),
    hub,
    registry: harnessRegistry,
  };
}

/**
 * What a line of harness output *is*, from the channel the protocol reported it on.
 *
 * The mapping is the whole point of carrying the channel this far: without it every line was a
 * `stdout` blob and the transcript could not distinguish the operator's own steering from the
 * model's answer from a mode switch (issue #2, AC-1).
 */
function textPayload(channel: HarnessTextChannel, text: string): SessionEventPayload {
  if (channel === "user") return { kind: "user_turn", text };
  if (channel === "system") return { kind: "notice", text };
  return { kind: "assistant_turn", text, thinking: channel === "thinking" };
}

/**
 * Which of a tool's arguments may be written to the durable log, by tool name.
 *
 * A tool call's raw input can hold the contents of a file being written, which is exactly the
 * class of value that must never reach a durable payload (Principle IV) — so the schema declared
 * `tool_call.input` and left it unpopulated for a long time. The cost was a transcript that
 * could only ever say "tool: Read": a reviewer could not see which file, which command, or which
 * pattern, which is most of what makes a tool call worth reading.
 *
 * The resolution is an allowlist of *keys*, not a size limit or a redaction pass over everything.
 * A denylist would be wrong here: it fails open, so a tool added upstream with a new
 * content-bearing argument would start leaking the day it shipped. This fails closed — an
 * unknown tool contributes no arguments at all.
 *
 * `Write.content` and `Edit.new_string` are absent on purpose and must stay absent. They are the
 * file contents.
 */
const TOOL_INPUT_ALLOWLIST: Record<string, readonly string[]> = {
  Read: ["file_path", "offset", "limit"],
  Write: ["file_path"],
  Edit: ["file_path", "replace_all"],
  NotebookEdit: ["notebook_path", "cell_id"],
  Bash: ["command", "description", "timeout"],
  BashOutput: ["bash_id"],
  KillShell: ["shell_id"],
  Glob: ["pattern", "path"],
  Grep: ["pattern", "path", "glob", "type"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description", "subagent_type"],
  // Nothing here, and nothing that could be: a todo list is an array of objects and this map
  // holds short strings. A well-formed `TodoWrite` never reaches this function at all — it is
  // recorded as a `todos` event instead (see `readTodoWrite`) — so what this entry now governs
  // is only the fallback row a malformed one falls through to.
  TodoWrite: [],
};

/**
 * ACP reports a tool call's status as a free-form string; the log stores a closed set. An
 * unrecognised value becomes null rather than being stored raw — a status nothing can render is
 * worse than none, and a future ACP vocabulary must not be able to widen the persisted union by
 * writing into it.
 */
const TOOL_STATUSES = ["pending", "in_progress", "completed", "failed"] as const;
type ToolStatus = (typeof TOOL_STATUSES)[number];
export function toolStatus(value: string | null): ToolStatus | null {
  return TOOL_STATUSES.includes(value as ToolStatus) ? (value as ToolStatus) : null;
}

/** Longest an allowlisted argument may be before it is cut. A command is a line, not a file. */
const TOOL_INPUT_MAX = 400;

/** Longest a tool's output may be before it is cut, with `truncated` set to say so. */
const TOOL_OUTPUT_MAX = 2_000;

/**
 * A tool call's arguments, narrowed to what may be stored.
 *
 * Values are stringified and cut to `TOOL_INPUT_MAX`, so the stored shape is always a flat map
 * of short strings — the guarantee `sessionEventPayloadSchema` encodes with `z.record(z.string())`.
 * Returns null rather than an empty object for a tool that contributes nothing, so a reader can
 * tell "no arguments recorded" from "arguments recorded, and there were none".
 */
export function allowlistToolInput(name: string, input: unknown): Record<string, string> | null {
  const keys = TOOL_INPUT_ALLOWLIST[name];
  if (!keys || keys.length === 0) return null;
  if (typeof input !== "object" || input === null) return null;

  const source = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value === undefined || value === null) continue;
    const text = typeof value === "string" ? value : JSON.stringify(value);
    out[key] = text.length > TOOL_INPUT_MAX ? `${text.slice(0, TOOL_INPUT_MAX)}…` : text;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * How many todo items and how much of each one the log will hold.
 *
 * The same numbers `todoItemSchema` enforces, restated here because this is the side that has to
 * *make* the payload fit: a list that overshoots the bound is cut down to it rather than
 * refused. Refusing would mean falling back to the `TodoWrite` tool call, which is precisely the
 * contentless row recording the list exists to remove.
 */
const TODO_ITEMS_MAX = 100;
const TODO_TEXT_MAX = 500;

/** Cut a todo's text to the schema's bound, leaving the marker inside it rather than over it. */
function boundTodoText(value: unknown): unknown {
  if (typeof value !== "string" || value.length <= TODO_TEXT_MAX) return value;
  return `${value.slice(0, TODO_TEXT_MAX - 1)}…`;
}

/**
 * The todo list out of a `TodoWrite` call, or null when the input is not one.
 *
 * Pure and exported so it can be tested without a run: this is the only thing standing between
 * a harness's plan and the durable log, and its two failure modes pull in opposite directions —
 * too strict and the list is silently replaced by the contentless tool-call row it was meant to
 * abolish, too loose and an unbounded blob reaches a record that outlives the run.
 *
 * So the bounds are applied first and the shape is checked second. An over-long list is cut and
 * kept; a list whose items are not todos at all is refused, and the caller falls back to
 * emitting the tool call — an emission this file cannot understand is degraded, never dropped.
 */
export function readTodoWrite(input: unknown): TodoItem[] | null {
  if (typeof input !== "object" || input === null) return null;
  const todos = (input as Record<string, unknown>)["todos"];
  if (!Array.isArray(todos)) return null;

  const bounded = todos.slice(0, TODO_ITEMS_MAX).map((item) => {
    if (typeof item !== "object" || item === null) return item;
    const fields = item as Record<string, unknown>;
    const out: Record<string, unknown> = { ...fields, content: boundTodoText(fields["content"]) };
    if (fields["activeForm"] !== undefined) out["activeForm"] = boundTodoText(fields["activeForm"]);
    return out;
  });

  const parsed = z.array(todoItemSchema).safeParse(bounded);
  return parsed.success ? parsed.data : null;
}

/**
 * A tool's output, cut to a length a transcript can hold.
 *
 * Compaction will not save the log from an untruncated one: `SESSION_COMPACTION_THRESHOLD`
 * counts events, not bytes, and only runs at a review-round boundary — so a single `Read` of a
 * large file would sit in the log whole until then.
 */
export function truncateToolOutput(output: string | null): {
  output: string | null;
  truncated: boolean;
} {
  if (output === null) return { output: null, truncated: false };
  if (output.length <= TOOL_OUTPUT_MAX) return { output, truncated: false };
  return { output: `${output.slice(0, TOOL_OUTPUT_MAX)}…`, truncated: true };
}

/** What a redacted secret leaves behind, so a reader can see that something was removed. */
const REDACTED = "[redacted]";

/**
 * Values this run holds that must never end up in a payload (Principle IV, issue #2 DoD).
 *
 * The needles are exact strings — the decrypted credential as it was written into the harness's
 * environment, and the ciphertext it was decrypted from — rather than a pattern that guesses at
 * what a token looks like. The realistic path a secret takes into the log is the harness echoing
 * its own environment: `echo $ANTHROPIC_API_KEY`, a config dump, a stack trace that prints a
 * header. All of those carry the value verbatim, so an exact match catches them, while a
 * heuristic would both miss real keys and mangle innocent text.
 *
 * Anything shorter than eight characters is left alone: it is not a credential, and redacting a
 * short string would replace ordinary words all over a transcript.
 */
function secretNeedles(
  env: Readonly<Record<string, string>>,
  catalog: { subscriptionEnvVar: string; meteredEnvVar: string },
  ciphertext: string | null,
): string[] {
  const candidates = [env[catalog.subscriptionEnvVar], env[catalog.meteredEnvVar], ciphertext];
  return [
    ...new Set(candidates.filter((v): v is string => typeof v === "string" && v.length >= 8)),
  ];
}

/** Replace every occurrence of each needle in every string the value holds, however deep. */
function redactValue(value: unknown, needles: readonly string[]): unknown {
  if (typeof value === "string") {
    return needles.reduce((text, needle) => text.split(needle).join(REDACTED), value);
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, needles));
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return Object.fromEntries(entries.map(([k, v]) => [k, redactValue(v, needles)]));
  }
  return value;
}

/**
 * A record with this run's own secrets stripped out of it.
 *
 * Applied to the whole payload rather than to the text variants alone: the log is the record
 * that outlives the run and travels — into a snapshot (#16), into a harness's context (#84) — and
 * a future producer that populates `tool_call.input` should inherit the protection rather than
 * have to remember it. `kind` is put back verbatim so a needle can never rewrite the
 * discriminator itself.
 */
function redactPayload(
  payload: SessionEventPayload,
  needles: readonly string[],
): SessionEventPayload {
  if (needles.length === 0) return payload;
  const scrubbed = redactValue(payload, needles) as Record<string, unknown>;
  return { ...scrubbed, kind: payload.kind } as SessionEventPayload;
}

export async function runTaskLifecycle(
  deps: TaskRunDeps,
  { event, step, attempt = 0 }: TaskRunArgs,
): Promise<{ taskId: string; result: string }> {
  const { workspaceId, taskId, sessionId, review: decidedReview } = launchData.parse(event.data);
  const { db } = deps;
  const log = withRunContext(deps.logger, { workspaceId, taskId, sessionId });

  const ctx = await step.run("load", () => loadTaskRunContext(db, workspaceId, taskId));

  /*
   * A run started by a decision takes it up before anything else — once.
   *
   * The event can be delivered twice, and a second application is not harmless: approving a
   * middle Step twice would move the cursor past the Step after it without that Step ever
   * running. The write is conditional, so the run that loses finds the decision spent and leaves
   * without touching the Task.
   */
  if (decidedReview) {
    const taken = await step.run("decision-take-up", () =>
      takeUpReviewDecision(db, workspaceId, sessionId, decidedReview.id),
    );
    if (!taken) return { taskId, result: "decision_already_applied" };
  }

  const scope = createRunScope({ deps, step, log, workspaceId, taskId, sessionId, ctx });
  const { channel, announce, recordTransition } = scope;

  const entry = await resolveEntry(scope, decidedReview);
  if (!entry.ok) return entry.result;
  const { wf, legForStep, checkpointStore, entryLeg, executor, worktreeOps, repoAdmin } = entry;

  try {
    const workspace = await prepareWorkspace(scope, entry, attempt);
    if (!workspace.ok) return workspace.result;
    const {
      entryRunner,
      primaryBinding,
      repoPath,
      upstreamPathFor,
      provisionedByAttachment,
      provisioned,
      seed,
      worktreeBindings,
      retainedPrimary,
    } = workspace;

    /**
     * The worktree every later step — diff, commit, discard, cleanup — acts on. Read back from
     * the harness (Claude Code makes its own) or set from what SoloW provisioned (ACP), and
     * confirmed with git either way before anything is written into it.
     */
    let wt: Worktree | null = provisioned;

    /** Feedback from the previous review round; it becomes the next round's brief. */
    let pendingFeedback: string | undefined;
    /**
     * The decisions a reviewer settled when approving this Step, while the harness applies them.
     *
     * Approving a Step whose harness asked decisions does not move the Workflow on at once. The
     * reviewer's answers are instructions to *this* Step's harness — a choice it made may have
     * been overturned, and the spec or plan it wrote still says otherwise — so the harness gets
     * one more round on the same Step to bring its work in line, and the approval is spent only
     * once that round has finished. Moving on at the click handed the next Step work that did not
     * yet reflect the answers it was being briefed with.
     *
     * Set by the approval, read by the round it starts (its brief) and by that round's end (the
     * advance), cleared there and at every Step boundary.
     */
    let applyingDecisions: string | null = null;

    /**
     * The harness binding and brief this round runs under (issue #5, AC-3).
     *
     * `let`, and so is the runner beside it — that pair is the whole of what a Step boundary
     * changes. Everything else the loop touches is per *round*, which is why there is no nested
     * Step loop: a nested one would reset `round` and Inngest would hand Step 2 back Step 1's
     * memoized `agent-run-0` and `approve-0`, silently skipping Step 2's harness run and replaying
     * Step 1's review decision. A monotonic counter makes that impossible to write.
     */
    let leg = entryLeg;
    let runner: HarnessRunner = entryRunner;
    /**
     * How many rounds this Step has had. `MAX_REVIEW_ROUNDS` is per Step, not per run: a
     * five-Step pipeline that spent its whole budget on Step 1 would otherwise reach Step 2 with
     * no rounds left and stop without saying why.
     */
    let roundsOnStep = 0;
    /**
     * How many rounds this Step has spent carrying on a conversation the harness's own budget cut
     * short, since the last round a reviewer was shown (`MAX_AUTO_CONTINUE_ROUNDS`).
     *
     * Reset wherever `roundsOnStep` is — at a Step boundary — and also on any round that does not
     * auto-continue: reaching the review gate is the harness having finished a stretch of work,
     * and the next stretch starts with its own budget rather than the remains of the last one's.
     */
    let autoContinues = 0;
    /**
     * Whether the round about to start is one of those, rather than one the reviewer asked for.
     *
     * A flag rather than a comparison against `autoContinues`, because the loop has to answer two
     * different questions from it: whether to spend one of the reviewer's rounds (it must not),
     * and what to tell the harness about why it is being started again.
     */
    let continuingTruncated = false;
    /**
     * The round about to start follows one whose `--resume` named a conversation the harness no
     * longer has (history: a transcript purged, or its worktree gone). Set once per run — the
     * second such failure is a real one — and what keeps the retry from asking to resume again.
     */
    let resumeLost = false;
    /** The very next round is that retry, and does not spend a reviewer's round. */
    let resumeLostRetry = false;

    /**
     * The loop's bindings as the parts that read or rebind them see them — accessors rather than
     * a copy, so a part and the loop can never disagree about which Step is in force.
     */
    const loop: LoopState = {
      get wt() {
        return wt;
      },
      set wt(value) {
        wt = value;
      },
      get leg() {
        return leg;
      },
      set leg(value) {
        leg = value;
      },
      get runner() {
        return runner;
      },
      set runner(value) {
        runner = value;
      },
      get roundsOnStep() {
        return roundsOnStep;
      },
      set roundsOnStep(value) {
        roundsOnStep = value;
      },
      get autoContinues() {
        return autoContinues;
      },
      set autoContinues(value) {
        autoContinues = value;
      },
      get continuingTruncated() {
        return continuingTruncated;
      },
      set continuingTruncated(value) {
        continuingTruncated = value;
      },
      get pendingFeedback() {
        return pendingFeedback;
      },
      set pendingFeedback(value) {
        pendingFeedback = value;
      },
      get applyingDecisions() {
        return applyingDecisions;
      },
      set applyingDecisions(value) {
        applyingDecisions = value;
      },
    };
    const transition: StepTransition = { wf, legForStep, checkpointStore, executor };

    /**
     * How many Steps this run believes the Workflow has.
     *
     * Read from the **memoized** `workflow-resume` output and from nowhere else. A live read
     * would let an edit change the loop bound between replays, and a replay that walked a
     * different number of iterations would reach a different step id than the journal holds.
     */
    const stepCount = wf ? wf.steps.length : 1;
    /**
     * The outer bound on the loop, which is now two budgets deep rather than one.
     *
     * Every round the reviewer is entitled to may itself be continued `MAX_AUTO_CONTINUE_ROUNDS`
     * times, so the worst case is the product — not the sum, and certainly not `MAX_REVIEW_ROUNDS`
     * alone. Leaving it at the old value is the subtle version of the bug this whole change is
     * about: auto-continue rounds would silently eat the reviewer's, and a Task that used its
     * continuations early would fall out of the bottom of the loop with nothing recorded and
     * nothing said. It is a sanity bound on a bounded thing, not a second policy — the two budgets
     * below decide what actually happens.
     */
    const maxRounds = MAX_REVIEW_ROUNDS * (1 + MAX_AUTO_CONTINUE_ROUNDS) * Math.max(1, stepCount);

    if (decidedReview) {
      const applied = await applyDecision(
        scope,
        {
          transition,
          worktreeOps,
          repoAdmin,
          repoPath,
          retainedPrimary,
          worktreeBindings,
          upstreamPathFor,
        },
        loop,
        decidedReview,
      );
      if (applied) return applied;
    }

    for (let round = 0; round < maxRounds; round++) {
      /*
       * A round carrying on a truncated conversation is the model's, not the reviewer's: it
       * neither spends `roundsOnStep` nor may be stopped by it. `MAX_AUTO_CONTINUE_ROUNDS` is what
       * bounds it, and it is checked where the decision to continue is made rather than here.
       *
       * With no Workflow and nothing truncated: stepCount 1, `roundsOnStep === round + 1`, and
       * this never fires — rounds 0 to 4 exactly as before. With one: the budget is per Step and
       * resets at every advance, so a Step that exhausts it stops the run rather than the pipeline
       * running on into the next Step with the reviewer's patience already spent.
       */
      // Nor is the retry of a round whose `--resume` found nothing (`resumeLostRetry`): the
      // reviewer has not seen that round either.
      if (!continuingTruncated && !resumeLostRetry) {
        if (roundsOnStep >= MAX_REVIEW_ROUNDS) break;
        roundsOnStep += 1;
      }
      resumeLostRetry = false;
      /*
       * Read once and cleared here, so nothing below can mistake "the round that just started was
       * a continuation" for "the round that just ended asked for one". Run-local rather than
       * durable, and deterministic under replay for the same reason the loop itself is: it is
       * derived only from the memoized results of earlier rounds.
       */
      const continuation = continuingTruncated;
      continuingTruncated = false;
      // Captured, because `leg` is rebound at the next Step boundary while this round's harness
      // may still be reporting its conversation id on a detached chain.
      const roundStepId = leg.stepId;
      const run = await step.run(`agent-run-${round}`, async () => {
        /*
         * The credential for the Profile *this leg* runs under (AC-3).
         *
         * Resolved here, inside the step that uses it, rather than carried on the memoized
         * `workflow-agents` output: `step.run` memoizes what it returns into Inngest's durable
         * store, and `load` already puts one decryptable ciphertext there. One more per Step
         * widens an existing exposure to buy nothing (Principle IV). A Profile deleted since
         * `workflow-agents` resolved reads as no credential, which `prepareHarnessEnv` refuses
         * below as `credential_expired` — the same answer a revoked secret already gets.
         */
        const legCiphertext = wf
          ? ((await loadHarnessProbeContext(db, workspaceId, leg.harnessProfile.id))
              ?.secretCiphertext ?? null)
          : ctx.secretCiphertext;
        /*
         * What a command run by *this* executor would inherit, not what the orchestrator
         * inherited (issue #96, §1). `SpawnOpts.env` replaces the child's environment wholesale,
         * so the base has to describe the machine the harness is actually on: handing a
         * containerised harness the host's `PATH` and `HOME` describes a machine it is not running
         * on, and it then fails for reasons that have nothing to do with the Task. Identical to
         * `process.env` for the local driver, which is what it always was.
         */
        const hostEnv = await executor.baseEnv();
        /*
         * A blank, app-owned configuration for this Task (Decision 0027).
         *
         * Resolved here rather than once at provisioning time because the answer depends on the
         * driver: a container already has a `HOME` nobody has ever configured and is only told to
         * stay in it, while a local run is pointed at a directory beside its worktree so the
         * operator's `~/.claude` is somewhere it never looks. Idempotent, which is the point —
         * every round of the Task passes through here and round two resumes round one's home.
         */
        const homePath = harnessHomePath(deps.worktreeRoot, taskId);
        const homeEnv = await resolveHarnessConfigEnv({
          kind: ctx.executorProfile.config.kind,
          home: homePath,
          baseEnv: hostEnv,
          // Where a round from before the home was resolved left it: the same relative path, read
          // against the harness's working directory — the worktree, or the checkout it began in.
          legacyHomes: isAbsolute(homePath)
            ? []
            : [wt?.path, repoPath]
                .filter((d): d is string => Boolean(d))
                .map((d) => resolve(d, homePath)),
        });
        /*
         * The configuration the app *does* hand this harness (Decision 0028): the leg's Profile's
         * Harness Config, read here so an edit is the next round's config, and delivered by
         * variable or flag — never a file in a home — so it reaches a container the same way.
         * Its variable rides with the home's, above the Executor Profile and under the credential.
         */
        const { config: harnessConfig, launch: configLaunch } = await profileHarnessConfig(
          db,
          workspaceId,
          leg.harnessProfile,
          leg.harnessCatalog,
        );
        const configEnv = { ...homeEnv, ...(configLaunch.ok ? configLaunch.data.env : {}) };
        const shaped = prepareHarnessEnv({
          authMode: leg.harnessProfile.authMode,
          secretCiphertext: legCiphertext,
          baseEnv: hostEnv,
          subscriptionEnvVar: leg.harnessCatalog.subscriptionEnvVar,
          meteredEnvVar: leg.harnessCatalog.meteredEnvVar,
          // The Executor Profile's environment (issue #73). It is applied under the credential
          // shaping, never over it, so a profile cannot become a route to metered billing.
          profileEnv: ctx.executorProfile.config.env ?? {},
          // …and under the configuration isolation, for the same reason stated the same way: the
          // configuration a Task runs against is the app's decision, not a profile's.
          configEnv,
        });
        if (!shaped.ok) return { kind: "failed" as const, cls: CREDENTIAL_EXPIRED_REASON };

        // What must never reach a payload, computed from the env this run actually shaped rather
        // than from a list of variable names, so it holds for whichever Harness is running.
        const needles = secretNeedles(shaped.data, leg.harnessCatalog, legCiphertext);

        // Every streamed event is published live *and* appended to the session log, so a client
        // that reconnects can replay from `seq` instead of losing history (TASK-018). Writes are
        // chained to keep log order identical to stream order.
        let seq = await nextSessionEventSeq(db, workspaceId, sessionId);
        let writes: Promise<unknown> = Promise.resolve();

        /**
         * The Workflow Step every event of *this* round belongs to.
         *
         * Read once, here, rather than off `leg` inside `emit`. A Step boundary rebinds `leg` in
         * place, and the appends below are a fire-and-forget chain — the last of a round's writes
         * can still be settling when the loop has already taken the advance. Reading `leg` at
         * write time would then file the tail of one Step's transcript under the next Step, which
         * is exactly the attribution this column exists to get right. A round never spans two
         * Steps, so one read is the whole truth for it.
         */
        const stepInForce = leg.stepId;

        /**
         * The run outlived the rows it writes into.
         *
         * A Task can be deleted — or its Issue force-deleted — while its harness is mid-turn:
         * cancellation happens *between* Inngest steps, and stopping a harness is a request, not an
         * instant. `cascadeDeleteTasks` takes the `session` row with the Task, so every event this
         * run appends afterwards fails on `session_event.session_id`'s foreign key.
         *
         * What that produced was one logged stack trace per chunk of harness output, for a run whose
         * transcript has nowhere to live, whose work nobody will review, and which keeps spending
         * tokens until it finishes on its own. So the first such failure latches here: the log
         * says it once, the harness is stopped, and the rest of the round is skipped.
         */
        let abandoned = false;
        /** Set once the harness exists, so `abandon` can stop something that started after it. */
        let live: { stop: () => Promise<void> | void } | null = null;

        const abandon = (stage: string) => {
          if (abandoned) return;
          abandoned = true;
          log.warn(
            { stage },
            "the Session this run writes to no longer exists — it was deleted while the harness was live; stopping the harness and abandoning the round",
          );
          try {
            void live?.stop();
          } catch (cause) {
            captureException(log, cause, { stage: "abandon-stop" });
          }
        };
        // Usage is recorded per turn as it is reported (issue #14) — the harness states it once,
        // in its own stream, and nothing else in the system can reconstruct it afterwards.
        //
        // The CLI emits one event per *content block* of a turn and repeats that turn's usage on
        // every one, so the turn id is the identity: a repeat is dropped here rather than
        // multiplying the turn's counts by its block count. `seq` only orders, and is read back
        // from the database because a Session outlives a single durable step (review rounds).
        let usageSeq = await nextSessionUsageSeq(db, workspaceId, sessionId);
        const seenTurns = new Set<string>();
        const recordUsage = (u: {
          messageId: string | null;
          reported: boolean;
          model: string | null;
          inputTokens: number;
          outputTokens: number;
          cacheReadTokens: number;
          cacheWriteTokens: number;
        }) => {
          if (abandoned) return;
          const seq = usageSeq;
          // A CLI that reports no turn id gets one derived from position — still stable under
          // replay, because the sequence itself is read back from the database each round.
          const messageId = u.messageId ?? `seq:${seq}`;
          if (seenTurns.has(messageId)) return;
          seenTurns.add(messageId);
          usageSeq += 1;
          writes = writes
            .then(() =>
              recordSessionUsage(db, workspaceId, {
                sessionId,
                taskId,
                // The Profile that actually burned these tokens, which under a Workflow is the
                // Step's rather than the Task's (AC-3). `profile.ts` counts usage rows per
                // Profile, so attributing Step 2's turns to Step 1's harness would be a durable
                // record of work that harness never did. Identical to `ctx.harnessProfile.id` for a
                // Task on no Workflow.
                agentProfileId: leg.harnessProfile.id,
                messageId,
                seq,
                reported: u.reported,
                model: u.model,
                inputTokens: u.inputTokens,
                outputTokens: u.outputTokens,
                cacheReadTokens: u.cacheReadTokens,
                cacheWriteTokens: u.cacheWriteTokens,
              }),
            )
            .catch((cause) =>
              isMissingParentRow(cause)
                ? abandon("session-usage-record")
                : captureException(log, cause, { stage: "session-usage-record" }),
            );
          // A usage record *is* a completed turn, deduplicated on the turn id — the only
          // protocol-independent turn boundary this loop can see. See `captureTurnDiffs`.
          captureTurnDiffs();
        };

        // One typed record, published and persisted (issue #2, AC-1). The wire frame is *derived*
        // from the record by the same projection reconnect replay uses, rather than the payload
        // being spread onto the socket — which is what used to make the log's vocabulary the
        // transport's ("stdout", "tool_use") and let the two paths drift apart. A record with no
        // wire form is still written; it simply publishes nothing.
        /**
         * Ending the round once the harness has said it is finished and gone quiet.
         *
         * `await handle.outcome` waits for the harness **process to exit**, and a declaring harness
         * does not exit — Claude Code says `task_complete` and then sits waiting for whatever the
         * operator wants next. That is a reasonable thing for a CLI to do and a fatal thing for a
         * durable run to wait on: the step never returns, so Inngest never checkpoints it, the
         * platform kills the request after its execution budget (8 minutes, observed), and the
         * whole function is retried from the top — for ever. The gate step below it never runs, so
         * the gate is never opened and an approval has nothing to decide. That is the failure this
         * file's own comment
         * predicted ("a harness that declares and then waits for the operator does not exit") and
         * worked around for the *board* by recording the declaration mid-run; the run itself was
         * still hanging.
         *
         * So the declaration ends the round — after a grace period, not at once. The comment on
         * `completion` is right that a harness can declare and keep working: a `task_complete`
         * followed by more output is a declaration that has been superseded, and cutting the harness
         * off mid-thought would lose that work. Any further output therefore re-arms the timer, and
         * only silence ends the round.
         */
        let completionStop: ReturnType<typeof setTimeout> | null = null;
        const armCompletionStop = () => {
          if (completionStop) clearTimeout(completionStop);
          completionStop = setTimeout(() => {
            completionStop = null;
            // `stop`, not `kill`: the runner tears the process down through its own protocol, so
            // the outcome the step is awaiting resolves the way it would on a natural exit.
            void live?.stop();
          }, deps.completionGraceMs ?? COMPLETION_GRACE_MS);
          // Never a reason to hold the process open on its own.
          (completionStop as { unref?: () => void }).unref?.();
        };
        const disarmCompletionStop = () => {
          if (completionStop) clearTimeout(completionStop);
          completionStop = null;
        };

        const emit = (rawPayload: SessionEventPayload) => {
          // Nothing to append to and nothing worth publishing: the Session is gone.
          if (abandoned) return;
          // The harness is still talking, so whatever it declared is not the last word yet.
          if (completionStop) armCompletionStop();
          const at = seq++;
          // One record, read back through the union *before* either destination sees it.
          //
          // `appendSessionEvent` validates on the way in (AC-1) and this write is a fire-and-forget
          // link in a chain whose failures are only reported, so publishing first and appending
          // second would mean a payload the union refuses is seen by every live client and by
          // nobody who reconnects — the two paths disagreeing is precisely what AC-5's single
          // projection exists to rule out, and an operator who reconnected would lose an
          // outstanding permission request with only a captured exception to show for it. The
          // union's constraints are tighter than some producers' own (an ACP agent may offer an
          // option with an empty id), so the coercion is total: a record it cannot admit is kept
          // as a notice holding what arrived rather than dropped. Secrets come out first, before
          // anything is published or stored (Principle IV).
          const payload = parseSessionEventPayload(
            rawPayload.kind,
            redactPayload(rawPayload, needles),
          );
          const frame = toTaskEvent(payload, taskId, sessionId, at, stepInForce);
          if (frame) deps.hub.publish(channel, frame);
          writes = writes
            .then(() =>
              appendSessionEvent(db, workspaceId, {
                sessionId,
                seq: at,
                workflowStepId: stepInForce,
                payload,
              }),
            )
            .catch((cause) =>
              isMissingParentRow(cause)
                ? abandon("session-event-append")
                : captureException(log, cause, { stage: "session-event-append" }),
            );
        };

        /**
         * Where the harness went, resolved as soon as it says so.
         *
         * A promise rather than the `reported` variable below, because the turn capture runs from
         * inside the event stream — which starts before that variable is assigned — and a capture
         * that fired one turn too early would silently record nothing.
         */
        let announcePath: (path: string | null) => void = () => {};
        const announcedPath = new Promise<string | null>((resolve) => {
          announcePath = resolve;
        });

        /**
         * The primary worktree, as a fact rather than a claim.
         *
         * A resuming round already holds it. A first round with a `--worktree` harness does not: the
         * directory is the harness's to create, and it announces the path before its first turn.
         * Adoption is what turns that announcement into something safe to run git in — the same
         * check the run's own adoption makes, for the same reason (Principle II). Memoized: it is
         * a git call, and the answer cannot change within a round.
         */
        let primaryAdoption: Promise<Worktree | null> | null = null;
        const livePrimary = (): Promise<Worktree | null> => {
          if (wt) return Promise.resolve(wt);
          primaryAdoption ??= announcedPath
            .then((path) => (path ? repoAdmin.adopt(repoPath, path) : null))
            .catch(() => null);
          return primaryAdoption;
        };

        /**
         * The change the harness has made so far, captured at the boundary of every turn that
         * touched a file.
         *
         * The Changes panel renders `diff` records, and until now exactly one place wrote them:
         * the step that moves a Task to review. A harness that stops mid-run to ask a question —
         * "the change is in the working tree, shall I commit it?" — therefore left the operator
         * answering blind, with real work sitting in a worktree the UI structurally could not
         * show. This is the same capture the gate makes; only *when* moves. The gate still
         * captures for itself, so a Task that reaches review is unaffected either way.
         *
         * Three properties keep it from being expensive or noisy:
         *
         *  - **A turn, not a chunk.** It fires from `recordUsage`, which is deduplicated on the
         *    turn id, so a turn that streamed forty blocks captures once.
         *  - **Only when something changed.** `hasChanges` is asked first, so the many turns that
         *    only read cost two git commands rather than four and write nothing.
         *  - **Only when it changed since last time.** A patch identical to the one already in the
         *    log is dropped, so later turns that edit nothing add no records.
         *
         * Never awaited by the stream and never able to throw into it: a git hiccup mid-run costs
         * this capture and nothing else.
         *
         * One capture at a time, and a turn that arrives while one is running sets `again` rather
         * than starting a second. Two concurrent reads of a tree the harness is still writing buy
         * nothing but contention — but *dropping* the later turn would leave the panel showing a
         * state the harness has already moved on from, which is the failure this whole capture
         * exists to remove. Trailing re-run, not trailing discard.
         */
        let capturing = false;
        let again = false;
        let pendingCapture: Promise<void> = Promise.resolve();
        const lastPatch = new Map<string, string>();
        const captureOnce = async (): Promise<void> => {
          const primary = await livePrimary();
          if (!primary || abandoned) return;
          for (const entry of worktreeBindings(primary)) {
            const patterns = patternsFor(entry);
            if (!(await worktreeOps.hasChanges(entry.worktree.path, patterns))) continue;
            const captured = await worktreeOps.diff(entry.worktree.path, patterns);
            const repositoryId = entry.binding.repository.id;
            if (lastPatch.get(repositoryId) === captured.patch) continue;
            lastPatch.set(repositoryId, captured.patch);
            // Through `emit`, not a bare append: the record is redacted, validated and published
            // on the one path every other event takes, so a client watching live and a client that
            // reconnects are shown the same thing (issue #2, AC-5).
            emit({
              kind: "diff",
              diffRef: entry.worktree.branch,
              repositoryId,
              repositoryName: entry.binding.repository.name,
              ...captured,
            });
          }
        };
        const captureTurnDiffs = () => {
          if (abandoned) return;
          if (capturing) {
            again = true;
            return;
          }
          capturing = true;
          pendingCapture = (async () => {
            try {
              do {
                again = false;
                await captureOnce();
              } while (again && !abandoned);
            } catch (cause) {
              captureException(log, cause, { stage: "diff-capture-turn" });
            } finally {
              again = false;
              capturing = false;
            }
          })();
        };

        /**
         * Widgets the harness drew and is still waiting on, by the id this run gave them.
         *
         * The book is per-run and in memory for the same reason the harness registry is: an answer
         * is only deliverable while the process that asked is alive. A run that ends with widgets
         * outstanding leaves them in the log as questions nobody answered, which is exactly what
         * they were.
         */
        const pendingWidgets = new Map<string, Widget>();
        /**
         * The last `task_complete` the harness emitted this round, if it emitted one at all.
         *
         * A holder rather than a bare `let`: the only assignment is inside the output callback, and
         * the compiler cannot see that callback run — it would narrow a `let` to `null` at every
         * read below and refuse the field accesses.
         */
        const completion: {
          widget: Extract<Widget, { kind: "task_complete" }> | null;
          /** Whether the harness asked a decision this round — see `applyingDecisions`. */
          askedDecisions: boolean;
        } = {
          widget: null,
          askedDecisions: false,
        };
        /**
         * Everything the harness *said* this round, in order — its answer to a Workflow branch
         * question is read off the end of it when the widget's summary does not repeat it (see
         * `carryHarnessDecision`). Prose only: reasoning is not a report.
         */
        let assistantText = "";
        const scanner = new WidgetFenceScanner();

        /**
         * Calls that became a `todos` record instead of a `tool_call`, so their result can be
         * dropped when it arrives.
         *
         * Every tool call the CLI reports comes back a moment later as a `tool_result` carrying the
         * same id, and the transcript folds the two together by that id. Swallow only the call and
         * the result has nothing to fold into: the builder treats it as an orphan and draws a row
         * named literally "tool", with Claude Code's "Todos have been modified successfully" as its
         * body — an anonymous version of the contentless row this interception exists to remove,
         * one per plan rewrite. The list already says the call happened and succeeded.
         */
        const todoCalls = new Set<string>();

        /** Emit whatever a chunk of assistant prose turned out to contain. */
        const emitAssistant = (text: string, thinking: boolean) => {
          // Only the model's answer is scanned. Reasoning is a thought about a widget, not a
          // request to draw one, and the operator's own steering is not the harness's to render.
          if (!ctx.widgetsEnabled || thinking) {
            if (!thinking) assistantText += text;
            emit({ kind: "assistant_turn", text, thinking });
            return;
          }
          const out = scanner.push(text);
          assistantText += out.text;
          if (out.text !== "") emit({ kind: "assistant_turn", text: out.text, thinking });
          for (const widget of out.widgets) {
            const widgetId = randomUUID();
            if (widgetExpectsResponse(widget)) pendingWidgets.set(widgetId, widget);
            /*
             * The harness saying how its run ended.
             *
             * Held for the end of the run, because a harness can emit this and then keep working —
             * it is prose, not a tool call, and nothing stops it — so what counts is the last one
             * standing when the run actually ends.
             *
             * *And* written down immediately, which is the part that was missing. The declaration
             * used to reach the Task row only when the harness's process exited, and a harness that
             * declares and then waits for the operator does not exit: a run could sit for eleven
             * minutes having said "changes_ready" with the board still drawing it as working, and
             * no amount of refreshing would have helped — there was nothing to fetch. A later
             * declaration overwrites this one, which is the same "last one standing" rule.
             */
            if (widget.kind === "task_complete") {
              completion.widget = widget;
              const declared = widget;
              // The harness has said it is done. Give it room to say more, then end the round —
              // see `armCompletionStop`.
              armCompletionStop();
              writes = writes
                .then(() =>
                  recordTaskCompletion(db, workspaceId, taskId, {
                    outcome: declared.outcome,
                    summary: declared.summary ?? null,
                    at: new Date().toISOString(),
                  }),
                )
                // The Task's state has not changed, so nothing else will tell the board. This is
                // the announcement that puts the control on the card, live.
                .then(() => announce("running"))
                .catch((cause) =>
                  isMissingParentRow(cause)
                    ? abandon("task-completion-record")
                    : captureException(log, cause, { stage: "task-completion-record" }),
                );
            }
            if (widget.kind === "decision") completion.askedDecisions = true;
            emit({ kind: "widget", widgetId, widget });
          }
        };

        // Launch command and arguments come from the Harness's catalog row (issue #10) — not a
        // global env var, since two Harness Profiles in the same Workspace can point at different
        // catalog entries.
        const { command } = leg.harnessCatalog;
        // Without the flags addressed to SoloW as the ACP client — `opencode acp` refuses `--auto`
        // (`client-directives.ts`); `launchSettingsFor` has already turned it into the runner's.
        const { args } = clientDirectives(
          leg.harnessCatalog.protocol,
          leg.harnessCatalog.argsTemplate,
        );
        // First round with a `--worktree`-capable harness: run in the repository and have it create
        // the Task's worktree. Later rounds continue *inside* that worktree — a reviewer asking
        // for changes wants the work carried on, and asking for the worktree again would branch a
        // fresh one from the base ref and throw the earlier round away. An ACP Task arrives here
        // with `wt` already set to the worktree SoloW provisioned, so it takes the same
        // path from its very first round — as does a Claude Code Task whose primary attachment
        // named a base ref or a branch of its own.
        /*
         * A worktree an earlier round — or an earlier Session — left on disk (history retention,
         * Decision 0025).
         *
         * A relaunch is a new Session, and on a `--worktree` harness it used to start in the
         * repository root and let the harness make a fresh worktree: the earlier one had been
         * removed at approve, and there was nothing to resume into. Now it is still there, and the
         * conversation the harness keyed to it with it, so this round runs *inside* it, exactly as
         * a request-changes round does — `cwd` is the worktree, no `--worktree`, and `--resume`
         * picks the conversation up. Read here, inside the step body, for the reason the resume id
         * below is: a redrive of this round re-executes the body and has to see the row the dying
         * attempt wrote when the harness announced its path. Confirmed with git first, as any path
         * the harness reports would be; a row whose directory is gone is marked so and the round
         * proceeds as a first one.
         */
        if (wt === null) wt = await retainedPrimary();
        const resuming = wt;

        // A Harness Config the run cannot use fails the round by name (Decision 0028), the same
        // way a library Secret that is gone does below — never a run on a configuration guessed at.
        if (!configLaunch.ok) {
          emit({
            kind: "notice",
            text: `The harness config "${harnessConfig?.name}" cannot be used: ${configLaunch.error}. Fix it in Settings → Harness configs, then relaunch.`,
          });
          return { kind: "failed" as const, cls: "fail" as const };
        }
        if (harnessConfig) {
          emit({ kind: "notice", text: `Harness config: ${harnessConfig.name}.` });
        }

        /*
         * What this leg loads from the libraries (spec F24): everything enabled Workspace-wide,
         * plus whatever its Workflow Step names. Resolved *here*, inside the step that spawns
         * the harness, because it decrypts the Secrets an MCP server references — the same
         * point-of-use rule the credential above follows (Principle IV) — and materialized the
         * way this leg's runtime takes it (`materializeLibraries`). A Secret that is gone fails
         * the round by name rather than starting a server without its token.
         */
        const libraries = ctx.librariesEnabled
          ? await loadHarnessLibrariesForRun(db, workspaceId, leg.stepId)
          : { ok: true as const, data: { mcpServers: [], skills: [] } };
        if (!libraries.ok) {
          emit({
            kind: "notice",
            text: `An MCP server in the library references a Secret that no longer exists (${libraries.error}). Fix the server in Settings → MCP servers, then relaunch.`,
          });
          return { kind: "failed" as const, cls: "fail" as const };
        }
        const loaded = await materializeLibraries({
          libraries: libraries.data,
          protocol: leg.harnessCatalog.protocol,
          catalogKey: leg.harnessCatalog.key,
          libraryDir: join(worktreePath(deps.worktreeRoot, taskId), ".solow-libraries"),
          worktreePath: resuming ? resuming.path : null,
        });
        for (const text of loaded.notices) emit({ kind: "notice", text });
        if (loaded.loaded.length > 0) {
          emit({ kind: "notice", text: `Loaded from the libraries: ${loaded.loaded.join(", ")}.` });
        }

        /*
         * The harness conversation this round should carry on, if there is one to carry on.
         *
         * Read **here, inside the step body**, and that placement is the whole of why resume
         * works at all. `step.run` memoizes its *return value*: a read hoisted into a durable step
         * of its own would answer once, on the attempt that had not yet learned the id, and every
         * redrive after that would be handed the journal's `null` — which is precisely the case
         * resume exists for. A step *body* re-executes on a redrive, so this read re-executes with
         * it and sees the id the dying attempt recorded mid-run. Same reasoning as the credential
         * above, arrived at from the other direction.
         */
        /*
         * ...and only when there is a worktree to resume *in*. The conversation is keyed to that
         * directory: asked for from the repository root it is not found, and the round that asked
         * ends as a failed one. A relaunch with no retained worktree (the window passed, or the
         * directory removed by hand) therefore starts from the brief instead, and says so below.
         */
        const resumeSessionId =
          resuming && !resumeLost
            ? await resolveResumeHarnessSessionId(db, workspaceId, taskId, sessionId, leg.stepId)
            : null;

        /*
         * The point in another Task's transcript this Task was split at (issue #56, AC-3).
         *
         * Carried as a reading of that transcript inside the brief, for every protocol and every
         * Executor. Branching the parent's *conversation* instead is not available here: each
         * Task's harness runs against its own app-owned home (Decision 0027), which is where a
         * CLI keeps its conversations, so the parent's is not there for the child to open — and a
         * container's dies with it. The transcript is the durable record of the same history,
         * and the cursor's hash proves it is the history the Owner split from.
         *
         * Only the full brief carries it. A round continuing its *own* conversation already has
         * the context in it, put there by the round that opened it.
         *
         * Read inside the step body for `resolveResumeHarnessSessionId`'s reason: a redrive has to
         * see the world as it is now, not as the journal recorded it on the attempt that failed.
         */
        const fork = await loadForkOrigin(db, workspaceId, ctx.task);
        let forkOrigin = fork.kind === "ok" ? fork.origin : null;
        if (fork.kind === "stale") {
          // Refused rather than started without it, and on every round: a transcript that no
          // longer hashes to the cursor is evidence something rewrote history, and a run that
          // quietly carried on would produce work the reviewer cannot tell apart from work that
          // started where the Owner said (AC-4).
          emit({
            kind: "notice",
            text: "This task was split from a point in another task's transcript, and that transcript has changed since — the fork point no longer means what it meant. Nothing has been started. Split the sub-task again from the parent's current transcript.",
          });
          return { kind: "failed" as const, cls: "fail" as const };
        }
        if (fork.kind === "missing") {
          if (!(await hasEarlierSession(db, workspaceId, taskId, sessionId))) {
            emit({
              kind: "notice",
              text: "This task was split from a point in another task's transcript, and that point no longer exists — the parent's session has been deleted. Nothing has been started.",
            });
            return { kind: "failed" as const, cls: "fail" as const };
          }
          // It has run before, so it was handed that context already; what it has done since is
          // its own work. Said, so a reviewer knows this round's brief is shorter than the last.
          emit({
            kind: "notice",
            text: "The parent task's session has been deleted since this task was split from it, so this round is briefed without the parent's transcript.",
          });
          forkOrigin = null;
        }
        const forkSection = forkOrigin
          ? {
              title: forkOrigin.parentTitle,
              seq: forkOrigin.cursor.seq,
              digest: renderForkDigest(forkOrigin.events),
            }
          : undefined;

        /*
         * Two briefs, because the round has to commit to one before it can know which is right.
         *
         * `prompt` is a start option; `resumed` is only knowable after the handshake. Asking is
         * not getting — an ACP agent that never advertised `loadSession` starts a new session
         * rather than failing the round — so the round briefs on what it *asked for* and corrects
         * on what it *got*, below. `fullBrief` is exactly today's brief, byte for byte, and is
         * what a round with nothing to resume sends.
         */
        const stepSection =
          leg.stepBrief !== null && leg.stepName !== null
            ? { name: leg.stepName, brief: leg.stepBrief }
            : undefined;
        const fullBrief = harnessBrief(
          ctx,
          pendingFeedback,
          briefWorkspaces(ctx, primaryBinding, wt, provisionedByAttachment),
          stepSection,
          undefined,
          forkSection,
          applyingDecisions ?? undefined,
        );
        const brief = resumeSessionId
          ? harnessBrief(
              ctx,
              pendingFeedback,
              [],
              stepSection,
              continuation ? "turn_budget" : "interruption",
              undefined,
              applyingDecisions ?? undefined,
            )
          : fullBrief;

        const handle = runner.start({
          command,
          args: [...args, ...loaded.extraArgs],
          cwd: resuming ? resuming.path : repoPath,
          env: shaped.data,
          worktreeName: resuming ? null : worktreeNameForTask(taskId),
          ...(resumeSessionId ? { resumeSessionId } : {}),
          prompt: brief,
          ...(loaded.mcpServers.length > 0 ? { mcpServers: loaded.mcpServers } : {}),
          ...(configLaunch.data.settings ? { harnessSettings: configLaunch.data.settings } : {}),
          onEvent: (e) => {
            // The harness's channel decides what kind of record this is. `user` is the operator's
            // own steering echoed back, `system` is the machinery talking about itself, and the
            // rest is the model — the distinction the log could not previously make at all.
            if (e.kind === "stdout") {
              if (e.channel === "assistant" || e.channel === "thinking") {
                emitAssistant(e.text, e.channel === "thinking");
              } else emit(textPayload(e.channel, e.text));
            } else if (e.kind === "tool_use") {
              // `TodoWrite` is recorded as the list it carried, in place of the call itself.
              //
              // The allowlist admits none of its arguments — a todo list is an array of objects
              // and `tool_call.input` is bounded to a flat map of short strings — so the row this
              // would otherwise write says "tool: TodoWrite" and nothing else: a contentless line
              // in the transcript, with the harness's plan discarded alongside it. Emitting the list
              // instead removes that row and is the only path by which the plan survives at all.
              //
              // Only a payload that reads as a todo list takes this branch. Anything else falls
              // through to the tool call it always was, because the rule in this file is that an
              // emission which cannot be understood still reaches the transcript as *something*.
              const todos = e.name === "TodoWrite" ? readTodoWrite(e.input) : null;
              if (todos) {
                if (e.callId) todoCalls.add(e.callId);
                emit({ kind: "todos", items: todos });
                return;
              }
              emit({
                kind: "tool_call",
                name: e.name,
                callId: e.callId,
                // Narrowed here, once, rather than in each adapter: the allowlist is policy and
                // must hold for every protocol that reaches this point. It runs *before*
                // `redactPayload`, never instead of it — an allowlisted argument can still have a
                // credential echoed into it, and the redaction walk covers the new field for free.
                input: allowlistToolInput(e.name, e.input),
                status: toolStatus(e.status),
              });
            } else if (e.kind === "tool_result") {
              if (e.callId !== null && todoCalls.has(e.callId)) return;
              const { output, truncated } = truncateToolOutput(e.output);
              emit({ kind: "tool_result", callId: e.callId, ok: e.ok, output, truncated });
            } else if (e.kind === "permission_request") {
              emit({
                kind: "permission_request",
                requestId: e.requestId,
                title: e.title,
                toolKind: e.toolKind,
                options: e.options,
              });
            } else if (e.kind === "permission_resolved") {
              emit({
                kind: "permission_resolved",
                requestId: e.requestId,
                optionId: e.optionId,
                decidedBy: e.decidedBy,
              });
            } else if (e.kind === "capabilities") {
              /*
               * Cache what the harness advertised (issue #94 AC-2), on the same fire-and-forget
               * chain as the completion record: the run must not fail because its narration did
               * not land, and a capability list is narration — the fallback a Settings form reads
               * between runs, never something this run depends on.
               */
              const advertised = { models: e.models, modes: e.modes };
              writes = writes
                .then(() =>
                  // The catalog row of the harness that advertised them — the Step's under a
                  // Workflow. Writing one harness's advertised models over another's cache is how
                  // the Settings pickers start suggesting models the harness cannot run.
                  updateHarnessCatalogCapabilities(
                    db,
                    workspaceId,
                    leg.harnessCatalog.id,
                    advertised,
                  ),
                )
                .catch((cause) => captureException(log, cause, { stage: "capabilities-cache" }));
            } else recordUsage(e);
          },
        });
        live = handle;
        // Hand the reported path to the turn capture the moment the harness states it — the capture
        // is already running by now, waiting on exactly this.
        void handle.workspacePath.then(announcePath, () => announcePath(null));
        // And the harness's own conversation id, the moment *it* is known — on the narration
        // chain, so a run must not fail because its bookkeeping did not land, and before the run
        // ends, because a run that dies is the one whose id is worth having (`recordHarnessSessionId`).
        void handle.harnessSessionId.then(
          (id) => {
            if (!id) return;
            writes = writes
              .then(() => recordHarnessSessionId(db, workspaceId, sessionId, id, roundStepId))
              .catch((cause) =>
                isMissingParentRow(cause)
                  ? abandon("harness-session-record")
                  : captureException(log, cause, { stage: "harness-session-record" }),
              );
          },
          () => {},
        );

        /*
         * What the resume actually did — written into the log either way.
         *
         * The two outcomes are not interchangeable. One round is a harness carrying on a
         * conversation it remembers; the other is a fresh harness that has just been handed the
         * whole brief in a worktree already holding somebody's work. A reviewer reading the
         * transcript afterwards has to be able to tell which they are looking at, and a recovery
         * that silently changed what the harness knows is exactly the invisible behaviour this
         * file refuses everywhere else.
         *
         * Awaited rather than chained, because the answer decides what this harness is told next.
         * Every runner resolves it, including on the paths where the handshake failed, and a
         * runner that omits the member reads as `false` — the honest answer for a protocol with no
         * conversation to load.
         */
        if (resumeSessionId) {
          const resumed = (await handle.resumed) ?? false;
          if (resumed) {
            emit({
              kind: "notice",
              text: continuation
                ? "Continued the previous conversation: the harness had reached its budget with work still to do, so it picked up where it left off rather than starting over."
                : "Continued the previous conversation: this round re-attached to the harness session the last one was having, so nothing it had already worked out was lost.",
            });
          } else {
            /*
             * The brief this round committed to at start turned out to be the wrong one, and the
             * only correction available is the next turn — `prompt` was spent. That is the same
             * channel an operator's steering takes, so it reaches the harness as a message rather
             * than as a second launch.
             *
             * A refusal is possible and is said rather than swallowed: a protocol with no
             * steering channel is also one that reports no conversation id, so it should never
             * have been handed a resume in the first place — and if it was, the operator is told
             * what the harness is actually working from instead of being left to infer it from a
             * round that produced nothing.
             */
            const delivered = await handle.send(fullBrief);
            emit({
              kind: "notice",
              text: delivered
                ? "Could not continue the previous conversation; the harness started from the brief instead, which was re-sent in full."
                : "Could not continue the previous conversation, and this harness would not accept the brief as a follow-up turn — it is working from a continuation instruction alone. Expect little from this round.",
            });
          }
        }

        // Publish the handle for the lifetime of the run so the hub can deliver the operator's
        // input or stop to *this* harness (TASK-022), and withdraw it the moment the run ends.
        const deregister = deps.registry.register(workspaceId, {
          taskId,
          sessionId,
          handle,
          /**
           * Answer one of this run's widgets: validate against the widget that asked, record the
           * answer in the log, then tell the harness in a line it can read. The harness is not blocked
           * on this — a fenced widget is prose, not a tool call — so the answer arrives as steering,
           * which is the same channel an operator types into.
           */
          respondWidget: async (response) => {
            const widget = pendingWidgets.get(response.widgetId);
            if (!widget) return "not_pending";
            const invalid = validateWidgetResponse(widget, response);
            if (invalid) return "option_unknown";

            pendingWidgets.delete(response.widgetId);
            emit({
              kind: "widget_response",
              widgetId: response.widgetId,
              values: response.values,
              text: response.text ?? null,
            });
            await handle.send(widgetAnswerMessage(widget, response));
            return "answered";
          },
        });
        let outcome: Awaited<typeof handle.outcome>;
        let reported: string | null = null;
        try {
          // Learn where the harness went as soon as it says so, before waiting on the run: if the
          // harness dies mid-run we still know which worktree to clean up.
          reported = await handle.workspacePath;
          // ...and, on the first round, use that same moment to copy the Repository's setup files
          // in. A harness announces its worktree before the model's first turn, so this is the
          // earliest point at which the directory exists — and, in practice, before the harness has
          // looked at it. A later round skips it, and so does a run a review decision started:
          // the files are already there, and re-copying would overwrite what the harness changed.
          if (round === 0 && !decidedReview && reported) await seed(reported);
          /*
           * Write the worktree down the moment the harness names it, not only after the round
           * (`record-worktree-${round}`). A round that dies mid-run — a restart, an exhausted
           * execution budget — is redriven, and the redrive can only carry the conversation on by
           * running in this directory; without the row it would not know it exists. Best effort:
           * a write that fails costs the resume, not the round.
           */
          if (reported && !wt) {
            try {
              const live = await livePrimary();
              if (live) {
                await recordWorktree(db, workspaceId, {
                  taskId,
                  repositoryId: primaryBinding.repository.id,
                  path: live.path,
                  branch: live.branch,
                });
              }
            } catch (cause) {
              captureException(log, cause, { stage: "worktree-record-live" });
            }
          }
          outcome = await handle.outcome;
        } finally {
          disarmCompletionStop();
          deregister();
          // Drain an in-flight turn capture first: it appends through `emit`, so a capture still
          // running would otherwise chain its write on after the drain below had already passed.
          await pendingCapture;
          // Drain queued log and usage writes even when the run threw. Usage in particular
          // cannot be re-obtained — the harness reports it once — so abandoning the chain on a
          // mid-turn failure would lose it permanently rather than merely delay it.
          await writes;
        }

        // Reported before the worktree is adopted, on purpose: everything below this line writes
        // to rows that no longer exist (compaction, the state transition, the captured diff), so
        // continuing would turn one deleted Task into a failing step and a retried run.
        if (abandoned) return { kind: "abandoned" as const };

        // A `--resume` the harness could not honour ends the process before it reports a
        // workspace, so this has to be read before adoption — which would otherwise turn "the
        // conversation is gone" into "the harness reported no worktree" and file it as a failure.
        if (outcome.kind === "failed" && outcome.signal.resumeLost) {
          return { kind: "resume-lost" as const };
        }

        // Confirm with git that the reported path really is a worktree of this repository. An
        // harness working somewhere else has not been isolated, and committing from wherever it
        // happened to point would be worse than failing (Principle II). A resuming round is
        // re-checked too: the worktree could have been removed underneath us between rounds.
        let adopted: Worktree;
        try {
          adopted = await repoAdmin.adopt(repoPath, reported);
        } catch (cause) {
          captureException(log, cause, { stage: "worktree-adopt", reported });
          return { kind: "failed" as const, cls: "fail" as const };
        }

        if (outcome.kind === "failed") {
          return {
            kind: "failed" as const,
            cls: classifyRunFailure(outcome.signal),
            worktree: adopted,
            stopReason: outcome.stopReason,
            ...(outcome.signal.verdict ? { verdict: outcome.signal.verdict } : {}),
          };
        }
        // Across every worktree, not just the primary: a round that only touched a secondary
        // repository still produced work, and answering "did anything change" from one directory
        // would call that round empty.
        let changed = false;
        for (const entry of worktreeBindings(adopted)) {
          if (await worktreeOps.hasChanges(entry.worktree.path, patternsFor(entry))) {
            changed = true;
            break;
          }
        }

        /*
         * The harness finished — written down here, inside the step that learned it, and not two
         * steps later when the Task is moved to review.
         *
         * That gap is a bug with a Failed column full of evidence for it. Completion used to exist
         * only as this function's return value: real, in memory, and recorded nowhere. Anything
         * that lost the run before `to-review` committed — a restart, a `bun --hot` reload, an
         * engine that dropped an in-flight run — left no trace that the harness had ever finished, so
         * the reclaim sweep found a `running` Task with no harness, could not tell "died mid-work"
         * from "died having finished", and marked it `failed`. Work that was done and committed
         * ended up filed as a failure.
         *
         * A durable row before the fragile part is the whole fix. It carries the branch because
         * that is what the review gate opens, and whatever the harness said about stopping, because
         * that is the only thing here it could have told us itself.
         */
        // The widget's summary, with a branch answer the harness wrote in its final message
        // carried in when the summary has none — this is what the next Step is briefed with.
        // The widget's own `decision` field outranks anything read off prose — see
        // `carryHarnessDecision`.
        // …and its answer to an `agent-decides` gate's "does this need a review?", carried the same
        // way, so the gate reads one `REVIEW:` line whichever channel the answer came on.
        const summary = carryHarnessReview(
          carryHarnessDecision(
            completion.widget?.summary ?? null,
            assistantText,
            completion.widget?.decision ?? null,
          ),
          assistantText,
          completion.widget?.review ?? null,
        );
        emit({
          kind: "agent_done",
          changed,
          branch: adopted.branch,
          ...(completion.widget ? { outcome: completion.widget.outcome } : {}),
          ...(summary ? { summary } : {}),
          // Why the *process* stopped, beside what the harness *said* — the two can disagree, and
          // a declared `changes_ready` under a `max_turns` is exactly the disagreement worth
          // keeping (`harnessStopReasonSchema`).
          stopReason: outcome.stopReason,
        });

        return {
          kind: "completed" as const,
          changed,
          worktree: adopted,
          outcome: completion.widget?.outcome ?? null,
          summary,
          stopReason: outcome.stopReason,
          askedDecisions: completion.askedDecisions,
        };
      });

      // Compaction at a turn boundary (issue #2, AC-3). A long run gets a summary standing in for
      // a closed range of its log; the events in that range are not touched, deleted or rewritten,
      // so replay still reproduces the full history and the review gate keeps its evidence (AC-2,
      // Principle I). The unique `(session_id, from_seq)` index makes a replayed durable step a
      // no-op rather than a duplicate (Principle III).
      await step.run(`compact-${round}`, () => compactSession(db, workspaceId, sessionId));

      if (run.worktree) {
        wt = run.worktree;
        // The audit line binding a worktree to its Task (Principle IV) is emitted on adoption,
        // because that is the first moment SoloW knows which directory the harness used.
        logWorktreeBinding(log, { workspaceId, taskId, worktreePath: run.worktree.path });
        // And the row saying the same thing, for everything that has to answer "does this Task
        // still hold a working copy" without a filesystem to look at — the delete preview and the
        // Issue view both ask, and both read this table. Its own step, so it survives a restart
        // between the run and the gate; idempotent, so a retried round does not double it.
        const adoptedPrimary = run.worktree;
        await step.run(`record-worktree-${round}`, () =>
          recordWorktree(db, workspaceId, {
            taskId,
            repositoryId: primaryBinding.repository.id,
            path: adoptedPrimary.path,
            branch: adoptedPrimary.branch,
          }),
        );
      }

      if (run.kind === "abandoned") {
        // Nothing to record and nothing to review: the Task this run belonged to is gone. The
        // worktree is deliberately left where it is — the delete path owns tearing that down, and
        // guessing at it from a run that has already lost its context is how a directory someone
        // else adopted gets removed.
        return { taskId, result: "abandoned" };
      }

      if (run.kind === "resume-lost") {
        /*
         * The conversation this round tried to carry on is gone. Once: the ids are forgotten, the
         * operator is told, and the same round is run again from the brief in the same worktree.
         * A second such failure means something else is wrong, and is filed as one.
         */
        if (resumeLost) {
          return await failRun(scope, `resume-lost-twice-${round}`, "fail", leg.stepId, "running");
        }
        resumeLost = true;
        resumeLostRetry = true;
        await step.run(`resume-lost-${round}`, async () => {
          await forgetHarnessConversations(db, workspaceId, taskId);
          const payload: SessionEventPayload = {
            kind: "notice",
            text: "The previous conversation could not be found, so this run is starting again from the brief in the same worktree.",
          };
          const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq,
            workflowStepId: leg.stepId,
            payload,
          });
          const frame = toTaskEvent(payload, taskId, sessionId, seq, leg.stepId);
          if (frame) deps.hub.publish(channel, frame);
        });
        continue;
      }
      if (run.kind === "failed") {
        if (run.cls === "park") {
          await parkRound(scope, round, leg.stepId);
          continue;
        }
        // credential_expired or hard failure: pause/stop with the reason preserved. A verdict the
        // transport put in words (a harness below its catalog pin) is the reason itself — "fail"
        // would leave the operator guessing what to upgrade.
        const reason = ("verdict" in run && run.verdict) || run.cls;
        await failRound(scope, round, reason, leg.stepId);
        return { taskId, result: run.cls };
      }

      /*
       * The harness ran out; it did not finish. So the run gives it more rather than presenting a
       * half-done change to a reviewer as "changes ready".
       *
       * Both halves of the condition carry weight. `stopReasonMeansTruncated` is the *process*
       * saying it hit a turn or token budget with work still to do; `run.outcome === null` is the
       * *harness* never having declared a `task_complete`. A harness that declared and then hit a
       * budget has said what it thinks it did, and that declaration belongs to the operator —
       * only a round that ran out with nothing to say for itself is one this run may continue on
       * its own authority. That pairing is the disagreement `agent_done` records and this is the
       * one place that acts on it.
       *
       * Nothing is recorded and nothing moves: no completion row, no `awaiting_review`, no
       * gate. The Task stays `running`, the worktrees stay where they are, and the next
       * round picks the same conversation back up — `harness_session_id` was written mid-run by
       * the round that just stopped, so `resolveResumeHarnessSessionId` finds it with no extra
       * plumbing and the brief becomes "carry straight on" rather than the whole thing again.
       */
      if (stopReasonMeansTruncated(run.stopReason) && run.outcome === null) {
        const spent = autoContinues >= MAX_AUTO_CONTINUE_ROUNDS;
        // The word the harness would use for what it ran out of. `max_tokens` is a full context,
        // not a spent turn allowance, and telling an operator the wrong one sends them looking at
        // the wrong setting.
        const budget = run.stopReason === "max_tokens" ? "context budget" : "turn budget";
        /*
         * One step id for both outcomes, because exactly one of them fires per round — which is
         * what keeps the `agent-run-N` / `auto-continue-N` / `to-review-N` sequence identical on
         * every replay of the same history. Published as well as appended: an operator watching
         * live must see "the harness hit its budget; continuing" at the moment it happens, not a
         * mysterious second round with the explanation waiting for them on a reconnect.
         */
        await step.run(`auto-continue-${round}`, async () => {
          const payload: SessionEventPayload = {
            kind: "notice",
            text: spent
              ? `The harness hit its ${budget} again after ${MAX_AUTO_CONTINUE_ROUNDS} continuations. This run has stopped continuing it and is putting the work in front of you as it stands — it is unfinished, whatever the summary says.`
              : `The harness hit its ${budget} with work still to do, so this run is continuing the same conversation instead of sending it for review (continuation ${autoContinues + 1} of ${MAX_AUTO_CONTINUE_ROUNDS}).`,
          };
          const seq = await nextSessionEventSeq(db, workspaceId, sessionId);
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq,
            workflowStepId: leg.stepId,
            payload,
          });
          const frame = toTaskEvent(payload, taskId, sessionId, seq, leg.stepId);
          if (frame) deps.hub.publish(channel, frame);
        });
        if (!spent) {
          autoContinues += 1;
          continuingTruncated = true;
          continue;
        }
        // Budget spent: fall through to exactly the path a finished round takes. Never a throw and
        // never a stall — the operator gets the work, the declaration `to-review` writes for it,
        // and the notice above saying why it is only this far along (a legible outcome they can
        // act on: approve what is there, or send it back for another five rounds of their own).
      }
      // Whatever happens below, this stretch of work is over. The next one that runs out of budget
      // starts with its own continuations rather than the remains of this one's.
      autoContinues = 0;

      /*
       * The harness has finished. It does not follow that the Task is in review.
       *
       * This step used to move it there itself, which made the review gate something that happened
       * *to* an operator rather than something they opened — and made "the harness stopped" and "the
       * work is ready" the same event, which they are not: a harness stops when it runs out of
       * things to do, when it runs out of context, and when it decides the brief was already
       * satisfied. Only one of those is worth a person's attention, and only the harness knows which.
       *
       * So the run records the declaration and the change, and stops. The Task stays where it is,
       * the board shows it as finished, and the transition into `review` is the operator's click —
       * one action, theirs (Principle I is a gate for a human to open, not a conveyor).
       */
      const worktree = run.worktree;
      const gate = worktreeBindings(worktree);
      await step.run(`to-review-${round}`, async () => {
        await recordTaskCompletion(db, workspaceId, taskId, {
          // `changes_ready` when the harness said nothing: it stopped having produced a run, and the
          // conservative reading is the one that puts the work in front of a person rather than
          // the one that quietly files it as "nothing to see".
          outcome: run.outcome ?? "changes_ready",
          summary: run.summary ?? null,
          at: new Date().toISOString(),
        });
        await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
          diffRef: worktree.branch,
        });

        // Capture the change now, while the worktrees still exist: approving removes them, and a
        // reviewer looking at a finished Task should still be able to see what they approved.
        // A capture failure must not block the review gate — the branch name alone is enough to
        // decide on, so this degrades to "no diff shown" rather than stalling the Task.
        //
        // One event per worktree, each naming its Repository (issue #7 AC-4). A Task spanning two
        // repositories produces two changes on two branches, and a reviewer shown one flat file
        // list could not tell which repository a path came from. One repository failing to capture
        // costs only its own group, not the others'.
        for (const entry of gate) {
          try {
            const captured = await worktreeOps.diff(entry.worktree.path, patternsFor(entry));
            await appendSessionEvent(db, workspaceId, {
              sessionId,
              seq: await nextSessionEventSeq(db, workspaceId, sessionId),
              workflowStepId: leg.stepId,
              payload: {
                kind: "diff",
                diffRef: entry.worktree.branch,
                repositoryId: entry.binding.repository.id,
                repositoryName: entry.binding.repository.name,
                ...captured,
              },
            });
          } catch (cause) {
            captureException(log, cause, { stage: "diff-capture" });
          }
        }

        deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: worktree.branch });
      });
      // The board still has to hear about it — the card's "finished" control appears on this, and
      // the Task's state has not changed to carry the news for it.
      announce("running");

      /*
       * The harness has finished, and on an `agent-signal` Step that is the signal the Step
       * advances on (AC-2). Reported here, and the placement is load-bearing:
       *
       * **After `to-review-${round}`, never before it.** `to-review` is what writes the `diff`
       * session events, and `taskHasRecordedChanges` corroborates the `producedChanges` claim
       * against exactly those events. Move this call above it and the corroborating scan finds
       * nothing, so an `auto-unless-changes` gate opens on the harness's unverified word about its
       * own output — which is the party the gate exists to catch.
       *
       * **Before the gate,** because an `auto` Step must not need a human at all.
       */
      /*
       * The round that applied a reviewer's decisions has ended: spend the approval it was started
       * by, and move on — unless there is a reason a person has to look again first.
       *
       * Three reasons, each a gate reopened on the same Step rather than an advance:
       *
       * - The harness asked new decisions while applying the old ones. Those are as unconfirmed
       *   as the first ones were, and confirming them is the whole point of the gate.
       * - The harness gave up (`blocked`). There is nothing finished to move on from.
       * - This Step can end the Workflow. Ending it integrates, and integration happens only on an
       *   approval of the work being integrated (Principle I) — this round's work has not been
       *   seen by anyone yet. One more click on the last Step is the price of never committing a
       *   change nobody looked at.
       *
       * `holdForReview` keeps the `agent-signal` advance below from spending the same approval in
       * any of those cases: the decision row the reviewer wrote is still unspent until the cursor
       * moves, so that call would otherwise carry the Step past the gate this block just kept.
       */
      let holdForReview = false;
      if (applyingDecisions !== null) {
        const settled = applyingDecisions;
        applyingDecisions = null;
        const stepId = leg.stepId;
        const canEnd = !wf || !stepId || stepCanEndWorkflow(wf.steps, stepId);
        const reopenBecause = reopenAfterApplyingDecisions({
          askedDecisions: run.askedDecisions,
          outcome: run.outcome,
          canEnd,
        });
        if (wf && stepId && leg.advanceOn && run.outcome !== "blocked" && reopenBecause === null) {
          // What the next Step is briefed with: this round's summary — the work *after* the
          // answers — and the answers themselves, so it is told what was settled either way.
          const carried = handoffWith(run.summary, settled);
          const reported = await reportStepFinished(
            scope,
            wf,
            `workflow-applied-${round}`,
            `workflow-recheck-applied-${round}`,
            {
              fromStepId: stepId,
              signal: leg.advanceOn,
              producedChanges: run.outcome === "changes_ready",
              ...(carried ? { handoff: carried } : {}),
              ...(run.outcome ? { outcome: run.outcome } : {}),
            },
          );
          if (reported.kind === "failed") {
            return await failRun(
              scope,
              `workflow-advance-failed-${round}`,
              "workflow_advance_failed",
              stepId,
              "running",
            );
          }
          if (reported.kind === "advanced") {
            const terminal = await takeAdvance(scope, transition, loop, round, reported);
            if (terminal) return terminal;
            continue;
          }
          // Not advanced by the Step's own rule (`held`, `awaiting-decision`): the gate below
          // opens, which is the conservative reading — nothing moves on without a decision.
          holdForReview = true;
        } else {
          holdForReview = true;
          if (reopenBecause !== null && stepId) {
            await step.run(`decisions-reopened-${round}`, async () => {
              await appendSessionEvent(db, workspaceId, {
                sessionId,
                seq: await nextSessionEventSeq(db, workspaceId, sessionId),
                workflowStepId: stepId,
                payload: {
                  kind: "notice",
                  text:
                    reopenBecause === "new-decisions"
                      ? "Applying your decisions raised new ones. Confirm them, then approve again to move on."
                      : "Your decisions are applied. This step can end the workflow, so nothing is integrated until you approve the result.",
                },
              });
            });
          }
        }
      }

      if (wf && leg.advanceOn === "agent-signal" && leg.stepId && !holdForReview) {
        const reported = await reportStepFinished(
          scope,
          wf,
          `workflow-signal-${round}`,
          `workflow-recheck-${round}`,
          {
            fromStepId: leg.stepId,
            signal: "agent-signal",
            producedChanges: run.outcome === "changes_ready",
            ...(run.summary ? { handoff: run.summary } : {}),
            ...(run.outcome ? { outcome: run.outcome } : {}),
          },
        );
        if (reported.kind === "failed") {
          return await failRun(
            scope,
            `workflow-advance-failed-${round}`,
            "workflow_advance_failed",
            leg.stepId,
            "running",
          );
        }
        if (reported.kind === "advanced") {
          const terminal = await takeAdvance(scope, transition, loop, round, reported);
          if (terminal) return terminal;
          continue;
        }
        /*
         * `completed` here means the *last* Step signalled and an unspent approval was found —
         * and it deliberately does not integrate. Integration keeps exactly one home in this
         * file, inside `decision-approve`, reachable only from a run started by an `approve`
         * decision. Falling through to the gate costs one extra approval in a rare state, which
         * is stricter than Principle I requires and never looser.
         *
         * `awaiting-decision` and `held` fall through for the ordinary reason: the cursor did not
         * move and a person has to look. The Step's summary is parked in
         * `workflow_pending_handoff`, which is the column's whole purpose — the run that
         * applies the decision is a different run, and has only the database to read them from.
         */
      }

      /*
       * Under a Workflow, the run opens the gate itself (F03 FR-10: "when a Run reaches a Gate, it
       * pauses and requests the required human decision").
       *
       * The rule above — the transition into `review` is the operator's click — is about a Task
       * on no Workflow, where "the harness stopped" and "someone should look" are different facts
       * and only the person can tell which. Here they are the same fact: the only way past this
       * point is a decision, so a Task left `running` with an "Open review" button is a
       * gate the person has to open before they can answer it. A plan-first Step showed the cost
       * in full — its harness declares `nothing_to_do` every time, and the operator was left
       * looking at "Finished — nothing to do" with the Approve they needed one click further away.
       *
       * Not for a harness that gave up: `blocked` has not reached the gate, and a review over an
       * abandoned run asks a person to sign off on nothing — the same line `canOpenReview` draws.
       * Idempotent on a redrive: `setTaskState` writes the same value and `recordTransition`
       * drops an identical adjacent transition.
       *
       * `failureReason: null` because a gate this run has just opened is a live one — whatever an
       * earlier round left on the row is overtaken. Kept, a `review_decision_not_applied` from
       * before a Retry made this gate read as dead: the page offered Retry instead of Approve.
       */
      if (wf && leg.stepId && run.outcome !== "blocked") {
        const stepId = leg.stepId;
        await step.run(`open-gate-${round}`, async () => {
          await setTaskState(db, workspaceId, taskId, "review", { failureReason: null });
          await recordTransition("running", "review", stepId);
        });
        logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });
        announce("review");
      }

      /*
       * The gate is open, and the run ends here.
       *
       * The decision is not waited for. It is a row someone writes later, and `review.decide`
       * starts the next run with it (see `launchData`); that run applies it before anything else.
       * Ending is what makes a decision impossible to lose: there is no parked run to go missing,
       * and the executor this run holds is released instead of sitting idle behind a person.
       */
      return { taskId, result: "awaiting_review" };
    }

    /*
     * The worktrees are deliberately left where they are (History retention, Decision 0025).
     *
     * This is where the lifecycle used to remove every worktree the Task was given and mark the
     * rows — the tidy ending. It was also the end of the conversation: Claude Code keys a
     * transcript to the directory it ran in, so a Task reopened from History had nowhere to
     * resume into and started again from the brief. The directories now stay for the retention
     * window and the sweep in `retention.ts` removes them, whichever executor made them — the
     * container is disposed below regardless; a Task's private clone on the host is what the
     * next round resumes in.
     *
     * Reached only when the rounds ran out without the harness ever reaching a gate — every
     * other way out of the loop returns. That is a run going round in circles, and it is said
     * rather than reported as `done` over a Task nobody has looked at.
     */
    return await failRun(
      scope,
      "rounds-exhausted",
      "round_budget_exhausted",
      leg.stepId,
      "running",
    );
  } finally {
    /*
     * Tear the execution host down on the way out (issue #96).
     *
     * A `finally` around the whole body rather than a call before each `return`: the lifecycle
     * has ten terminal returns below this point, and per-return disposal is a list nobody keeps
     * complete — the one that gets forgotten is the one that leaks a container.
     *
     * **Not** a `step.run`: a durable dispose is memoized, so the retry that has just rebuilt the
     * container would replay the teardown as already-done and leak the one it is holding. Not
     * durable in any other sense either — Inngest suspends by leaving a step's promise pending
     * and never unwinds this body, so a run cancelled between steps never reaches here at all.
     * That is what the labelled reaper in `executor/reap.ts` is for; this is the fast path, not
     * the net.
     *
     * Swallowed because teardown must not fail a Task that otherwise completed, and a no-op for
     * the local driver, which has nothing to dispose of.
     */
    await executor.dispose().catch((cause) => {
      captureException(log, cause, { stage: "executor-dispose" });
    });
  }
}

/**
 * The other repositories the harness has been given, as absolute paths it can `cd` into.
 *
 * The harness runs in exactly one working directory, so this is the *only* way it learns that a
 * second repository is part of its Task at all (issue #7, the stated limitation). The primary's
 * path is unknown on the first round of a `--worktree` protocol — the harness has not created it
 * yet — which is why it is nullable rather than always present.
 */
function briefWorkspaces(
  ctx: TaskRunContext,
  primaryBinding: TaskRepositoryBinding,
  primaryWorktree: Worktree | null,
  provisioned: ReadonlyMap<string, Worktree>,
): BriefWorkspace[] {
  return ctx.repositories.map((binding) => {
    const worktree =
      binding === primaryBinding ? primaryWorktree : provisioned.get(binding.attachment.id);
    return {
      repositoryName: binding.repository.name,
      // The branch the harness will actually find itself on. A worktree SoloW provisioned is
      // on the attachment's branch by construction, and one that does not exist yet will be —
      // but a worktree the harness made for itself is on a branch it named (`solow-task-<id>`,
      // not `solow/task-<id>`), which is only knowable once git has been asked. Until then
      // the brief says nothing rather than naming a branch that does not exist: the brief is the
      // *only* mechanism by which a multi-repository harness learns its own layout, so a wrong
      // line in it is worse than a missing one.
      branch:
        worktree?.branch ?? (binding === primaryBinding ? null : binding.attachment.checkoutBranch),
      path: worktree?.path ?? null,
      primary: binding === primaryBinding,
    };
  });
}

/** One repository as the brief describes it. */
export interface BriefWorkspace {
  repositoryName: string;
  /** The branch git reports for the worktree, or null while nothing can say what it will be. */
  branch: string | null;
  /** Absolute path of the worktree, or null while it does not exist yet. */
  path: string | null;
  /** True for the one the harness process is started in. */
  primary: boolean;
}

/**
 * What the harness is told when someone answers its widget.
 *
 * Labels first, ids after: the model wrote the labels and reasons in them, while the ids are how
 * this build refers to the same options — so the sentence leads with what it recognises and
 * keeps the machine-readable form for precision. `rank` answers keep the operator's ordering,
 * which is the entire content of that answer.
 */
export function widgetAnswerMessage(widget: Widget, response: WidgetResponse): string {
  const byId = new Map(widgetOptions(widget).map((o) => [o.id, o.label]));
  const chosen = response.values.map((id) => byId.get(id) ?? id);
  const asked = widget.kind === "ask_user_input" ? widget.prompt : (widgetTitle(widget) ?? "");

  // Labels first, ids after: the model wrote the labels and its reasons live in them, while the
  // ids are how it referred to the same options. The question is quoted back because a harness can
  // have more than one widget outstanding, and it is the only reference *the harness itself*
  // recognises — this build's own widget id was generated after the emission and the harness has
  // never seen it, so naming it here told nobody anything.
  const parts = [WIDGET_ANSWER_PREFIX];
  parts.push(
    asked ? `The operator answered "${asked}":` : "The operator answered your widget:",
    chosen.length > 0 ? chosen.join(", ") : "(nothing chosen)",
  );
  if (response.values.length > 0) parts.push(`(ids: ${response.values.join(", ")})`);
  if (response.text?.trim()) parts.push(`They also wrote: ${response.text.trim()}`);
  return parts.join(" ");
}

/** The heading a widget carries, for the ones that have one. */
function widgetTitle(widget: Widget): string | undefined {
  return "title" in widget ? widget.title : undefined;
}

/**
 * Why a round is carrying on a conversation the harness already has, rather than opening one.
 *
 *  - `interruption` — the process was lost and re-attached: an orchestrator restart, an Inngest
 *    redrive, an exhausted execution budget, a reclaim. The conversation survived; the process
 *    did not, and the harness has no way of knowing that from the inside.
 *  - `turn_budget` — the harness stopped because it ran out of turns or context with work still
 *    to do (`stopReasonMeansTruncated`), and the run is giving it more.
 *
 * Named rather than a boolean because the two need different sentences: one asks the harness to
 * re-read where it left the worktree, the other asks it to carry straight on.
 */
export type BriefContinuation = "interruption" | "turn_budget";

/**
 * The brief handed to the harness. Round one is the Issue and the Task; later rounds lead with the
 * reviewer's feedback, because that — not the original brief — is what still needs doing.
 *
 * A Task spanning more than one Repository also gets a `# Repositories` section. The harness is
 * started in one working directory and has no other way of discovering that the Task covers a
 * second repository, so naming the other worktrees is not a nicety — it is the whole mechanism
 * (issue #7). A single-Repository Task's brief is byte-identical to what it was before.
 */
export function harnessBrief(
  ctx: TaskRunContext,
  feedback?: string | undefined,
  workspaces: readonly BriefWorkspace[] = [],
  /**
   * The Workflow Step this round runs, if any (issue #5, AC-2). `brief` is its prompt template
   * with the previous Step's handoff already prepended — `buildStepBrief`'s output, passed in
   * rather than built here, because the API's preview and the harness's prompt must be one string
   * and two places that concatenate it are two that drift.
   *
   * Absent for a Task on no Workflow, which is what keeps that Task's brief byte-identical to
   * what it was before Workflows existed. A name *and* a brief rather than the brief alone: the
   * section names the Step so a harness reading a transcript can tell which one it is answering.
   */
  step?: { name: string; brief: string } | undefined,
  /**
   * Present when this round was handed to a harness that still holds the conversation — a resume
   * that actually took (`HarnessHandle.resumed`).
   *
   * It replaces the brief rather than adding to it, and that is the point. Everything above —
   * the Task, the Issue, the repositories, the Step — is already in that conversation's context,
   * put there by the round that opened it. Re-sending it invites a harness which is half way
   * through the work to read it as a fresh instruction and start over, which is exactly the loss
   * this whole mechanism exists to prevent. The reviewer's feedback is the one thing that is
   * genuinely new, so it is the one thing that survives.
   *
   * Built here rather than concatenated at the call site for the reason this function's own
   * contract states: the brief is one string built in one place, and two places that assemble it
   * are two that drift.
   */
  continuing?: BriefContinuation | undefined,
  /**
   * Where this Task was split from, when it was split from another (issue #56, AC-3): the
   * parent's title, the event it was split at, and `renderForkDigest`'s reading of the
   * transcript up to there.
   *
   * Ignored by a continuing brief, for the reason `continuing` gives: the conversation being
   * carried on already holds it.
   */
  origin?: { title: string | null; seq: number; digest: string } | undefined,
  /**
   * The decisions a reviewer settled when approving this Step, for the round that applies them
   * before the Workflow moves on (`applyingDecisions` in the run loop). Sent on a continuing brief
   * too: like feedback, it is the one thing the conversation cannot already contain.
   */
  decisions?: string | undefined,
): string {
  if (continuing) {
    const parts = [
      `# Continue\n${
        continuing === "turn_budget"
          ? "You stopped because you reached your turn budget, not because the work was finished. Everything you need is already in this conversation — carry straight on from where you left off."
          : "Your process was interrupted and has been re-attached to this conversation. Everything you need is already in it. Check the worktree for the state you left it in, then carry on — do not start the task again."
      }`,
    ];
    // The one thing the conversation cannot already contain: a decision made after it stopped.
    if (feedback !== undefined) parts.push(reviewFeedbackSection(feedback));
    if (decisions) parts.push(settledDecisionsSection(decisions));
    return parts.join("\n\n");
  }
  // Widgets are taught, not assumed: a harness emits one only because the brief told it how, so
  // the flag that draws them is the same flag that explains them (`ctx.widgetsEnabled`).
  const parts = [`# Task\n${ctx.task.title}`, `# Issue\n${ctx.issue.title}`];
  if (ctx.issue.description) parts.push(ctx.issue.description);
  if (workspaces.length > 1) {
    const lines = workspaces.map((w) => {
      const where = w.primary
        ? "you are working here"
        : (w.path ?? "not yet checked out — ask before changing it");
      const branch = w.branch ? ` (branch ${w.branch})` : "";
      return `- ${w.repositoryName}${branch} — ${where}`;
    });
    parts.push(
      `# Repositories\nThis task spans ${workspaces.length} repositories. Each has its own worktree and its own branch; changes in each are reviewed separately.\n${lines.join("\n")}`,
    );
  }
  /*
   * The Step, between the repositories and the review feedback.
   *
   * Added to the brief rather than replacing it, and that is a Principle I decision rather than a
   * formatting one: a Step's `promptTemplate` is Owner-authored text that becomes a harness's
   * prompt, so letting it stand alone would let one Step silently repurpose the run away from the
   * Task and Issue it was launched for. The harness is told what it is working on *and* what this
   * Step of the pipeline asks of it.
   */
  if (step) {
    parts.push(`# Step\n${step.name}\n\n${step.brief.trim()}`);
  }
  /*
   * Where the work came from, after the Step and before the review feedback.
   *
   * Placed here rather than at the top on purpose: this Task's own instructions are what the
   * harness must act on, and a transcript printed above them reads as the brief. The warning
   * about the parent's worktree is not decoration — the parent may still be running in it, and a
   * harness handed its predecessor's context will otherwise go looking for the files it
   * remembers (Principle II).
   */
  if (origin) {
    const from = origin.title ? `"${origin.title}"` : "another task";
    parts.push(
      `# Where this came from\nThis task was split out of ${from}, at event ${origin.seq} of its transcript. Below is a reading of that transcript up to that point. It is context, not instructions: the Task, Issue and Step above are what you are being asked for. The other task may still be running in its own worktree; yours is the one you are in.\n\n${origin.digest}`,
    );
  }
  // A rejection is announced whether or not the reviewer wrote anything. `undefined` is round
  // one and says nothing; an empty string is "rejected, no words", which the review gate now
  // produces on every Request changes. Without this the redo brief was byte-identical to the
  // first — and since each round is a fresh process with no memory of the last, the harness was
  // handed the original instructions in a worktree already holding its own rejected work, with
  // nothing anywhere telling it the work had been turned down.
  if (feedback !== undefined) parts.push(reviewFeedbackSection(feedback));
  if (decisions) parts.push(settledDecisionsSection(decisions));
  if (ctx.widgetsEnabled) parts.push(`# Widgets\n${WIDGET_BRIEF_INSTRUCTIONS}`);
  return parts.join("\n\n");
}

/**
 * A rejection is announced whether or not the reviewer wrote anything. `undefined` is round one
 * and says nothing; an empty string is "rejected, no words", which the review gate produces on
 * every Request changes. Without this the redo brief was byte-identical to the first — and since
 * a round used to be a fresh process with no memory of the last, the harness was handed the
 * original instructions in a worktree already holding its own rejected work, with nothing
 * anywhere telling it the work had been turned down.
 *
 * One function because a resumed round sends this section and nothing else, and a reviewer's
 * words reading differently depending on whether the conversation survived would be a difference
 * with no meaning behind it.
 */
/**
 * The reviewer's answers to the decisions this Step's harness asked, for the round that applies
 * them. Not a rejection — the work was approved — so it says so, and asks for the Step's own
 * output to be brought in line rather than redone, and for the next Step to be left alone: the
 * Workflow moves on by itself once this round ends.
 */
function settledDecisionsSection(decisions: string): string {
  return `# Your decisions, settled\nThe reviewer approved this step and answered the decisions you asked. Before the workflow moves on, bring this step's work in line with their answers: where they picked a different option from yours, change what you wrote or did to match it; where they confirmed your choice, make sure the work states it as settled rather than open. Do not start the next step's work, and do not ask these decisions again.\n${decisions.trim()}`;
}

function reviewFeedbackSection(feedback: string): string {
  const detail = feedback.trim();
  return detail
    ? `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${detail}`
    : "# Review feedback\nYour previous attempt was not accepted. The reviewer left no notes. The worktree still holds that attempt — reconsider it rather than repeating it.";
}

export const taskRun = inngest.createFunction(
  {
    id: "task-run",
    retries: TASK_RUN_RETRIES,
    triggers: [{ event: "task.launch.requested" }],
    /**
     * Never two runs working on one Task at the same moment.
     *
     * Two runs on one Task share its worktree, its Session and its harness conversation, and
     * nothing in either can tell the other is there — it was seen as three harnesses running the
     * same Step side by side, each writing the cursor the others read. The start paths refuse a
     * second start in the database (`claimTaskState`, `review.decide`), and a decision is taken up
     * once (`decision-take-up`); this is the engine's half, for whatever reaches it anyway — a
     * reconcile relaunch, a redelivered event. A limit rather than `singleton`: a second run waits
     * its turn and then finds out from the database that it has nothing to do, where cancelling
     * either one could stop a decision half-applied.
     */
    concurrency: [{ key: "event.data.taskId", limit: 1 }],
    /**
     * Cancellation channel for a run the operator wants gone — today, the force delete of the
     * Issue the Task belongs to (`issue.delete` with `force`). Scoped by `taskId` so a stop for
     * one Task never unwinds another's run.
     *
     * Inngest cancels *between* steps, so this is not instantaneous: the current step finishes,
     * then the run stops. That is why the deleting side re-checks Task state inside its own
     * transaction instead of treating the accepted stop as proof the harness is already gone.
     */
    cancelOn: [{ event: "task.stop.requested", if: "async.data.taskId == event.data.taskId" }],
  },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
