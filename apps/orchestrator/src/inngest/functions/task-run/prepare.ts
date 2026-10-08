import { join } from "node:path";
import { TaskErrorCode, type WorkflowStepDto } from "@solow/contracts";
import { primaryTaskRepository, taskCheckoutBranch } from "@solow/core";
import { decryptForScmSync, loadTaskWorkflowRun } from "@solow/db";
import { captureException, logStateTransition } from "@solow/observability";
import { cloneUsernameFor } from "@solow/scm";
import {
  appendSessionEvent,
  loadWorkflowStepHarnesses,
  markWorktreesRemoved,
  nextSessionEventSeq,
  recordWorktree,
  retainedWorktree,
  setTaskState,
  type TaskRepositoryBinding,
} from "../../../data.js";
import { hasDriver, missingDriverReason } from "../../../executor/drivers.js";
import type { ExecutorFactoryOpts } from "../../../executor/factory.js";
import {
  harnessCreatesOwnWorktree,
  hasHarnessRunner,
  missingHarnessRunnerReason,
} from "../../../harness/protocols.js";
import { type HarnessLaunchSettings, unsupportedLaunchSettings } from "../../../harness/runners.js";
import {
  type CloneCredential,
  checkpointStorePath,
  harnessTranscriptsPath,
  isRepositoryUnusable,
  type ProvisionParams,
  taskRepositoryPath,
  type Worktree,
  worktreePath,
} from "../../../worktree/manager.js";
import { launchSettingsFor, unsupportedLaunchSettingsNotice } from "./advance.js";
import type { DecidedReview } from "./decision.js";
import type { RunScope } from "./scope.js";
import { failRun } from "./terminal.js";
import type { RunLeg, TaskRunDeps, WorktreeBinding } from "./types.js";

/*
 * Preparing a run: resolving the Workflow Step it enters on, refusing what cannot run before
 * anything is cloned, building the executor, and preparing, provisioning and seeding the working
 * copies the rounds work in. Each part returns either what the run needs next or the terminal
 * result the run ends with.
 */

/** The run ends here, with this result. */
function terminal(result: { taskId: string; result: string }) {
  return { ok: false as const, result };
}

/**
 * The credential for cloning one of the Task's Repositories, or undefined when it needs none.
 *
 * Per binding, not per Task: two attachments can come from two different Integrations, and a
 * single credential could only ever be right for one of them (issue #7).
 */
function cloneCredentialFor(binding: TaskRepositoryBinding): CloneCredential | undefined {
  if (!binding.scmClone) return undefined;
  return {
    // Read off the provider's registration rather than a table maintained here: this was one of
    // the eight places a third provider had to be added to, and it is now the registry's answer
    // (F21 FR-9). An unregistered provider still clones — `git` is the conventional username and
    // every host here ignores it anyway, authenticating on the token.
    username: cloneUsernameFor(binding.scmClone.provider),
    token: decryptForScmSync(binding.scmClone.secretCiphertext),
  };
}

/**
 * The longest Workflow this run loop will walk (issue #5).
 *
 * A bound rather than a truncation, and the difference is the whole of it: silently running the
 * first twenty Steps of a twenty-five Step pipeline would drop five Steps of an Owner's process
 * and report the Task done. The number is a sanity limit on a hand-authored list, not a product
 * decision — a Workflow past it is refused by name so somebody can look at it.
 *
 * It also bounds the loop: `maxRounds` is `MAX_REVIEW_ROUNDS * stepCount`, so without this a
 * pathological Step list would decide how long one Inngest run may live.
 */
const MAX_WORKFLOW_STEPS = 20;

/**
 * How many times Inngest re-runs the function after a failure. Declared once and read by the
 * prepare step, which has to know whether there is another attempt left before it decides
 * between rethrowing a transient failure and reporting it.
 */
export const TASK_RUN_RETRIES = 2;

/**
 * The execution host the orchestrator's own bookkeeping runs on — see `repoAdmin`.
 *
 * Written as an Executor Profile configuration and built through the same factory as the Task's,
 * rather than by importing `createLocalExecutor` here: this file must not be the second place
 * that reaches for the host directly, and a test that fakes `executorFor` has to be able to fake
 * this one too or it would run real git against the machine it is running on.
 */
const HOST_EXECUTOR_CONFIG = { kind: "local", env: {} } as const;

