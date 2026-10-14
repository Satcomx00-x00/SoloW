import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import {
  parseSessionEventPayload,
  type SessionEventPayload,
  type TaskWorkflowBindingDto,
  validateWidgetResponse,
  type Widget,
  widgetExpectsResponse,
} from "@solow/contracts";
import {
  CREDENTIAL_EXPIRED_REASON,
  carryHarnessDecision,
  carryHarnessReview,
  classifyRunFailure,
} from "@solow/core";
import { renderForkDigest } from "@solow/core/session-log";
import { loadHarnessLibrariesForRun } from "@solow/db";
import { captureException } from "@solow/observability";
import { prepareHarnessEnv } from "../../../billing/guard.js";
import {
  appendSessionEvent,
  hasEarlierSession,
  isMissingParentRow,
  loadForkOrigin,
  loadHarnessProbeContext,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordHarnessSessionId,
  recordSessionUsage,
  recordTaskCompletion,
  recordWorktree,
  resolveResumeHarnessSessionId,
  type TaskRepositoryBinding,
  updateHarnessCatalogCapabilities,
} from "../../../data.js";
import type { Executor } from "../../../executor/types.js";
import { worktreeNameForTask } from "../../../harness/claude-code-runner.js";
import { clientDirectives } from "../../../harness/client-directives.js";
import { profileHarnessConfig } from "../../../harness/harness-config.js";
import { resolveHarnessConfigEnv } from "../../../harness/hermetic-home.js";
import { materializeLibraries } from "../../../harness/libraries.js";
import { WidgetFenceScanner } from "../../../harness/widget-fence.js";
import { harnessHomePath, type Worktree, worktreePath } from "../../../worktree/manager.js";
import { toTaskEvent } from "../../../ws/replay.js";
import { briefWorkspaces, harnessBrief, widgetAnswerMessage } from "./brief.js";
import type { DecidedReview } from "./decision.js";
import {
  allowlistToolInput,
  readTodoWrite,
  redactPayload,
  secretNeedles,
  textPayload,
  toolStatus,
  truncateToolOutput,
} from "./harness-events.js";
import type { RunScope } from "./scope.js";
import { type LoopState, patternsFor, type WorktreeBinding, type WorktreeOps } from "./types.js";

/*
 * One harness round: the body of `agent-run-${round}`. The harness is launched under the leg in
 * force, briefed or resumed, its stream recorded and published, and its worktree confirmed; what
 * it declared comes back for the loop to act on.
 *
 * Everything here runs inside one durable step, so it re-executes on a redrive — which is why the
 * reads that must see the dying attempt's writes (the credential, the resume id, the fork point)
 * happen here and not in steps of their own.
 */

/**
 * How long a declared-finished harness is given to say anything more before the round is ended.
 *
 * Long enough that a model which declares and then adds a closing paragraph is not cut off;
 * short enough that a run does not spend a meaningful part of Inngest's execution budget waiting
 * on a process that has nothing left to do. Every further event re-arms it, so this is a
 * *silence* budget rather than a deadline on the harness.
 */
const COMPLETION_GRACE_MS = 15_000;

/** What a round needs from the run that prepared it, and from the loop that started it. */
export interface RoundContext {
  /** The Workflow as this run resolved it at `workflow-resume`. */
  wf: TaskWorkflowBindingDto | null;
  /** The executor this Task runs on. */
  executor: Executor;
  /** Git on the Task's own repository, run where the Task runs. */
  worktreeOps: WorktreeOps;
  /** Git on the repositories the deployment shares, run on the orchestrator's host. */
  repoAdmin: WorktreeOps;
  /** Where the primary Repository was prepared. */
  repoPath: string;
  /** The attachment the harness process is started in. */
  primaryBinding: TaskRepositoryBinding;
  /** The worktrees SoloW made itself, by attachment id. */
  provisionedByAttachment: ReadonlyMap<string, Worktree>;
  /** Every worktree this Task has, in attachment order, once the primary one is known. */
  worktreeBindings: (primary: Worktree) => WorktreeBinding[];
  /** The primary worktree an earlier round or Session left on disk, confirmed with git. */
  retainedPrimary: () => Promise<Worktree | null>;
  /** Copy the primary Repository's setup files into the worktree the harness reported. */
  seed: (reportedPath: string) => Promise<void>;
  /** The decision this run was started with, if it was. */
  decidedReview: DecidedReview | undefined;
  /** Whether this round carries on a conversation the harness's own budget cut short. */
  continuation: boolean;
  /** The Step this round runs, captured before the loop can rebind `leg`. */
  roundStepId: string | null;
}

