import type {
  ExecutorConfig,
  HarnessProtocol,
  WorkflowAdvanceOn,
  WorkflowAdvanceStatus,
  WorkflowStepDto,
  WorkflowStepGate,
} from "@solow/contracts";
import type { Db } from "@solow/db";
import type { Logger } from "@solow/observability";
import type { TaskRepositoryBinding, TaskRunContext } from "../../../data.js";
import type { ExecutorFactoryOpts } from "../../../executor/factory.js";
import type { PreflightResult } from "../../../executor/preflight.js";
import type { Executor } from "../../../executor/types.js";
import type { HarnessRegistry } from "../../../harness/registry.js";
import type { HarnessRunner } from "../../../harness/runner.js";
import type { HarnessLaunchSettings } from "../../../harness/runners.js";
import type {
  CloneCredential,
  ProvisionParams,
  Worktree,
  WorktreeDiff,
} from "../../../worktree/manager.js";
import type { SetupFileSeedResult } from "../../../worktree/setup-files.js";

/*
 * The shapes the run engine's parts share: what the lifecycle is injected with, and the few
 * values that pass between its parts. `task-run.ts` re-exports the public ones.
 */

/**
 * One attached Repository, paired with the worktree the lifecycle is acting on for it.
 *
 * Every plural step — diff, commit, discard, cleanup — walks a list of these rather than a list
 * of paths, because each one needs the Repository's own setup-file allowlist and its own
 * attachment id to write a result branch back to.
 */
export interface WorktreeBinding {
  binding: TaskRepositoryBinding;
  worktree: Worktree;
}

/** The setup-file allowlist of the Repository this worktree belongs to (issue #52). */
export function patternsFor(entry: WorktreeBinding): string[] {
  return entry.binding.repository.setupFilePatterns ?? [];
}

/**
 * The harness binding and brief in force for the round about to run (issue #5, AC-3).
 *
 * A *leg* rather than a Step, because a Step is not the unit this loop counts. The round counter
 * stays monotonic across Step boundaries — see the loop — so what actually changes at a boundary
 * is which harness is launched and which brief it is given, and this is exactly those two things.
 *
 * Every field is null for a Task on no Workflow, and the two that are not — the Profile and the
 * catalog row — are then the Task's own. That is why the leg exists at all instead of the Step's
 * Profile being written over `ctx.harnessProfile` in `loadTaskRunContext`: roughly a quarter of
 * this file reads `ctx.harnessProfile`, and a Task with no Workflow must not move at all.
 */
export interface RunLeg {
  /** The Workflow Step this leg runs, or null for a Task following no Workflow. */
  stepId: string | null;
  stepName: string | null;
  gate: WorkflowStepGate | null;
  /** Which signal finishes this Step. Read at both advance call sites — never a literal. */
  advanceOn: WorkflowAdvanceOn | null;
  harnessProfile: TaskRunContext["harnessProfile"];
  harnessCatalog: TaskRunContext["harnessCatalog"];
  /**
   * What the Step said about how much its harness may do without asking, or null for "whatever
   * the Profile says". On the leg beside the Profile because it is resolved against it — see
   * `launchSettingsFor` — and because a Step boundary has to be able to change it.
   */
  permissionMode: WorkflowStepDto["permissionMode"];
  /** What this Step's harness stops for (`harness/checkpoints.ts`); none on a Task with no Step. */
  checkpoints: WorkflowStepDto["checkpoints"];
  /**
   * The Step's prompt with the previous Step's handoff already prepended — `buildStepBrief`'s
   * output, carried from `loadTaskWorkflowRun` or from the advance DTO and never re-derived here.
   * One string, built in one place, so the API's preview and the harness's prompt cannot drift.
   */
  stepBrief: string | null;
}

/**
 * What reporting a Step finished came back as, from the loop's point of view.
 *
 * `failed` folds every error the shared transaction can return *except* `StaleCursor`, which is
 * resolved into one of the other two before it gets here — see `reportStepFinished`.
 */
export type LegAdvance =
  | { kind: "advanced"; stepId: string; brief: string }
  | { kind: "status"; status: WorkflowAdvanceStatus }
  | { kind: "failed" };