/**
 * Where a Repository lives on the host, before anything has been cloned.
 *
 * The same two branches `resolveRepoPath` takes, and they must stay the same two: a local path is
 * used where the Owner put it, a remote URL is cloned into one directory of the cache named for
 * the URL. It is spelled out again here only because the container has to be described *before*
 * the clone that would otherwise answer the question — `prepare-repository` runs through this
 * very executor — and because the alternative the code used to take was to mount the whole cache
 * root, which is the isolation defect this replaces. If the cache layout ever moves, both halves
 * move together or a container mounts a directory the clone did not land in.
 */
export function repositoryHostPath(
  repoCacheRoot: string,
  repository: TaskRepositoryBinding["repository"],
): string {
  return repository.source === "local_path"
    ? repository.location
    : join(repoCacheRoot, encodeURIComponent(repository.location));
}

/**
 * The host directories this Task's container may see (issue #96, spec F07, Principle II).
 *
 * One entry per directory *this Task* uses, never the roots that hold every Task's. Mounting
 * `SOLOW_WORKTREE_ROOT` and `SOLOW_REPO_CACHE_ROOT` was the shortest description of "everything
 * the run might touch", and it handed every container a read-write view of every other Task's
 * worktree in the deployment, across Workspaces — Task A's harness could read the `.env` seeded
 * into Task B's worktree, and write over Task B's work while it was running.
 *
 * Naming the paths costs nothing now that they are derived rather than discovered: the driver
 * `mkdir -p`s every bind source before `docker run`, so a worktree that `provision-worktree` has
 * not created yet, and a cache clone `prepare-repository` has not made yet, are both fine to
 * name. `worktreePath` is the same function the provisioning calls, so the mount and the
 * directory git writes into cannot disagree.
 *
 * A worktree's `.git` is a *file* holding `gitdir: <absolute path>` into its parent repository's
 * `.git/worktrees/`, so the parent has to be mounted too or the worktree is not a git repository
 * at all from inside the container. When the parent was the repository the *deployment* shares,
 * that one necessity handed every container a read-write view of every other Task on the same
 * Repository — its committed and staged objects, its result branch, its worktree registrations
 * and its host paths. `ownClone` is the answer to it: the parent named here is then the Task's
 * own clone, and both directories in each pair belong to this Task and to nothing else.
 *
 * What a `local_path` Repository is allowed to be remains the driver's question, not this one:
 * `guardMountSource` refuses a source that would hand the harness the machine, and refusing it in
 * one place means the operator reads one sentence rather than two.
 *
 * Exported for the tests and the live isolation probe, which need the mount set a Task would
 * actually be given rather than a second opinion about what it should be.
 */
export function executorBindPaths(
  deps: Pick<TaskRunDeps, "worktreeRoot" | "repoCacheRoot">,
  taskId: string,
  repositories: readonly TaskRepositoryBinding[],
  ownClone = false,
): string[] {
  // Which attachment keeps the Task's own directory is decided by the same function the
  // lifecycle uses below, called twice rather than copied — a second rule for "which one is
  // primary" would mount one directory and provision another.
  const primary = primaryTaskRepository(
    repositories.map((binding) => ({ position: binding.attachment.position, binding })),
  ).binding;
  const paths: string[] = [];
  for (const binding of repositories) {
    const attachmentId = binding === primary ? undefined : binding.attachment.id;
    paths.push(worktreePath(deps.worktreeRoot, taskId, attachmentId));
    // The repository the worktree is added onto: this Task's own clone of it, or — for a local
    // run, which shares the orchestrator's filesystem anyway — the one the deployment holds.
    paths.push(
      ownClone
        ? taskRepositoryPath(deps.repoCacheRoot, taskId, attachmentId)
        : repositoryHostPath(deps.repoCacheRoot, binding.repository),
    );
  }
  return [...new Set(paths)];
}

/**
 * Everything the run settles before its executor is probed: the Workflow Step it enters on, the
 * harness binding for every Step, and the executor and git bindings for this Task.
 *
 * Returns the run's terminal result instead when the Task cannot start at all.
 */
