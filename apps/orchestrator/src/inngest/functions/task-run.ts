import { type AgentProtocol, reviewDecisionSchema, type TaskState } from "@gatecontrol/contracts";
import { classifyRunFailure } from "@gatecontrol/core";
import { createDb, type Db, decryptForScmSync } from "@gatecontrol/db";
import {
  captureException,
  createLogger,
  type Logger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "@gatecontrol/observability";
import { z } from "zod";
import { worktreeNameForTask } from "../../agent/claude-code-runner.js";
import {
  agentCreatesOwnWorktree,
  hasAgentRunner,
  missingAgentRunnerReason,
} from "../../agent/protocols.js";
import { type AgentRegistry, agentRegistry } from "../../agent/registry.js";
import type { AgentRunner } from "../../agent/runner.js";
import { createAgentRunner } from "../../agent/runners.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  loadTaskRunContext,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordSessionUsage,
  setSessionState,
  setTaskState,
  type TaskRunContext,
  unsatisfiedDependencyIds,
} from "../../data.js";
import { orchestratorEnv } from "../../env.js";
import { hasDriver, missingDriverReason } from "../../executor/drivers.js";
import { createLocalExecutor } from "../../executor/local.js";
import {
  adoptWorktree,
  type CloneCredential,
  cleanupWorktree,
  commitWorktree,
  diffWorktree,
  discardWorktreeChanges,
  hasChanges,
  type ProvisionParams,
  prepareRepository,
  provisionWorktree,
  type Worktree,
  type WorktreeDiff,
} from "../../worktree/manager.js";
import { type SetupFileSeedResult, seedSetupFiles } from "../../worktree/setup-files.js";
import { hub } from "../../ws/hub.js";
import { inngest } from "../client.js";

/**
 * The username each provider expects on an https clone. Both authenticate on the token and
 * ignore this, but sending what they document costs nothing and stops the pair looking arbitrary.
 */
const CLONE_USERNAME = { github: "x-access-token", gitlab: "oauth2" } as const;

/** The credential for cloning this Task's Repository, or undefined when it needs none. */
function cloneCredentialFor(ctx: TaskRunContext): CloneCredential | undefined {
  if (!ctx.scmClone) return undefined;
  return {
    username: CLONE_USERNAME[ctx.scmClone.provider],
    token: decryptForScmSync(ctx.scmClone.secretCiphertext),
  };
}

/**
 * Durable Task lifecycle (plan §9 / task TASK-019). Steps are resumable: an orchestrator
 * restart resumes from the last completed step (Principle III). The review gate is a
 * `waitForEvent` (Principle I — no integration without a recorded human decision).
 *
 * The lifecycle body is factored into `runTaskLifecycle(deps, …)` so its collaborators (agent
 * runner, worktree ops, hub, db) can be injected — the Inngest function wires the real ones,
 * and the integration test (TASK-020) drives it with a fake ACP agent + a controllable step.
 */

const launchData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  sessionId: z.string().min(1),
});

const reviewData = z.object({
  sessionId: z.string().min(1),
  decision: reviewDecisionSchema,
  feedback: z.string().nullish(),
});

const MAX_REVIEW_ROUNDS = 5;

/**
 * Worktree operations the lifecycle depends on (real impls in `defaultDeps`), already bound to
 * an `Executor` (issue #1) — the lifecycle itself stays executor-agnostic.
 */
export interface WorktreeOps {
  /**
   * Resolve the repository the agent will run in. Claude Code creates the Task's worktree
   * itself (`--worktree`), so for that protocol this is all the preparation there is.
   */
  prepare(params: ProvisionParams): Promise<string>;
  /**
   * Create the Task's worktree, for a protocol whose agent cannot (issue #58). ACP has no
   * notion of a worktree: the agent works in the `cwd` it is handed, so GateControl makes the
   * directory and points it there. The isolation guarantee is unchanged (Principle II) — only
   * who runs `git worktree add` moves.
   */
  provision(params: ProvisionParams): Promise<Worktree>;
  /** Confirm with git that the path the agent reported really is a worktree of the repository. */
  adopt(repoPath: string, reportedPath: string | null): Promise<Worktree>;
  /** Copy the Repository's allowlisted setup files into a freshly created worktree (issue #52). */
  seed(params: {
    repoPath: string;
    worktreePath: string;
    patterns: string[];
  }): Promise<SetupFileSeedResult>;
  commit(path: string, message: string, setupFilePatterns: string[]): Promise<void>;
  discard(path: string): Promise<void>;
  cleanup(repoPath: string, worktree: string): Promise<void>;
  hasChanges(path: string, setupFilePatterns: string[]): Promise<boolean>;
  diff(path: string, setupFilePatterns: string[]): Promise<WorktreeDiff>;
}