/**
 * Worktree operations the lifecycle depends on (real impls in `defaultDeps`), already bound to
 * an `Executor` (issue #1) — the lifecycle itself stays executor-agnostic.
 */
export interface WorktreeOps {
  /**
   * Resolve the repository the harness will run in. Claude Code creates the Task's worktree
   * itself (`--worktree`), so for that protocol this is all the preparation there is.
   */
  prepare(params: ProvisionParams): Promise<string>;
  /**
   * Create the Task's worktree, for a protocol whose harness cannot (issue #58). ACP has no
   * notion of a worktree: the harness works in the `cwd` it is handed, so SoloW makes the
   * directory and points it there. The isolation guarantee is unchanged (Principle II) — only
   * who runs `git worktree add` moves.
   */
  provision(params: ProvisionParams): Promise<Worktree>;
  /** Confirm with git that the path the harness reported really is a worktree of the repository. */
  adopt(repoPath: string, reportedPath: string | null): Promise<Worktree>;
  /** Copy the Repository's allowlisted setup files into a freshly created worktree (issue #52). */
  seed(params: {
    repoPath: string;
    worktreePath: string;
    patterns: string[];
  }): Promise<SetupFileSeedResult>;
  commit(path: string, message: string, setupFilePatterns: string[]): Promise<void>;
  discard(path: string): Promise<void>;
  /**
   * Move the branch an approved Task committed into the Repository the Owner has (issue #96
   * round 2). A no-op for a Task that worked in that Repository directly; the one write to it
   * for a Task given a clone of its own.
   */
  publish(repoPath: string, upstreamPath: string, branch: string): Promise<void>;
  /**
   * Push the approved branch to the remote its Repository was imported from (A1). Only called for
   * a Repository that has one; a local-only Repository never reaches it.
   */
  push(
    upstreamPath: string,
    remoteUrl: string,
    branch: string,
    credential: CloneCredential,
  ): Promise<void>;
  /** Remove the Task's worktree, and — when it was given one — the clone it was added onto. */
  cleanup(repoPath: string, worktree: string, ownRepository?: boolean): Promise<void>;
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
   * function rather than a runner because the protocol comes from the Task's own Harness catalog
   * row: two Tasks in one Workspace can be driven over two different protocols.
   */
  /**
   * Built per run, not once per process: a Harness Profile carries its own permission mode
   * (spec F05), so two Tasks in the same Workspace can run the same harness under different
   * postures — one that may reach the shell, one that may not.
   */
  runner: (
    protocol: HarnessProtocol,
    settings: HarnessLaunchSettings,
    executor: Executor,
  ) => HarnessRunner | null;
  worktreeRoot: string;
  repoCacheRoot: string;
  logger: Logger;
  /**
   * Where this Task runs, built from its own Executor Profile (issue #96, spec F07 AC-5).
   *
   * A function of the profile, because the profile is a property of the *Task*: two Tasks in one
   * Workspace can be pointed at two different execution hosts, and `defaultDeps()` is built
   * before either Task is known. One executor per process was what made `AVAILABLE_EXECUTOR_KINDS`
   * necessary in the first place — nothing downstream read the kind, so a Docker-profiled Task
   * would have run on the orchestrator's own host and reported success.
   */
  executorFor: (profile: { config: ExecutorConfig }, opts: ExecutorFactoryOpts) => Executor;
  /**
   * Whether that execution host can actually be provided, asked once per run inside a durable
   * step. Injected beside `executorFor` rather than reached for directly so a test can drive the
   * lifecycle's failure path without a daemon; both are handed the *same* options object, which
   * is how the probe's findings reach `spawn` (see `probeExecutorFor`).
   */
  preflight: (
    profile: { config: ExecutorConfig },
    opts: ExecutorFactoryOpts,
  ) => Promise<PreflightResult>;
  /**
   * The worktree operations, bound to the executor built for this run.
   *
   * A function of the executor, for the same reason `runner` is: every git command these issue
   * has to run *where the Task runs*. Bound once per run at the point the executor exists, so
   * the lifecycle below still calls `worktreeOps.commit(...)` and stays executor-agnostic.
   */
  worktree: (executor: Executor) => WorktreeOps;
  hub: HubLike;
  /** Where the hub finds the harness belonging to a Task, to deliver input or a stop. */
  registry: HarnessRegistry;
  /**
   * How long a declared-finished harness may stay silent before the round is ended
   * (`COMPLETION_GRACE_MS`). Injected only so a test can shorten it — the wait is real time, and
   * a test that spent fifteen seconds proving a timer fired would be a test nobody runs.
   */
  completionGraceMs?: number;
}