export async function resolveEntry(scope: RunScope, decidedReview: DecidedReview | undefined) {
  const { deps, step, db, log, workspaceId, taskId, sessionId, ctx, recordTransition, announce } =
    scope;

  /**
   * Which Step of its Workflow this Task picks up on (issue #5, AC-5).
   *
   * Before `executor-preflight` and before anything is cloned, because everything the pre-clone
   * gates below check is per-Step under a Workflow: which binaries the pipeline can spawn, and
   * which protocols it speaks. A resume that ran after the clone would discover the fourth
   * Step's missing harness having already paid for three Steps of work.
   *
   * Read-only. `loadTaskWorkflowRun` deliberately does not write the resolved cursor back — the
   * web DAL's `taskHasBegunWorkflow` reads exactly those columns to refuse a re-attach, and a
   * merely-resolved cursor persisted here would make "this Task has begun its pipeline" true for
   * a Task whose harness never started.
   *
   * Skipped entirely — no step, no id — for a Task with no `workflowId` or in a Workspace with
   * `ff-workflows` off, which is what keeps the durable step sequence of every existing Task
   * byte-identical to what it was before this change.
   */
  const resumedWorkflow =
    ctx.workflowsEnabled && ctx.task.workflowId
      ? await step.run("workflow-resume", () => loadTaskWorkflowRun(db, workspaceId, taskId))
      : null;
  if (resumedWorkflow && !resumedWorkflow.ok) {
    /*
     * The cursor names a Step this Workflow no longer contains — `resumeWorkflowCursor` refuses
     * that on purpose, and this side must not undo it. Restarting at Step one would silently
     * re-run work an Owner has already paid a harness for, at the moment they are least able to
     * notice; the honest answer is a failed Task with the reason on it.
     */
    // No Step: the cursor names one this Workflow no longer contains, so there is no Step this
    // failure honestly belongs to.
    return terminal(await failRun(scope, "workflow-unresumable", "workflow_unresumable", null));
  }
  const wf = resumedWorkflow?.ok ? resumedWorkflow.data : null;
  if (wf && wf.steps.length > MAX_WORKFLOW_STEPS) {
    // Refused, never truncated: running the first `MAX_WORKFLOW_STEPS` of a longer pipeline
    // would drop the rest of an Owner's process and report the Task done.
    return terminal(
      await failRun(scope, "workflow-too-long", "workflow_too_long", wf.currentStep.id),
    );
  }

  /**
   * The Harness Profile behind every Step, resolved in one durable step (AC-3).
   *
   * Deliberately carries no credential — see `loadWorkflowStepHarnesses`. `step.run` memoizes what
   * it returns into Inngest's durable store, and `load` already puts one decryptable ciphertext
   * there; the Step's own is read at the point of use inside `agent-run-${round}` instead.
   */
  const stepHarnesses = wf
    ? await step.run("workflow-agents", () =>
        loadWorkflowStepHarnesses(
          db,
          workspaceId,
          wf.steps.map((entry) => entry.agentProfileId),
        ),
      )
    : null;
  if (stepHarnesses && !stepHarnesses.ok) {
    // A Profile or catalog row a Step names is gone. Failing by name beats launching the Step
    // under some other harness, which is the only alternative that keeps the run going.
    return terminal(
      await failRun(
        scope,
        "workflow-agents-missing",
        "workflow_step_agent_missing",
        wf?.currentStep.id ?? null,
      ),
    );
  }
  const stepHarnessByProfileId = new Map(
    (stepHarnesses?.ok ? stepHarnesses.harnesses : []).map(
      (entry) => [entry.agentProfileId, entry] as const,
    ),
  );

  /** The leg a Task with no Workflow runs, every round: its own Profile and its own brief. */
  const legForTask = (): RunLeg => ({
    stepId: null,
    stepName: null,
    gate: null,
    advanceOn: null,
    harnessProfile: ctx.harnessProfile,
    harnessCatalog: ctx.harnessCatalog,
    permissionMode: null,
    checkpoints: [],
    stepBrief: null,
  });

  /**
   * The leg one Workflow Step runs. Null only if its Profile is absent from the resolved set,
   * which `workflow-agents` above already refused — kept as a value rather than an assertion so
   * a future edit that loosens that gate fails legibly here instead of launching the wrong harness.
   */
  const legForStep = (workflowStep: WorkflowStepDto, brief: string): RunLeg | null => {
    const bound = stepHarnessByProfileId.get(workflowStep.agentProfileId);
    if (!bound) return null;
    return {
      stepId: workflowStep.id,
      stepName: workflowStep.name,
      gate: workflowStep.gate,
      advanceOn: workflowStep.advanceOn,
      harnessProfile: bound.harnessProfile,
      harnessCatalog: bound.harnessCatalog,
      permissionMode: workflowStep.permissionMode,
      checkpoints: workflowStep.checkpoints,
      stepBrief: brief,
    };
  };
  // Where a Step's checkpoint hook and this process meet — one directory per Task, beside its
  // transcripts, so a container can be handed it the same way (`harness/checkpoints.ts`).
  const checkpointStore = checkpointStorePath(deps.worktreeRoot, taskId);

  const entryLeg = wf ? legForStep(wf.currentStep, wf.brief) : legForTask();
  if (!entryLeg) {
    return terminal(
      await failRun(
        scope,
        "workflow-agents-missing",
        "workflow_step_agent_missing",
        wf?.currentStep.id ?? null,
      ),
    );
  }

  /**
   * A Harness Profile names the protocol its catalog row declares, and only some protocols have
   * a runner behind them (issues #10 and #58). Checked here, before anything is cloned: a Task
   * pointed at a protocol nothing speaks must fail with a legible reason, not crash deep inside
   * a runner that was never built for it.
   *
   * The *entry* leg's protocol under a Workflow, which is the Task's own when there is none. It
   * decides the pre-clone shape of the run — whether the harness makes its own worktree — and that
   * decision is taken once, before the first Step. Later Steps continue inside whatever the first
   * one ended up with (`resuming` in the run body), so a pipeline mixing protocols still has
   * exactly one worktree per attachment. Every Step's protocol is still checked for a runner
   * below; only this one shapes the clone.
   */
  const protocol = entryLeg.harnessCatalog.protocol;
  /**
   * What this Profile asked to launch with (issue #94).
   *
   * The Profile's settings, not a constant — that is the whole of AC-1 — and they reach the run
   * through the one seam that already existed for the permission mode. Under a Workflow this is
   * the entry Step's Profile; a Step boundary rebuilds it, and re-emits the notice below.
   */
  const launchSettings: HarnessLaunchSettings = launchSettingsFor(entryLeg, checkpointStore);

  /*
   * A setting this protocol cannot carry is **said**, never dropped (issue #94 AC-3).
   *
   * A Profile pinned to a model that its harness's protocol has no way to select would otherwise
   * run on whatever the harness chose, with the Profile still reading as though the pin held — a
   * silent substitution, which is the one outcome that AC forbids by name. It is a notice rather
   * than a refusal: the work can still be done, and failing a Task over a setting nobody can act
   * on mid-run would be the worse trade. The reviewer reads it in the same log as everything
   * else the run said about itself.
   */
  const unsupported = unsupportedLaunchSettings(protocol, launchSettings);
  // Said once per Step, by the run that launched it: a run a decision started is carrying on the
  // same Step under the same Profile, and a Step it advances to says its own (`takeAdvance`).
  if (unsupported.length > 0 && !decidedReview) {
    // The bare id stays reserved for this, the pre-loop emission. A Step boundary that finds its
    // own unsupported pins emits under `launch-settings-unsupported-${round}` instead, so a
    // Workflow cannot collide with the id a Task with no Workflow has always used.
    await step.run("launch-settings-unsupported", async () => {
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        workflowStepId: entryLeg.stepId,
        payload: { kind: "notice", text: unsupportedLaunchSettingsNotice(protocol, unsupported) },
      });
    });
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
      await recordTransition(ctx.task.state, "failed", entryLeg.stepId, reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return terminal({ taskId, result: "failed" as const });
  }

  /**
   * Does this Task get a repository of its own (issue #96 round 2, Principle II)?
   *
   * True whenever the harness runs somewhere other than the orchestrator's own host — today, in a
   * container. Everything the container can reach is a bind mount, and a repository two Tasks
   * share is therefore a repository each of them can read and write everything in: a reviewer
   * proved, on live containers, that Task A could read Task B's committed *and* merely staged
   * secrets out of it, rewrite the result branch B would be reviewed on, deregister B's worktree
   * and read B's private worktree path out of `.git/worktrees`. None of those is a Docker defect
   * and none is fixable in the mount set alone — a worktree's `.git` is a *file* pointing into
   * its parent's `.git/worktrees/`, so a Task that shares a parent shares everything in it.
   *
   * A local run keeps the shared repository. Two local Tasks already run as one uid on one
   * filesystem, so a clone apiece would cost a copy of the repository to buy nothing: F07 says
   * plainly which isolation the Local Executor provides and which it does not.
   */
  const ownClone = ctx.executorProfile.config.kind !== "local";

  /**
   * The executor this Task runs on, built from the Task's own Executor Profile (issue #96).
   *
   * Per run, not per process, and that is the whole of the wiring. `defaultDeps()` used to build
   * one local executor before any Task existed and close over it in the runner and all nine
   * worktree operations, so nothing downstream ever read the Profile's kind — adding a driver
   * without this would have re-opened the exact hole the gate above was written to plug: a Task
   * that asked for a container, ran on the orchestrator's own host, and reported success.
   *
   * Synchronous and free by construction (see `docker.ts`): Inngest re-executes this body from
   * the top at every step boundary, so anything expensive here would be paid for on every pass.
   * The container is created lazily, once, behind the preflight below.
   */
  const executorOpts: ExecutorFactoryOpts = {
    ids: { workspaceId, taskId, sessionId },
    /*
     * This Task's own worktree directory, not the root that holds every Task's.
     *
     * The jail is the driver's host-side path check and the container's `HOME`, so rooting it at
     * `SOLOW_WORKTREE_ROOT` gave the jailed `fs` API — the one API that is supposed to enforce
     * the boundary — a view of every other Task's worktree in the deployment, across Workspaces.
     * That is Principle II, and no acceptance criterion buys it back.
     *
     * Naming a directory that does not exist yet is safe on both drivers: the Docker driver
     * `mkdir -p`s every bind source before `docker run`, and `git worktree add` writes into an
     * empty directory quite happily. Under `claude --worktree` the harness makes its own worktree
     * inside the repository and never touches this path at all; that worktree stays reachable
     * because the repository it lives in is mounted, which is how it was reachable before.
     */
    jailRoot: worktreePath(deps.worktreeRoot, taskId),
    worktreeRoot: deps.worktreeRoot,
    repoCacheRoot: deps.repoCacheRoot,
    bindPaths: executorBindPaths(deps, taskId, ctx.repositories, ownClone),
    // The harness's transcripts, kept on the host so a containerised Task can resume its
    // conversation (history retention); the local driver ignores it — its `$HOME` is the host's.
    transcriptStore: harnessTranscriptsPath(deps.worktreeRoot, taskId),
    // Bound at its own path so the hook a Step's launch settings name is the file the container
    // runs; the local driver shares the filesystem and ignores it.
    checkpointStore,
    // What this run is going to spawn, probed once by the preflight so a missing harness binary
    // throws on the line the runners already guard rather than arriving as an exit 127.
    //
    // Every binary the *pipeline* can spawn under a Workflow, not just the entry Step's: the
    // probe is the one thing that runs before the clone, and discovering the fourth Step's
    // missing harness after three Steps of paid harness time is the ordering it exists to prevent.
    // Distinct, because two Steps routinely share one harness and probing it twice buys nothing.
    harnessCommands: wf
      ? [...new Set([...stepHarnessByProfileId.values()].map((e) => e.harnessCatalog.command))]
      : [ctx.harnessCatalog.command],
    // One map, shared by reference with the preflight that fills it — see `probeExecutorFor`.
    probedCommands: new Map(),
  };
  const executor = deps.executorFor(ctx.executorProfile, executorOpts);
  /** Every git command on the Task's *own* repository, run where the Task runs. */
  const worktreeOps = deps.worktree(executor);

  /**
   * The other half of the split `ownClone` forces: administration of the repositories the
   * deployment shares (issue #96 round 2).
   *
   * Cloning the Repository into the Task's own directory, adding and removing the worktree, and
   * moving the approved branch back are operations *on the shared repository*, and the container
   * is the one place they must not run — running them there is what put the shared repository in
   * the container's mount set in the first place. So they run where the orchestrator runs, the
   * same as `docker run` itself does, and the container is left holding nothing but this Task's
   * own two directories.
   *
   * Everything about the Task's *content* — commit, discard, status, diff, and the harness — stays
   * on the Task's executor, because after this split those touch only the Task's own repository.
   * That is what keeps the driver gate above honest: a Docker-profiled Task still does all of its
   * work in its container, and what moved to the host is bookkeeping no harness can influence.
   *
   * Identical to `worktreeOps` for a local run, where the two hosts are the same host.
   */
  const repoAdmin = ownClone
    ? deps.worktree(deps.executorFor({ config: HOST_EXECUTOR_CONFIG }, executorOpts))
    : worktreeOps;

  return {
    ok: true as const,
    wf,
    stepHarnessByProfileId,
    legForStep,
    checkpointStore,
    entryLeg,
    protocol,
    launchSettings,
    ownClone,
    executorOpts,
    executor,
    worktreeOps,
    repoAdmin,
  };
}