/** The bits of the WS hub the lifecycle uses. */
export interface HubLike {
  taskChannel(workspaceId: string, taskId: string): string;
  boardChannel(workspaceId: string): string;
  publish(channel: string, event: unknown): void;
}

/** Injected collaborators for the Task lifecycle. */
export interface TaskRunDeps {
  db: Db;
  /**
   * The adapter for a protocol, or null when this build cannot drive it (issue #58, AC-3). A
   * function rather than a runner because the protocol comes from the Task's own Agent catalog
   * row: two Tasks in one Workspace can be driven over two different protocols.
   */
  runner: (protocol: AgentProtocol) => AgentRunner | null;
  worktreeRoot: string;
  repoCacheRoot: string;
  logger: Logger;
  worktree: WorktreeOps;
  hub: HubLike;
  /** Where the hub finds the agent belonging to a Task, to deliver input or a stop. */
  registry: AgentRegistry;
}

/** Production wiring. */
export function defaultDeps(): TaskRunDeps {
  const env = orchestratorEnv();
  // One local executor (issue #1) for the whole lifecycle: today the only kind, tomorrow one of
  // several a Task's Executor Profile can select — everything below reaches the host through it.
  const executor = createLocalExecutor(env.GATECONTROL_WORKTREE_ROOT);
  return {
    db: createDb(),
    runner: (protocol) =>
      createAgentRunner(protocol, {
        executor,
        unattendedPermissionPosture: env.GATECONTROL_ACP_UNATTENDED_PERMISSION,
      }),
    worktreeRoot: env.GATECONTROL_WORKTREE_ROOT,
    repoCacheRoot: env.GATECONTROL_REPO_CACHE_ROOT,
    logger: createLogger({ service: "orchestrator" }),
    worktree: {
      prepare: (params) => prepareRepository(executor, params),
      provision: (params) => provisionWorktree(executor, params),
      adopt: (repoPath, reportedPath) => adoptWorktree(executor, repoPath, reportedPath),
      seed: (params) => seedSetupFiles(executor, params),
      commit: (path, message, patterns) => commitWorktree(executor, path, message, patterns),
      discard: (path) => discardWorktreeChanges(executor, path),
      cleanup: (repoPath, worktree) => cleanupWorktree(executor, repoPath, worktree),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    },
    hub,
    registry: agentRegistry,
  };
}

/** Minimal shape of the Inngest step tools the lifecycle uses (also satisfied by test fakes). */
export interface StepLike {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
  waitForEvent(
    id: string,
    opts: { event: string; timeout: string; match: string },
  ): Promise<{ data: unknown } | null>;
  sleepUntil(id: string, until: Date): Promise<void>;
}

export interface TaskRunArgs {
  event: { data: unknown };
  step: StepLike;
}