/** Minimal shape of the Inngest step tools the lifecycle uses (also satisfied by test fakes). */
export interface StepLike {
  run<T>(id: string, fn: () => T | Promise<T>): Promise<T>;
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
 * The run loop's own bindings — what a Step boundary, a review decision and a round read and
 * rebind. One object, owned by the lifecycle and handed to each part, so a part and the loop can
 * never disagree about which Step is in force.
 */
export interface LoopState {
  /**
   * The worktree every later step — diff, commit, discard, cleanup — acts on. Read back from
   * the harness (Claude Code makes its own) or set from what SoloW provisioned (ACP), and
   * confirmed with git either way before anything is written into it.
   */
  wt: Worktree | null;
  /**
   * The harness binding and brief this round runs under (issue #5, AC-3).
   *
   * Rebound, and so is the runner beside it — that pair is the whole of what a Step boundary
   * changes. Everything else the loop touches is per *round*, which is why there is no nested
   * Step loop: a nested one would reset `round` and Inngest would hand Step 2 back Step 1's
   * memoized `agent-run-0` and `approve-0`, silently skipping Step 2's harness run and replaying
   * Step 1's review decision. A monotonic counter makes that impossible to write.
   */
  leg: RunLeg;
  runner: HarnessRunner;
  /**
   * How many rounds this Step has had. `MAX_REVIEW_ROUNDS` is per Step, not per run: a
   * five-Step pipeline that spent its whole budget on Step 1 would otherwise reach Step 2 with
   * no rounds left and stop without saying why.
   */
  roundsOnStep: number;
  /**
   * How many rounds this Step has spent carrying on a conversation the harness's own budget cut
   * short, since the last round a reviewer was shown (`MAX_AUTO_CONTINUE_ROUNDS`).
   *
   * Reset wherever `roundsOnStep` is — at a Step boundary — and also on any round that does not
   * auto-continue: reaching the review gate is the harness having finished a stretch of work,
   * and the next stretch starts with its own budget rather than the remains of the last one's.
   */
  autoContinues: number;
  /**
   * Whether the round about to start is one of those, rather than one the reviewer asked for.
   *
   * A flag rather than a comparison against `autoContinues`, because the loop has to answer two
   * different questions from it: whether to spend one of the reviewer's rounds (it must not),
   * and what to tell the harness about why it is being started again.
   */
  continuingTruncated: boolean;
  /** Feedback from the previous review round; it becomes the next round's brief. */
  pendingFeedback: string | undefined;
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
  applyingDecisions: string | null;
  /**
   * The round about to start follows one whose `--resume` named a conversation the harness no
   * longer has (history: a transcript purged, or its worktree gone). Set once per run — the
   * second such failure is a real one — and what keeps the retry from asking to resume again.
   */
  resumeLost: boolean;
  /** The very next round is that retry, and does not spend a reviewer's round. */
  resumeLostRetry: boolean;
}

/** The loop's bindings as a run starts: on the entry Step, nothing spent, nothing pending. */
export function createLoopState(entry: {
  wt: Worktree | null;
  leg: RunLeg;
  runner: HarnessRunner;
}): LoopState {
  return {
    wt: entry.wt,
    leg: entry.leg,
    runner: entry.runner,
    roundsOnStep: 0,
    autoContinues: 0,
    continuingTruncated: false,
    pendingFeedback: undefined,
    applyingDecisions: null,
    resumeLost: false,
    resumeLostRetry: false,
  };
}
