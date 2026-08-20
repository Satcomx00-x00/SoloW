import {
  type AgentProtocol,
  parseSessionEventPayload,
  reviewDecisionSchema,
  type SessionEventPayload,
  TaskErrorCode,
  type TaskState,
} from "@gatecontrol/contracts";
import { classifyRunFailure, primaryTaskRepository, taskCheckoutBranch } from "@gatecontrol/core";
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
import type { AgentRunner, AgentTextChannel } from "../../agent/runner.js";
import { createAgentRunner } from "../../agent/runners.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  compactSession,
  latestStateTransition,
  loadTaskRunContext,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordSessionUsage,
  setSessionState,
  setTaskRepositoryResultBranch,
  setTaskState,
  type TaskRepositoryBinding,
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
  isRepositoryUnusable,
  type ProvisionParams,
  prepareRepository,
  provisionWorktree,
  type Worktree,
  type WorktreeDiff,
} from "../../worktree/manager.js";
import { type SetupFileSeedResult, seedSetupFiles } from "../../worktree/setup-files.js";
import { hub } from "../../ws/hub.js";
import { toTaskEvent } from "../../ws/replay.js";
import { inngest } from "../client.js";

/**
 * The username each provider expects on an https clone. Both authenticate on the token and
 * ignore this, but sending what they document costs nothing and stops the pair looking arbitrary.
 */
const CLONE_USERNAME = { github: "x-access-token", gitlab: "oauth2" } as const;

/**
 * The credential for cloning one of the Task's Repositories, or undefined when it needs none.
 *
 * Per binding, not per Task: two attachments can come from two different Integrations, and a
 * single credential could only ever be right for one of them (issue #7).
 */
function cloneCredentialFor(binding: TaskRepositoryBinding): CloneCredential | undefined {
  if (!binding.scmClone) return undefined;
  return {
    username: CLONE_USERNAME[binding.scmClone.provider],
    token: decryptForScmSync(binding.scmClone.secretCiphertext),
  };
}

/**
 * One attached Repository, paired with the worktree the lifecycle is acting on for it.
 *
 * Every plural step — diff, commit, discard, cleanup — walks a list of these rather than a list
 * of paths, because each one needs the Repository's own setup-file allowlist and its own
 * attachment id to write a result branch back to.
 */
interface WorktreeBinding {
  binding: TaskRepositoryBinding;
  worktree: Worktree;
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
 * How many times Inngest re-runs the function after a failure. Declared once and read by the
 * prepare step, which has to know whether there is another attempt left before it decides
 * between rethrowing a transient failure and reporting it.
 */
const TASK_RUN_RETRIES = 2;

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
  /**
   * Which attempt of the function this is, counted from 0 — Inngest supplies it on every run.
   * The lifecycle needs it to tell "retry this" from "give up and say why": see the prepare
   * step, which is the one place a failure is worth waiting on rather than reporting at once.
   */
  attempt?: number;
}

/**
 * What a line of agent output *is*, from the channel the protocol reported it on.
 *
 * The mapping is the whole point of carrying the channel this far: without it every line was a
 * `stdout` blob and the transcript could not distinguish the operator's own steering from the
 * model's answer from a mode switch (issue #2, AC-1).
 */
function textPayload(channel: AgentTextChannel, text: string): SessionEventPayload {
  if (channel === "user") return { kind: "user_turn", text };
  if (channel === "system") return { kind: "notice", text };
  return { kind: "assistant_turn", text, thinking: channel === "thinking" };
}

/** What a redacted secret leaves behind, so a reader can see that something was removed. */
const REDACTED = "[redacted]";