export async function runTaskLifecycle(
  deps: TaskRunDeps,
  { event, step }: TaskRunArgs,
): Promise<{ taskId: string; result: string }> {
  const { workspaceId, taskId, sessionId } = launchData.parse(event.data);
  const { db } = deps;
  const log = withRunContext(deps.logger, { workspaceId, taskId, sessionId });

  const ctx = await step.run("load", () => loadTaskRunContext(db, workspaceId, taskId));

  const channel = deps.hub.taskChannel(workspaceId, taskId);
  const boardChannel = deps.hub.boardChannel(workspaceId);

  /** Announce a Task state change on the Workspace board channel (the SPA board listens here). */
  const announce = (state: TaskState) =>
    deps.hub.publish(boardChannel, {
      kind: "status",
      taskId,
      state,
      at: new Date().toISOString(),
    });

  /**
   * An Agent Profile names the protocol its catalog row declares, and only some protocols have
   * a runner behind them (issues #10 and #58). Checked here, before anything is cloned: a Task
   * pointed at a protocol nothing speaks must fail with a legible reason, not crash deep inside
   * a runner that was never built for it.
   */
  const protocol = ctx.agentCatalog.protocol;
  const runner = deps.runner(protocol);
  if (!hasAgentRunner(protocol) || !runner) {
    const reason = missingAgentRunnerReason(protocol);
    await step.run("agent-runner-unavailable", () =>
      setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
    );
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * A Task names the Executor Profile it runs under, and only some kinds have a driver behind
   * them (issue #73). Checked here, before anything is cloned: a Task pointed at a Docker
   * profile must not quietly run on the orchestrator's own host and report success — the user
   * asked for isolation and would not have got it.
   */
  if (!hasDriver(ctx.executorProfile.kind)) {
    const reason = missingDriverReason(ctx.executorProfile.kind);
    await step.run("executor-unavailable", () =>
      setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
    );
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * The repository, not the Task's worktree.
   *
   * The agent creates the worktree itself (`claude --worktree`), which is what lets several
   * Tasks run against one repository at a time (Principle II). This step still resolves and
   * validates the repository up front, so an unusable location fails the Task before any agent
   * starts rather than surfacing as a confusing agent error later (TASK-015).
   */
  const repoPath = await step.run("prepare-repository", () =>
    deps.worktree.prepare({
      taskId,
      repository: { source: ctx.repository.source, location: ctx.repository.location },
      baseRef: ctx.task.baseRef ?? undefined,
      worktreeRoot: deps.worktreeRoot,
      repoCacheRoot: deps.repoCacheRoot,
      // Decrypted here, at the point of use, and handed straight to the clone — an imported
      // repository is private more often than not, and its Integration already holds the only
      // token that can read it (issue #15).
      cloneCredential: cloneCredentialFor(ctx),
    }),
  );

  /**
   * For a protocol whose agent makes no worktree of its own, GateControl makes it here — in its
   * own durable step, before the first round, so an orchestrator restart resumes with the same
   * directory rather than branching a second one from the base ref (Principle III).
   *
   * Caught, not left to escape. A Task that cannot be given a workspace has to *say so*: an
   * uncaught throw here exhausts the function's retries and leaves the Task sitting in `running`
   * with no failure reason at all, which is the one outcome an operator cannot act on. The
   * provisioning itself is idempotent (`provisionWorktree`), so relaunching or retrying the Task
   * after a fix reuses the same worktree instead of colliding with the branch it left behind.
   */
  let provisioned: Worktree | null = null;
  if (!agentCreatesOwnWorktree(protocol)) {
    try {
      provisioned = await step.run("provision-worktree", () =>
        deps.worktree.provision({
          taskId,
          repository: { source: ctx.repository.source, location: ctx.repository.location },
          baseRef: ctx.task.baseRef ?? undefined,
          worktreeRoot: deps.worktreeRoot,
          repoCacheRoot: deps.repoCacheRoot,
          cloneCredential: cloneCredentialFor(ctx),
        }),
      );
    } catch (cause) {
      // The reason is deliberately prose rather than the git error: a failed clone or worktree
      // command echoes back the command line, and that is not a place to be paraphrasing
      // credential-helper arguments into a column the UI renders (Principle IV). The detail
      // goes to the log, where it belongs.
      captureException(log, cause, { stage: "worktree-provision" });
      const reason = "could not provision an isolated worktree for this Task";
      await step.run("provision-failed", () =>
        setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
      );
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      return { taskId, result: "worktree_unavailable" };
    }
  }

  /**
   * The Repository's setup-file allowlist (issue #52): copied into the worktree the agent
   * creates, and subtracted from the diff and the commit, so a `.env` the agent needs to run
   * the tests never reaches the review UI or the branch.
   */
  const setupFilePatterns = ctx.repository.setupFilePatterns ?? [];

  /**
   * Copy the setup files into the worktree the agent reported, having first made git confirm it
   * really is a worktree of this repository — writing a `.env` into a directory the agent merely
   * claimed is precisely the mistake the adoption check exists to prevent (Principle II).
   *
   * Everything here is best-effort. A pattern that matches nothing, a file that cannot be read,
   * a worktree that fails adoption: none of them should fail a Task that would otherwise run
   * (AC-5). Warnings carry counts and the operator's own patterns — never a resolved path, and
   * never any content (AC-3).
   */
  const seed = async (reportedPath: string): Promise<void> => {
    if (setupFilePatterns.length === 0) return;
    try {
      const confirmed = await deps.worktree.adopt(repoPath, reportedPath);
      const result = await deps.worktree.seed({
        repoPath,
        worktreePath: confirmed.path,
        patterns: setupFilePatterns,
      });
      if (result.unmatched.length > 0 || result.failed > 0) {
        log.warn(
          {
            event: "setup-files.incomplete",
            copied: result.copied,
            failed: result.failed,
            unmatched: result.unmatched,
          },
          "some setup-file patterns copied nothing",
        );
      }
    } catch (cause) {
      captureException(log, cause, { stage: "setup-files-seed" });
    }
  };

  /**
   * The worktree every later step — diff, commit, discard, cleanup — acts on. Read back from
   * the agent (Claude Code makes its own) or set from what GateControl provisioned (ACP), and
   * confirmed with git either way before anything is written into it.
   */
  let wt: { path: string; branch: string; repoPath: string } | null = provisioned;

  /** Feedback from the previous review round; it becomes the next round's brief. */
  let pendingFeedback: string | undefined;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const brief = agentBrief(ctx, pendingFeedback);
    const run = await step.run(`agent-run-${round}`, async () => {
      const shaped = prepareAgentEnv({
        authMode: ctx.agentProfile.authMode,
        secretCiphertext: ctx.secretCiphertext,
        baseEnv: process.env,
        subscriptionEnvVar: ctx.agentCatalog.subscriptionEnvVar,
        meteredEnvVar: ctx.agentCatalog.meteredEnvVar,
        // The Executor Profile's environment (issue #73). It is applied under the credential
        // shaping, never over it, so a profile cannot become a route to metered billing.
        profileEnv: ctx.executorProfile.config.env ?? {},
      });
      if (!shaped.ok) return { kind: "failed" as const, cls: "credential_expired" as const };

      // Every streamed event is published live *and* appended to the session log, so a client
      // that reconnects can replay from `seq` instead of losing history (TASK-018). Writes are
      // chained to keep log order identical to stream order.
      let seq = await nextSessionEventSeq(db, workspaceId, sessionId);
      let writes: Promise<unknown> = Promise.resolve();
      // Usage is recorded per turn as it is reported (issue #14) — the agent states it once,
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
              agentProfileId: ctx.agentProfile.id,
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
          .catch((cause) => captureException(log, cause, { stage: "session-usage-record" }));
      };

      // `session_event.kind` is free text and its DTO a plain string, so a new event kind needs
      // no schema change — and being in the log is what makes a permission request survive a
      // reconnect instead of vanishing with the socket that carried it.
      const emit = (
        kind: "stdout" | "tool_use" | "permission_request" | "permission_resolved",
        payload: Record<string, unknown>,
      ) => {
        const at = seq++;
        deps.hub.publish(channel, { kind, taskId, sessionId, seq: at, ...payload });
        writes = writes
          .then(() => appendSessionEvent(db, workspaceId, { sessionId, seq: at, kind, payload }))
          .catch((cause) => captureException(log, cause, { stage: "session-event-append" }));
      };

      // Launch command and arguments come from the Agent's catalog row (issue #10) — not a
      // global env var, since two Agent Profiles in the same Workspace can point at different
      // catalog entries.
      const { command, argsTemplate: args } = ctx.agentCatalog;
      // First round with a `--worktree`-capable agent: run in the repository and have it create
      // the Task's worktree. Later rounds continue *inside* that worktree — a reviewer asking
      // for changes wants the work carried on, and asking for the worktree again would branch a
      // fresh one from the base ref and throw the earlier round away. An ACP Task arrives here
      // with `wt` already set to the worktree GateControl provisioned, so it takes the same
      // path from its very first round.
      const resuming = wt;
      const handle = runner.start({
        command,
        args,
        cwd: resuming ? resuming.path : repoPath,
        env: shaped.data,
        worktreeName: resuming ? null : worktreeNameForTask(taskId),
        prompt: brief,
        onEvent: (e) => {
          if (e.kind === "stdout") emit("stdout", { text: e.text });
          else if (e.kind === "tool_use") emit("tool_use", { name: e.name });
          else if (e.kind === "permission_request") {
            emit("permission_request", {
              requestId: e.requestId,
              title: e.title,
              toolKind: e.toolKind,
              options: e.options,
            });
          } else if (e.kind === "permission_resolved") {
            emit("permission_resolved", {
              requestId: e.requestId,
              optionId: e.optionId,
              decidedBy: e.decidedBy,
            });
          } else recordUsage(e);
        },
      });
      // Publish the handle for the lifetime of the run so the hub can deliver the operator's
      // input or stop to *this* agent (TASK-022), and withdraw it the moment the run ends.
      const deregister = deps.registry.register(workspaceId, { taskId, sessionId, handle });
      let outcome: Awaited<typeof handle.outcome>;
      let reported: string | null = null;
      try {
        // Learn where the agent went as soon as it says so, before waiting on the run: if the
        // agent dies mid-run we still know which worktree to clean up.
        reported = await handle.workspacePath;
        // ...and, on the first round, use that same moment to copy the Repository's setup files
        // in. An agent announces its worktree before the model's first turn, so this is the
        // earliest point at which the directory exists — and, in practice, before the agent has
        // looked at it. A later round skips it: the files are already there, and re-copying
        // would overwrite anything the agent changed.
        if (round === 0 && reported) await seed(reported);
        outcome = await handle.outcome;
      } finally {
        deregister();
        // Drain queued log and usage writes even when the run threw. Usage in particular
        // cannot be re-obtained — the agent reports it once — so abandoning the chain on a
        // mid-turn failure would lose it permanently rather than merely delay it.
        await writes;
      }

      // Confirm with git that the reported path really is a worktree of this repository. An
      // agent working somewhere else has not been isolated, and committing from wherever it
      // happened to point would be worse than failing (Principle II). A resuming round is
      // re-checked too: the worktree could have been removed underneath us between rounds.
      let adopted: { path: string; branch: string; repoPath: string };
      try {
        adopted = await deps.worktree.adopt(repoPath, reported);
      } catch (cause) {
        captureException(log, cause, { stage: "worktree-adopt", reported });
        return { kind: "failed" as const, cls: "fail" as const };
      }

      if (outcome.kind === "failed") {
        return {
          kind: "failed" as const,
          cls: classifyRunFailure(outcome.signal),
          worktree: adopted,
        };
      }
      const changed = await deps.worktree.hasChanges(adopted.path, setupFilePatterns);
      return { kind: "completed" as const, changed, worktree: adopted };
    });

    if (run.worktree) {
      wt = run.worktree;
      // The audit line binding a worktree to its Task (Principle IV) is emitted on adoption,
      // because that is the first moment GateControl knows which directory the agent used.
      logWorktreeBinding(log, { workspaceId, taskId, worktreePath: run.worktree.path });
    }

    if (run.kind === "failed") {
      if (run.cls === "park") {
        await step.run(`park-${round}`, () => setTaskState(db, workspaceId, taskId, "parked"));
        logStateTransition(log, { workspaceId, taskId, from: "running", to: "parked" });
        announce("parked");
        // Resume when the quota window resets (~5h). A budget/quota check would refine this.
        await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + 5 * 60 * 60 * 1000));
        continue;
      }
      // credential_expired or hard failure: pause/stop with the reason preserved.
      await step.run(`fail-${round}`, () =>
        setTaskState(db, workspaceId, taskId, "failed", { failureReason: run.cls }),
      );
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      captureException(log, new Error(`task run failed: ${run.cls}`), { failureReason: run.cls });
      return { taskId, result: run.cls };
    }

    // Completed: move to review and wait for a human decision.
    const worktree = run.worktree;
    await step.run(`to-review-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review");
      await setSessionState(db, workspaceId, sessionId, "awaiting_review", {
        diffRef: worktree.branch,
      });

      // Capture the change now, while the worktree still exists: approving removes it, and a
      // reviewer looking at a finished Task should still be able to see what they approved.
      // A capture failure must not block the review gate — the branch name alone is enough to
      // decide on, so this degrades to "no diff shown" rather than stalling the Task.
      try {
        const captured = await deps.worktree.diff(worktree.path, setupFilePatterns);
        await appendSessionEvent(db, workspaceId, {
          sessionId,
          seq: await nextSessionEventSeq(db, workspaceId, sessionId),
          kind: "diff",
          payload: { diffRef: worktree.branch, ...captured },
        });
      } catch (cause) {
        captureException(log, cause, { stage: "diff-capture" });
      }

      deps.hub.publish(channel, { kind: "diff", taskId, sessionId, diffRef: worktree.branch });
    });
    logStateTransition(log, { workspaceId, taskId, from: "running", to: "review" });
    announce("review");

    const decidedEvent = await step.waitForEvent(`await-review-${round}`, {
      event: "review.decided",
      timeout: "7d",
      match: "data.sessionId",
    });
    if (!decidedEvent) return { taskId, result: "review_timeout" };

    const { decision, feedback } = reviewData.parse(decidedEvent.data);

    if (decision === "approve") {
      await step.run(`approve-${round}`, async () => {
        await deps.worktree.commit(worktree.path, `GateControl: task ${taskId}`, setupFilePatterns);
        await setTaskState(db, workspaceId, taskId, "done", { resultBranch: worktree.branch });
        await setSessionState(db, workspaceId, sessionId, "closed", {
          endedAt: new Date().toISOString(),
        });
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "done" });
      announce("done");
      break;
    }
    if (decision === "reject") {
      await step.run(`reject-${round}`, async () => {
        await deps.worktree.discard(worktree.path);
        await setTaskState(db, workspaceId, taskId, "ready");
      });
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "ready" });
      announce("ready");
      break;
    }
    // request_changes: resume the agent for another round, carrying the reviewer's feedback —
    // without it the next round would repeat the same brief and produce the same work.
    //
    // Resuming is a *start*, so it is gated on the Task's dependencies exactly as a launch is
    // (issue #6 AC-3). `review.decide` already refuses this before publishing the event, which
    // makes the check here a second line rather than the first — but the transition into
    // `running` is applied on this side, and a guard that lives only at the API boundary holds
    // only while the API is the sole producer of `review.decided`.
    const outstanding = await step.run(`resume-blockers-${round}`, () =>
      unsatisfiedDependencyIds(db, workspaceId, taskId),
    );
    if (outstanding.length > 0) {
      const reason = "blocked_by_dependency";
      await step.run(`resume-blocked-${round}`, () =>
        setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason }),
      );
      logStateTransition(log, { workspaceId, taskId, from: "review", to: "failed" });
      announce("failed");
      // The blocking ids are Task ids, not content — safe to log, and the only way an operator
      // learns *which* predecessor stopped the resume.
      captureException(log, new Error(`resume refused: ${reason}`), {
        failureReason: reason,
        blockedBy: outstanding,
      });
      return { taskId, result: reason };
    }
    pendingFeedback = feedback ?? undefined;
    await step.run(`resume-${round}`, () => setTaskState(db, workspaceId, taskId, "running"));
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
    announce("running");
  }

  const adopted = wt;
  if (adopted) {
    await step.run("cleanup", () => deps.worktree.cleanup(adopted.repoPath, adopted.path));
  }
  return { taskId, result: "done" };
}

/**
 * The brief handed to the agent. Round one is the Issue and the Task; later rounds lead with the
 * reviewer's feedback, because that — not the original brief — is what still needs doing.
 */
export function agentBrief(ctx: TaskRunContext, feedback?: string | undefined): string {
  const parts = [`# Task\n${ctx.task.title}`, `# Issue\n${ctx.issue.title}`];
  if (ctx.issue.description) parts.push(ctx.issue.description);
  if (feedback?.trim()) {
    parts.push(
      `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${feedback.trim()}`,
    );
  }
  return parts.join("\n\n");
}

export const taskRun = inngest.createFunction(
  { id: "task-run", retries: 2, triggers: [{ event: "task.launch.requested" }] },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