/** What `resolveEntry` settled, for a run that can start. */
export type RunEntry = Extract<Awaited<ReturnType<typeof resolveEntry>>, { ok: true }>;

/**
 * The working copies the rounds run in: the executor probed, every Step's runner checked, each
 * attached Repository prepared, the worktrees SoloW makes provisioned and seeded.
 *
 * Runs inside the lifecycle's `try`, so the executor is disposed whichever way this ends. Returns
 * the run's terminal result instead when a working copy cannot be made.
 */
export async function prepareWorkspace(scope: RunScope, entry: RunEntry, attempt: number) {
  const { deps, step, db, log, workspaceId, taskId, ctx, recordTransition, announce } = scope;
  const {
    wf,
    stepHarnessByProfileId,
    entryLeg,
    protocol,
    launchSettings,
    ownClone,
    executorOpts,
    executor,
    repoAdmin,
  } = entry;

  /**
   * Can this executor actually be provided (issue #96, spec F07 AC-6).
   *
   * One durable step, placed after the driver gate and *before* `prepare-repository` clones
   * anything. The placement is the acceptance criterion, not a preference: a probe that ran
   * after the clone would already have spent minutes of an operator's time to discover that
   * the image name is wrong. Everything slow about a container executor — the daemon
   * handshake, the pull, the container itself — lives inside this one step, for the same
   * reason the factory above does nothing.
   */
  const probe = await step.run("executor-preflight", () =>
    deps.preflight(ctx.executorProfile, executorOpts),
  );
  if (!probe.ok) {
    // The state write and the transition record stay in one `step.run`, exactly as the two
    // gates above do: split apart, an Inngest retry appends a second copy of the transition.
    await step.run("executor-unavailable-docker", async () => {
      await setTaskState(db, workspaceId, taskId, "failed", { failureReason: probe.reason });
      await recordTransition(ctx.task.state, "failed", entryLeg.stepId, probe.reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(probe.reason), { failureReason: probe.reason });
    return terminal({ taskId, result: "failed" as const });
  }
  /*
   * Put the probe's findings back into the map `spawn` reads.
   *
   * `step.run` memoizes its *return value*; the map the probe filled lives in this process and
   * is empty again on the replay pass that reads the memoized answer. Without this the replay
   * would spawn an unprobed command and fall through — still legible, but as an exit 127 from
   * inside the container instead of the synchronous throw `probe.ts` and
   * `claude-code-runner.ts` already catch. It is why the result carries the commands at all.
   */
  for (const command of probe.harnessCommands) executorOpts.probedCommands?.set(command, true);

  /**
   * The adapter that drives the harness, bound to the executor above (issues #10, #58, #96).
   *
   * Built here rather than beside the protocol, because a runner is a protocol *paired with
   * somewhere to spawn it*: built from a process-wide local executor, a Docker-profiled Task
   * would have started its harness on the orchestrator's host with an idle container beside it.
   * The "can this build drive the protocol at all" gate moves with it, so there is still one
   * place that question is asked, and it is still asked before anything is cloned.
   */
  const entryRunner = deps.runner(protocol, launchSettings, executor);
  /*
   * Every Step's protocol under a Workflow, not just the entry Step's (AC-3).
   *
   * A Task on a Workflow can speak three protocols before it is finished, and the whole point
   * of this gate is that the refusal arrives before anything is cloned. Checked in pipeline
   * order and reported on the first one that has no runner, so the operator is told about the
   * Step they will actually hit first.
   */
  const undrivenProtocol = wf
    ? wf.steps
        .map((entry) => stepHarnessByProfileId.get(entry.agentProfileId)?.harnessCatalog.protocol)
        .find((candidate) => candidate !== undefined && !hasHarnessRunner(candidate))
    : undefined;
  if (!hasHarnessRunner(protocol) || !entryRunner || undrivenProtocol) {
    const reason = missingHarnessRunnerReason(undrivenProtocol ?? protocol);
    await step.run("agent-runner-unavailable", async () => {
      await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
      await recordTransition(ctx.task.state, "failed", entryLeg.stepId, reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return terminal({ taskId, result: "failed" as const });
  }

  /**
   * The Repositories this Task works in, and which of them the harness is started in (issue #7).
   *
   * The lifecycle goes plural everywhere below — provisioning, seeding, diff capture, commit,
   * discard, cleanup — but the harness process gets exactly one working directory, and that is the
   * primary attachment. This is the stated limitation of multi-repository Tasks, not an
   * accident: the other worktrees are named to the harness in the brief, which is the only way an
   * harness can reach a repository it was not started in until per-repository integration (#100)
   * gives it a real surface. `primaryTaskRepository` is the single place that choice is made.
   */
  const primaryBinding = primaryTaskRepository(
    ctx.repositories.map((binding) => ({ position: binding.attachment.position, binding })),
  ).binding;
  const secondaryBindings = ctx.repositories.filter((binding) => binding !== primaryBinding);

  /**
   * Whether the harness is left to make the primary worktree itself (issue #7 AC-1/AC-2).
   *
   * `claude --worktree` makes its own, which is what lets several Tasks share one repository —
   * but it makes it from HEAD, on a branch it names itself, and neither is negotiable. So the
   * attachment decides: one that asks for nothing in particular gets the harness's worktree and
   * behaves exactly as it always has, while one that names a base ref or a branch of its own is
   * provisioned here and the harness is started inside it. Without this the Owner's `Base ref`
   * was accepted, stored, shown in the brief and silently ignored, and the *secondary*
   * attachments of the same Task honoured theirs — one Task behaving two ways.
   */
  const primaryAttachment = primaryBinding.attachment;
  const harnessMakesPrimaryWorktree =
    harnessCreatesOwnWorktree(protocol) &&
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
    ownClone,
    // Decrypted here, at the point of use, and handed straight to the clone — an imported
    // repository is private more often than not, and its Integration already holds the only
    // token that can read it (issue #15).
    cloneCredential: cloneCredentialFor(binding),
  });

  /**
   * Every attached repository, not the Task's worktree.
   *
   * The harness creates its own worktree under `claude --worktree`, which is what lets several
   * Tasks run against one repository at a time (Principle II). This step still resolves and
   * validates each repository up front, so an unusable location fails the Task before any harness
   * starts rather than surfacing as a confusing harness error later (TASK-015, issue #7 AC-3).
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
          repoPath: await repoAdmin.prepare(provisionParamsFor(binding)),
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
      await recordTransition(ctx.task.state, "failed", entryLeg.stepId, reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    return terminal({ taskId, result: "repository_unreachable" });
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
   * The Repository as the *deployment* holds it, which for a Task with its own clone is not
   * where it is working (issue #96 round 2).
   *
   * Two things need it and neither can take `repoPathFor`. The setup-file allowlist copies a
   * `.env` that is ignored by git and therefore exists only in the Owner's own working tree —
   * a clone carries what was committed, so seeding from one would silently find nothing and
   * hand the harness a worktree it cannot run the tests in (issue #52). And an approved branch
   * has to be published back into this repository to be a result at all (F08).
   *
   * The same two branches `prepareRepository` takes, which is why it is `repositoryHostPath`
   * rather than a third answer to "where does this Repository live".
   */
  const upstreamPathFor = (binding: TaskRepositoryBinding): string =>
    repositoryHostPath(deps.repoCacheRoot, binding.repository);

  /**
   * The worktrees SoloW creates itself — in their own durable step, before the first
   * round, so an orchestrator restart resumes with the same directories rather than branching a
   * second set from the base refs (Principle III).
   *
   * For a protocol whose harness makes its own worktree only the *secondary* attachments are
   * created here, and the harness still makes the primary — unless that attachment named a base
   * ref or a branch the harness has no way to honour, which puts it in this list too. For a
   * protocol whose harness cannot, SoloW creates all of them. Either way every attachment
   * ends up with an isolated worktree of its own, on the branch the attachment says it is on.
   *
   * Caught, not left to escape, for the same reason the prepare loop is: a Task that cannot be
   * given a workspace has to say so rather than sit in `running` with no failure reason. The
   * provisioning itself is idempotent (`provisionWorktree`), so relaunching or retrying the Task
   * after a fix reuses the same worktrees instead of colliding with the branches it left behind.
   */
  const toProvision = harnessMakesPrimaryWorktree ? secondaryBindings : ctx.repositories;
  const provisionedByAttachment = new Map<string, Worktree>();
  if (toProvision.length > 0) {
    const provisioning = await step.run("provision-worktree", async () => {
      const created: Array<{ attachmentId: string; worktree: Worktree }> = [];
      for (const binding of toProvision) {
        try {
          created.push({
            attachmentId: binding.attachment.id,
            worktree: await repoAdmin.provision(provisionParamsFor(binding)),
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
              await repoAdmin.cleanup(entry.worktree.repoPath, entry.worktree.path, ownClone);
            } catch (cleanupCause) {
              captureException(log, cleanupCause, { stage: "worktree-provision-rollback" });
            }
          }
          return { ok: false as const, repositoryName: binding.repository.name };
        }
      }
      // The rows that say these directories exist (Principle II), written only once every
      // attachment succeeded — the rollback above removes what a partial run made, and a row
      // pointing at a directory that is no longer there is worse than no row at all.
      const repositoryIdByAttachment = new Map(
        toProvision.map((binding) => [binding.attachment.id, binding.repository.id]),
      );
      for (const entry of created) {
        const repositoryId = repositoryIdByAttachment.get(entry.attachmentId);
        if (!repositoryId) continue;
        await recordWorktree(db, workspaceId, {
          taskId,
          repositoryId,
          path: entry.worktree.path,
          branch: entry.worktree.branch,
        });
      }
      return { ok: true as const, created };
    });

    if (!provisioning.ok) {
      const reason = `could not provision an isolated worktree for repository ${provisioning.repositoryName}`;
      await step.run("provision-failed", async () => {
        await setTaskState(db, workspaceId, taskId, "failed", { failureReason: reason });
        await recordTransition("running", "failed", entryLeg.stepId, reason);
      });
      logStateTransition(log, { workspaceId, taskId, from: "running", to: "failed" });
      announce("failed");
      return terminal({ taskId, result: "worktree_unavailable" });
    }
    for (const entry of provisioning.created) {
      provisionedByAttachment.set(entry.attachmentId, entry.worktree);
    }
  }
  const provisioned = provisionedByAttachment.get(primaryBinding.attachment.id) ?? null;

  /**
   * Copy each secondary worktree's own setup files in as soon as it exists (issue #52).
   *
   * The primary's copy waits for the harness to announce where it went — SoloW does not
   * always own that directory — but a secondary worktree is one SoloW just created, so
   * there is nothing to wait for and no path to confirm. Best-effort, like the primary's: a
   * pattern that matches nothing must not fail a Task that would otherwise run.
   */
  for (const binding of secondaryBindings) {
    const worktree = provisionedByAttachment.get(binding.attachment.id);
    const patterns = binding.repository.setupFilePatterns ?? [];
    if (!worktree || patterns.length === 0) continue;
    await step.run(`seed-secondary-${binding.attachment.id}`, async () => {
      try {
        await repoAdmin.seed({
          repoPath: upstreamPathFor(binding),
          worktreePath: worktree.path,
          patterns,
        });
      } catch (cause) {
        captureException(log, cause, { stage: "setup-files-seed" });
      }
    });
  }

  /**
   * The primary Repository's setup-file allowlist (issue #52): copied into the worktree the harness
   * creates, and subtracted from the diff and the commit, so a `.env` the harness needs to run
   * the tests never reaches the review UI or the branch. Each secondary uses its own, above.
   */
  const setupFilePatterns = primaryBinding.repository.setupFilePatterns ?? [];

  /**
   * Copy the setup files into the worktree the harness reported, having first made git confirm it
   * really is a worktree of this repository — writing a `.env` into a directory the harness merely
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
      const confirmed = await repoAdmin.adopt(repoPath, reportedPath);
      const result = await repoAdmin.seed({
        repoPath: upstreamPathFor(primaryBinding),
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
   * Every worktree this Task has, in attachment order, once the primary one is known.
   *
   * The primary is whatever the harness reported and git confirmed; the others are what SoloW
   * provisioned. An attachment with no worktree yet is left out rather than represented by a
   * placeholder — there is nothing to diff, commit or clean up for it.
   */
  const worktreeBindings = (primary: Worktree): WorktreeBinding[] =>
    ctx.repositories.flatMap((binding) => {
      const worktree =
        binding === primaryBinding ? primary : provisionedByAttachment.get(binding.attachment.id);
      return worktree ? [{ binding, worktree }] : [];
    });

  /**
   * The primary worktree an earlier round or Session left on disk, confirmed with git — or null.
   *
   * Only a `--worktree` harness needs looking for it: everywhere else SoloW provisioned the
   * primary above and `wt` already holds it. A row whose directory is gone is marked so, and the
   * caller carries on as though there were none.
   */
  const retainedPrimary = async (): Promise<Worktree | null> => {
    if (!harnessMakesPrimaryWorktree) return null;
    const secondaries = [...provisionedByAttachment.values()].map((entry) => entry.path);
    const row = await retainedWorktree(
      db,
      workspaceId,
      taskId,
      primaryBinding.repository.id,
      secondaries,
    );
    if (!row) return null;
    try {
      return await repoAdmin.adopt(repoPath, row.path);
    } catch (cause) {
      captureException(log, cause, { stage: "resume-worktree", path: row.path });
      await markWorktreesRemoved(db, workspaceId, taskId, [row.path]);
      return null;
    }
  };

  return {
    ok: true as const,
    entryRunner,
    primaryBinding,
    repoPath,
    upstreamPathFor,
    provisionedByAttachment,
    provisioned,
    seed,
    worktreeBindings,
    retainedPrimary,
  };
}