/**
 * Values this run holds that must never end up in a payload (Principle IV, issue #2 DoD).
 *
 * The needles are exact strings — the decrypted credential as it was written into the agent's
 * environment, and the ciphertext it was decrypted from — rather than a pattern that guesses at
 * what a token looks like. The realistic path a secret takes into the log is the agent echoing
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
 * that outlives the run and travels — into a snapshot (#16), into an agent's context (#84) — and
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
   * Record a transition in the session log as well as announcing it (issue #2).
   *
   * Three audiences, one fact, and only one durable home: the board publish is ephemeral
   * transport, `logStateTransition` is operational and rotates, and this is the *record* — what a
   * reviewer reads afterwards to understand why the transcript has the shape it has, and what a
   * snapshot carries (Principle I). The sequence is read back from the database rather than taken
   * from the run's in-memory counter, because transitions happen outside the durable step that
   * counter lives in — the same pattern the diff capture below already uses. Every call site is
   * *inside* the durable step that applies the transition, so an Inngest replay after a restart
   * re-records nothing (Principle III); calling it beside the step instead would append a second
   * copy on every retry. Failure to record is swallowed: a Task must not fail because its
   * narration did not land.
   */
  const recordTransition = async (from: TaskState, to: TaskState, reason?: string) => {
    try {
      // `seq` is read back as max+1, so the `(session_id, seq)` unique index cannot make a
      // second attempt a no-op the way it does for the agent's own events — a retry would simply
      // land at a new seq. Inngest retries a step *body* from the top when anything in it
      // throws, and every call site here is followed by more work that can (the session write,
      // the diff capture, the publish), so the guard is the log itself: an identical transition
      // already at the head of the state records is this same transition being replayed. Two
      // genuinely identical transitions can never be adjacent, because reaching a state twice
      // means leaving it in between and that departure is recorded too.
      const previous = await latestStateTransition(db, workspaceId, sessionId);
      const same =
        previous?.from === from &&
        previous?.to === to &&
        // Normalised on both sides: an empty reason is not written, so it reads back as absent.
        (previous?.reason ?? "") === (reason ?? "");
      if (previous && same) return;
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        payload: { kind: "state", from, to, ...(reason ? { reason } : {}) },
      });
    } catch (cause) {
      captureException(log, cause, { stage: "session-state-record" });
    }
  };

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
    await step.run("agent-runner-unavailable", async () => {
      await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
      await recordTransition(ctx.task.state, "failed", reason);
    });
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
    await step.run("executor-unavailable", async () => {
      await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
      await recordTransition(ctx.task.state, "failed", reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * The Repositories this Task works in, and which of them the agent is started in (issue #7).
   *
   * The lifecycle goes plural everywhere below — provisioning, seeding, diff capture, commit,
   * discard, cleanup — but the agent process gets exactly one working directory, and that is the
   * primary attachment. This is the stated limitation of multi-repository Tasks, not an
   * accident: the other worktrees are named to the agent in the brief, which is the only way an
   * agent can reach a repository it was not started in until per-repository integration (#100)
   * gives it a real surface. `primaryTaskRepository` is the single place that choice is made.
   */
  const primaryBinding = primaryTaskRepository(
    ctx.repositories.map((binding) => ({ position: binding.attachment.position, binding })),
  ).binding;
  const secondaryBindings = ctx.repositories.filter((binding) => binding !== primaryBinding);

  /**
   * Whether the agent is left to make the primary worktree itself (issue #7 AC-1/AC-2).
   *
   * `claude --worktree` makes its own, which is what lets several Tasks share one repository —
   * but it makes it from HEAD, on a branch it names itself, and neither is negotiable. So the
   * attachment decides: one that asks for nothing in particular gets the agent's worktree and
   * behaves exactly as it always has, while one that names a base ref or a branch of its own is
   * provisioned here and the agent is started inside it. Without this the Owner's `Base ref`
   * was accepted, stored, shown in the brief and silently ignored, and the *secondary*
   * attachments of the same Task honoured theirs — one Task behaving two ways.
   */
  const primaryAttachment = primaryBinding.attachment;
  const agentMakesPrimaryWorktree =
    agentCreatesOwnWorktree(protocol) &&
    primaryAttachment.baseRef === null &&
    primaryAttachment.checkoutBranch === taskCheckoutBranch(taskId);

  const provisionParamsFor = (binding: TaskRepositoryBinding): ProvisionParams => ({
    taskId,
    repository: { source: binding.repository.source, location: binding.repository.location },
    baseRef: binding.attachment.baseRef ?? undefined,
    checkoutBranch: binding.attachment.checkoutBranch,
    // The primary keeps the Task's own directory; every other attachment gets a sibling named
    // for the attachment, so no two worktrees of one Task can occupy one path (Principle II).
    attachmentId: binding === primaryBinding ? undefined : binding.attachment.id,
    worktreeRoot: deps.worktreeRoot,
    repoCacheRoot: deps.repoCacheRoot,
    // Decrypted here, at the point of use, and handed straight to the clone — an imported
    // repository is private more often than not, and its Integration already holds the only
    // token that can read it (issue #15).
    cloneCredential: cloneCredentialFor(binding),
  });

  /**
   * Every attached repository, not the Task's worktree.
   *
   * The agent creates its own worktree under `claude --worktree`, which is what lets several
   * Tasks run against one repository at a time (Principle II). This step still resolves and
   * validates each repository up front, so an unusable location fails the Task before any agent
   * starts rather than surfacing as a confusing agent error later (TASK-015, issue #7 AC-3).
   *
   * The loop stops at the first repository it cannot prepare and reports *that* repository by
   * name. Only the name — Owner-authored text — leaves the step: a failed clone echoes back the
   * credential-helper argument list, which has no business in a column the UI renders
   * (Principle IV), so the git error goes to the log instead.
   *
   * A failure a retry could fix is rethrown while retries remain rather than reported. Catching
   * every cause here would have turned one flaky clone into a permanently failed Task on the first
   * attempt, which trades Principle III away for AC-3 when the two do not actually conflict: a
   * location that is not a git repository is answered now, a timeout is answered after Inngest has
   * run out of attempts, and either way the Task ends up with the Repository's name on it rather
   * than sitting in `running` with no reason.
   */
  const preparation = await step.run("prepare-repository", async () => {
    const prepared: Array<{ attachmentId: string; repoPath: string }> = [];
    for (const binding of ctx.repositories) {
      try {
        prepared.push({
          attachmentId: binding.attachment.id,
          repoPath: await deps.worktree.prepare(provisionParamsFor(binding)),
        });
      } catch (cause) {
        captureException(log, cause, { stage: "repository-prepare" });
        if (!isRepositoryUnusable(cause) && attempt < TASK_RUN_RETRIES) throw cause;
        return { ok: false as const, repositoryName: binding.repository.name };
      }
    }
    return { ok: true as const, prepared };
  });

  if (!preparation.ok) {
    // Until now this step was not wrapped at all: an unusable repository threw, exhausted the
    // function's retries and left the Task sitting in `running` with no reason — the one outcome
    // an operator can neither read nor act on. AC-3 makes that a defect.
    const reason = `${TaskErrorCode.RepositoryUnreachable}: ${preparation.repositoryName}`;
    await step.run("prepare-failed", async () => {
      await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
      await recordTransition(ctx.task.state, "failed", reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    return { taskId, result: "repository_unreachable" };
  }

  const repoPathByAttachment = new Map(
    preparation.prepared.map((entry) => [entry.attachmentId, entry.repoPath]),
  );
  const repoPathFor = (binding: TaskRepositoryBinding): string => {
    const path = repoPathByAttachment.get(binding.attachment.id);
    // Every attachment was prepared above or the run already returned, so this cannot be
    // missing. Asserted rather than defaulted, so a future edit that breaks the pairing says so
    // here instead of silently pointing git at the wrong repository.
    if (path === undefined) throw new Error("prepared repository missing for an attachment");
    return path;
  };
  const repoPath = repoPathFor(primaryBinding);

  /**
   * The worktrees GateControl creates itself — in their own durable step, before the first
   * round, so an orchestrator restart resumes with the same directories rather than branching a
   * second set from the base refs (Principle III).
   *
   * For a protocol whose agent makes its own worktree only the *secondary* attachments are
   * created here, and the agent still makes the primary — unless that attachment named a base
   * ref or a branch the agent has no way to honour, which puts it in this list too. For a
   * protocol whose agent cannot, GateControl creates all of them. Either way every attachment
   * ends up with an isolated worktree of its own, on the branch the attachment says it is on.
   *
   * Caught, not left to escape, for the same reason the prepare loop is: a Task that cannot be
   * given a workspace has to say so rather than sit in `running` with no failure reason. The
   * provisioning itself is idempotent (`provisionWorktree`), so relaunching or retrying the Task
   * after a fix reuses the same worktrees instead of colliding with the branches it left behind.
   */
  const toProvision = agentMakesPrimaryWorktree ? secondaryBindings : ctx.repositories;
  const provisionedByAttachment = new Map<string, Worktree>();
  if (toProvision.length > 0) {
    const provisioning = await step.run("provision-worktree", async () => {
      const created: Array<{ attachmentId: string; worktree: Worktree }> = [];
      for (const binding of toProvision) {
        try {
          created.push({
            attachmentId: binding.attachment.id,
            worktree: await deps.worktree.provision(provisionParamsFor(binding)),
          });
        } catch (cause) {
          // The reason is deliberately prose plus the Owner's own repository name rather than
          // the git error: a failed clone or worktree command echoes back the command line, and
          // that is not a place to be paraphrasing credential-helper arguments into a column the
          // UI renders (Principle IV). The detail goes to the log, where it belongs.
          captureException(log, cause, { stage: "worktree-provision" });
          // Undo what this step already made. The run returns before the lifecycle's own
          // `cleanup` is reachable, and nothing outside this loop ever learns those directories
          // exist — a three-repository Task whose third repository is unreachable would leave
          // two worktrees on disk with their branches checked out, blocking the next launch from
          // reusing them. Each removal is independently best-effort: one that fails must not
          // hide the failure that is actually being reported.
          for (const entry of created) {
            try {
              await deps.worktree.cleanup(entry.worktree.repoPath, entry.worktree.path);
            } catch (cleanupCause) {
              captureException(log, cleanupCause, { stage: "worktree-provision-rollback" });
            }
          }
          return { ok: false as const, repositoryName: binding.repository.name };
        }
      }
      return { ok: true as const, created };
    });

    if (!provisioning.ok) {
      const reason = `could not provision an isolated worktree for repository ${provisioning.repositoryName}`;
      await step.run("provision-failed", async () => {
        await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
        await recordTransition("running", "failed", reason);
      });
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      return { taskId, result: "worktree_unavailable" };
    }
    for (const entry of provisioning.created) {
      provisionedByAttachment.set(entry.attachmentId, entry.worktree);
    }
  }
  const provisioned = provisionedByAttachment.get(primaryBinding.attachment.id) ?? null;

  /**
   * Copy each secondary worktree's own setup files in as soon as it exists (issue #52).
   *
   * The primary's copy waits for the agent to announce where it went — GateControl does not
   * always own that directory — but a secondary worktree is one GateControl just created, so
   * there is nothing to wait for and no path to confirm. Best-effort, like the primary's: a
   * pattern that matches nothing must not fail a Task that would otherwise run.
   */
  for (const binding of secondaryBindings) {
    const worktree = provisionedByAttachment.get(binding.attachment.id);
    const patterns = binding.repository.setupFilePatterns ?? [];
    if (!worktree || patterns.length === 0) continue;
    await step.run(`seed-secondary-${binding.attachment.id}`, async () => {
      try {
        await deps.worktree.seed({
          repoPath: repoPathFor(binding),
          worktreePath: worktree.path,
          patterns,
        });
      } catch (cause) {
        captureException(log, cause, { stage: "setup-files-seed" });
      }
    });
  }

  /**
   * The primary Repository's setup-file allowlist (issue #52): copied into the worktree the agent
   * creates, and subtracted from the diff and the commit, so a `.env` the agent needs to run
   * the tests never reaches the review UI or the branch. Each secondary uses its own, above.
   */
  const setupFilePatterns = primaryBinding.repository.setupFilePatterns ?? [];

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
  let wt: Worktree | null = provisioned;

  /**
   * Every worktree this Task has, in attachment order, once the primary one is known.
   *
   * The primary is whatever the agent reported and git confirmed; the others are what GateControl
   * provisioned. An attachment with no worktree yet is left out rather than represented by a
   * placeholder — there is nothing to diff, commit or clean up for it.
   */
  const worktreeBindings = (primary: Worktree): WorktreeBinding[] =>
    ctx.repositories.flatMap((binding) => {
      const worktree =
        binding === primaryBinding ? primary : provisionedByAttachment.get(binding.attachment.id);
      return worktree ? [{ binding, worktree }] : [];
    });

  /** Feedback from the previous review round; it becomes the next round's brief. */
  let pendingFeedback: string | undefined;

  for (let round = 0; round < MAX_REVIEW_ROUNDS; round++) {
    const brief = agentBrief(
      ctx,
      pendingFeedback,
      briefWorkspaces(ctx, primaryBinding, wt, provisionedByAttachment),
    );
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

      // What must never reach a payload, computed from the env this run actually shaped rather
      // than from a list of variable names, so it holds for whichever Agent is running.
      const needles = secretNeedles(shaped.data, ctx.agentCatalog, ctx.secretCiphertext);

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

      // One typed record, published and persisted (issue #2, AC-1). The wire frame is *derived*
      // from the record by the same projection reconnect replay uses, rather than the payload
      // being spread onto the socket — which is what used to make the log's vocabulary the
      // transport's ("stdout", "tool_use") and let the two paths drift apart. A record with no
      // wire form is still written; it simply publishes nothing.
      const emit = (rawPayload: SessionEventPayload) => {
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
        const frame = toTaskEvent(payload, taskId, sessionId, at);
        if (frame) deps.hub.publish(channel, frame);
        writes = writes
          .then(() => appendSessionEvent(db, workspaceId, { sessionId, seq: at, payload }))
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
      // path from its very first round — as does a Claude Code Task whose primary attachment
      // named a base ref or a branch of its own.
      const resuming = wt;
      const handle = runner.start({
        command,
        args,
        cwd: resuming ? resuming.path : repoPath,
        env: shaped.data,
        worktreeName: resuming ? null : worktreeNameForTask(taskId),
        prompt: brief,
        onEvent: (e) => {
          // The agent's channel decides what kind of record this is. `user` is the operator's
          // own steering echoed back, `system` is the machinery talking about itself, and the
          // rest is the model — the distinction the log could not previously make at all.
          if (e.kind === "stdout") emit(textPayload(e.channel, e.text));
          else if (e.kind === "tool_use") emit({ kind: "tool_call", name: e.name, callId: null });
          else if (e.kind === "permission_request") {
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
      let adopted: Worktree;
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
      // Across every worktree, not just the primary: a round that only touched a secondary
      // repository still produced work, and answering "did anything change" from one directory
      // would call that round empty.
      let changed = false;
      for (const entry of worktreeBindings(adopted)) {
        if (await deps.worktree.hasChanges(entry.worktree.path, patternsFor(entry))) {
          changed = true;
          break;
        }
      }
      return { kind: "completed" as const, changed, worktree: adopted };
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
      // because that is the first moment GateControl knows which directory the agent used.
      logWorktreeBinding(log, { workspaceId, taskId, worktreePath: run.worktree.path });
    }

    if (run.kind === "failed") {
      if (run.cls === "park") {
        await step.run(`park-${round}`, async () => {
          await setTaskState(db, workspaceId, taskId, "parked");
          await recordTransition("running", "parked");
        });
        logStateTransition(log, { workspaceId, taskId, from: "running", to: "parked" });
        announce("parked");
        // Resume when the quota window resets (~5h). A budget/quota check would refine this.
        await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + 5 * 60 * 60 * 1000));
        continue;
      }
      // credential_expired or hard failure: pause/stop with the reason preserved.
      await step.run(`fail-${round}`, async () => {
        await setTaskState(db, workspaceId, taskId, "failed", { failureReason: run.cls });
        await recordTransition("running", "failed", run.cls);
      });
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      captureException(log, new Error(`task run failed: ${run.cls}`), { failureReason: run.cls });
      return { taskId, result: run.cls };
    }

    // Completed: move to review and wait for a human decision.
    const worktree = run.worktree;
    const gate = worktreeBindings(worktree);
    await step.run(`to-review-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "review");
      await recordTransition("running", "review");
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
          const captured = await deps.worktree.diff(entry.worktree.path, patternsFor(entry));
          await appendSessionEvent(db, workspaceId, {
            sessionId,
            seq: await nextSessionEventSeq(db, workspaceId, sessionId),
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
        // One commit per worktree, and each attachment records the branch its own change landed
        // on: a single column on `task` could only ever name one of the branches a reviewer
        // would then need to fetch (issue #7 AC-4).
        //
        // A worktree the agent never touched is skipped rather than committed. `git commit` with
        // nothing staged exits non-zero, so committing it unconditionally would fail the whole
        // approve step — including for the repository the agent *did* change. That case is now
        // ordinary rather than exotic: the agent runs in one working directory, so a Task
        // spanning three repositories routinely reaches the gate having changed one of them. The
        // branch is still recorded, because it exists and is what a reviewer would fetch.
        for (const entry of gate) {
          if (await deps.worktree.hasChanges(entry.worktree.path, patternsFor(entry))) {
            await deps.worktree.commit(
              entry.worktree.path,
              `GateControl: task ${taskId}`,
              patternsFor(entry),
            );
          }
          await setTaskRepositoryResultBranch(
            db,
            workspaceId,
            entry.binding.attachment.id,
            entry.worktree.branch,
          );
        }
        await setTaskState(db, workspaceId, taskId, "done");
        await recordTransition("review", "done");
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
        for (const entry of gate) await deps.worktree.discard(entry.worktree.path);
        await setTaskState(db, workspaceId, taskId, "ready");
        await recordTransition("review", "ready");
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
      await step.run(`resume-blocked-${round}`, async () => {
        await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
        await recordTransition("review", "failed", reason);
      });
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
    await step.run(`resume-${round}`, async () => {
      await setTaskState(db, workspaceId, taskId, "running");
      await recordTransition("review", "running");
    });
    logStateTransition(log, { workspaceId, taskId, from: "review", to: "running" });
    announce("running");
  }

  const adopted = wt;
  // Every worktree the Task was given, not just the primary — a secondary left behind would keep
  // its branch checked out and block the next launch from reusing it.
  const remaining = adopted
    ? worktreeBindings(adopted)
    : ctx.repositories.flatMap((binding) => {
        // Every attachment, not just the secondaries: when the primary's worktree is one
        // GateControl provisioned, a run that ended before the agent reported anything still has
        // that directory to remove.
        const worktree = provisionedByAttachment.get(binding.attachment.id);
        return worktree ? [{ binding, worktree }] : [];
      });
  if (remaining.length > 0) {
    await step.run("cleanup", async () => {
      for (const entry of remaining) {
        await deps.worktree.cleanup(entry.worktree.repoPath, entry.worktree.path);
      }
    });
  }
  return { taskId, result: "done" };
}

/** The setup-file allowlist of the Repository this worktree belongs to (issue #52). */
function patternsFor(entry: WorktreeBinding): string[] {
  return entry.binding.repository.setupFilePatterns ?? [];
}

/**
 * The other repositories the agent has been given, as absolute paths it can `cd` into.
 *
 * The agent runs in exactly one working directory, so this is the *only* way it learns that a
 * second repository is part of its Task at all (issue #7, the stated limitation). The primary's
 * path is unknown on the first round of a `--worktree` protocol — the agent has not created it
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
      // The branch the agent will actually find itself on. A worktree GateControl provisioned is
      // on the attachment's branch by construction, and one that does not exist yet will be —
      // but a worktree the agent made for itself is on a branch it named (`gatecontrol-task-<id>`,
      // not `gatecontrol/task-<id>`), which is only knowable once git has been asked. Until then
      // the brief says nothing rather than naming a branch that does not exist: the brief is the
      // *only* mechanism by which a multi-repository agent learns its own layout, so a wrong
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
  /** True for the one the agent process is started in. */
  primary: boolean;
}

/**
 * The brief handed to the agent. Round one is the Issue and the Task; later rounds lead with the
 * reviewer's feedback, because that — not the original brief — is what still needs doing.
 *
 * A Task spanning more than one Repository also gets a `# Repositories` section. The agent is
 * started in one working directory and has no other way of discovering that the Task covers a
 * second repository, so naming the other worktrees is not a nicety — it is the whole mechanism
 * (issue #7). A single-Repository Task's brief is byte-identical to what it was before.
 */
export function agentBrief(
  ctx: TaskRunContext,
  feedback?: string | undefined,
  workspaces: readonly BriefWorkspace[] = [],
): string {
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
  if (feedback?.trim()) {
    parts.push(
      `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${feedback.trim()}`,
    );
  }
  return parts.join("\n\n");
}

export const taskRun = inngest.createFunction(
  {
    id: "task-run",
    retries: TASK_RUN_RETRIES,
    triggers: [{ event: "task.launch.requested" }],
    /**
     * Cancellation channel for a run the operator wants gone — today, the force delete of the
     * Issue the Task belongs to (`issue.delete` with `force`). Scoped by `taskId` so a stop for
     * one Task never unwinds another's run.
     *
     * Inngest cancels *between* steps, so this is not instantaneous: the current step finishes,
     * then the run stops. That is why the deleting side re-checks Task state inside its own
     * transaction instead of treating the accepted stop as proof the agent is already gone.
     */
    cancelOn: [{ event: "task.stop.requested", if: "async.data.taskId == event.data.taskId" }],
  },
  (args) => runTaskLifecycle(defaultDeps(), args as unknown as TaskRunArgs),
);