export async function runHarnessRound(
  scope: RunScope,
  round: number,
  loop: LoopState,
  {
    wf,
    executor,
    worktreeOps,
    repoAdmin,
    repoPath,
    primaryBinding,
    provisionedByAttachment,
    worktreeBindings,
    retainedPrimary,
    seed,
    decidedReview,
    continuation,
    roundStepId,
  }: RoundContext,
) {
  const { deps, db, log, workspaceId, taskId, sessionId, ctx, channel, announce } = scope;
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
    ? ((await loadHarnessProbeContext(db, workspaceId, loop.leg.harnessProfile.id))
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
      : [loop.wt?.path, repoPath]
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
    loop.leg.harnessProfile,
    loop.leg.harnessCatalog,
  );
  const configEnv = { ...homeEnv, ...(configLaunch.ok ? configLaunch.data.env : {}) };
  const shaped = prepareHarnessEnv({
    authMode: loop.leg.harnessProfile.authMode,
    secretCiphertext: legCiphertext,
    baseEnv: hostEnv,
    subscriptionEnvVar: loop.leg.harnessCatalog.subscriptionEnvVar,
    meteredEnvVar: loop.leg.harnessCatalog.meteredEnvVar,
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
  const needles = secretNeedles(shaped.data, loop.leg.harnessCatalog, legCiphertext);

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
  const stepInForce = loop.leg.stepId;

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
          agentProfileId: loop.leg.harnessProfile.id,
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
    const payload = parseSessionEventPayload(rawPayload.kind, redactPayload(rawPayload, needles));
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
    if (loop.wt) return Promise.resolve(loop.wt);
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
  const { command } = loop.leg.harnessCatalog;
  // Without the flags addressed to SoloW as the ACP client — `opencode acp` refuses `--auto`
  // (`client-directives.ts`); `launchSettingsFor` has already turned it into the runner's.
  const { args } = clientDirectives(
    loop.leg.harnessCatalog.protocol,
    loop.leg.harnessCatalog.argsTemplate,
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
  if (loop.wt === null) loop.wt = await retainedPrimary();
  const resuming = loop.wt;

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
    ? await loadHarnessLibrariesForRun(db, workspaceId, loop.leg.stepId)
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
    protocol: loop.leg.harnessCatalog.protocol,
    catalogKey: loop.leg.harnessCatalog.key,
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
    resuming && !loop.resumeLost
      ? await resolveResumeHarnessSessionId(db, workspaceId, taskId, sessionId, loop.leg.stepId)
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
    loop.leg.stepBrief !== null && loop.leg.stepName !== null
      ? { name: loop.leg.stepName, brief: loop.leg.stepBrief }
      : undefined;
  const fullBrief = harnessBrief(
    ctx,
    loop.pendingFeedback,
    briefWorkspaces(ctx, primaryBinding, loop.wt, provisionedByAttachment),
    stepSection,
    undefined,
    forkSection,
    loop.applyingDecisions ?? undefined,
  );
  const brief = resumeSessionId
    ? harnessBrief(
        ctx,
        loop.pendingFeedback,
        [],
        stepSection,
        continuation ? "turn_budget" : "interruption",
        undefined,
        loop.applyingDecisions ?? undefined,
      )
    : fullBrief;

  const handle = loop.runner.start({
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
              loop.leg.harnessCatalog.id,
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
    if (reported && !loop.wt) {
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
}
