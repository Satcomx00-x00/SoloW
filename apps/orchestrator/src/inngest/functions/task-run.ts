import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  type AgentProtocol,
  type ExecutorConfig,
  parseSessionEventPayload,
  reviewDecisionSchema,
  type SessionEventPayload,
  TaskErrorCode,
  type TaskState,
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
  classifyRunFailure,
  PARTIAL_INTEGRATION_REASON,
  primaryTaskRepository,
  taskCheckoutBranch,
} from "@solow/core";
import { createDb, type Db, decryptForScmSync } from "@solow/db";
import {
  captureException,
  createLogger,
  type Logger,
  logStateTransition,
  logWorktreeBinding,
  withRunContext,
} from "@solow/observability";
import { cloneUsernameFor } from "@solow/scm";
import { z } from "zod";
import { worktreeNameForTask } from "../../agent/claude-code-runner.js";
import {
  agentCreatesOwnWorktree,
  hasAgentRunner,
  missingAgentRunnerReason,
} from "../../agent/protocols.js";
import { type AgentRegistry, agentRegistry } from "../../agent/registry.js";
import type { AgentRunner, AgentTextChannel } from "../../agent/runner.js";
import {
  type AgentLaunchSettings,
  createAgentRunner,
  unsupportedLaunchSettings,
} from "../../agent/runners.js";
import { WIDGET_BRIEF_INSTRUCTIONS, WidgetFenceScanner } from "../../agent/widget-fence.js";
import { prepareAgentEnv } from "../../billing/guard.js";
import {
  appendSessionEvent,
  clearTaskCompletion,
  compactSession,
  isMissingParentRow,
  latestStateTransition,
  loadTaskRunContext,
  markWorktreesRemoved,
  nextSessionEventSeq,
  nextSessionUsageSeq,
  recordSessionUsage,
  recordTaskCompletion,
  recordWorktree,
  setSessionState,
  setTaskRepositoryResultBranch,
  setTaskState,
  type TaskRepositoryBinding,
  type TaskRunContext,
  unsatisfiedDependencyIds,
  updateAgentCatalogCapabilities,
} from "../../data.js";

import { orchestratorEnv } from "../../env.js";
import { hasDriver, missingDriverReason } from "../../executor/drivers.js";
import {
  createExecutorFor,
  type ExecutorFactoryOpts,
  probeExecutorFor,
} from "../../executor/factory.js";
import type { PreflightResult } from "../../executor/preflight.js";
import type { Executor } from "../../executor/types.js";
import { clearStrandedPark } from "../../reconcile.js";
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
  publishWorktreeBranch,
  taskRepositoryPath,
  type Worktree,
  type WorktreeDiff,
  worktreePath,
} from "../../worktree/manager.js";
import { type SetupFileSeedResult, seedSetupFiles } from "../../worktree/setup-files.js";
import { hub } from "../../ws/hub.js";
import { toTaskEvent } from "../../ws/replay.js";
import { inngest } from "../client.js";

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
 * How long a run parked on an exhausted quota sleeps before it wakes itself up.
 *
 * Roughly one quota window; a real budget check would replace the guess rather than tune it.
 *
 * Exported for one reason, and it is not reuse: `reconcile.ts` keeps a second copy of this value
 * (`PARK_WINDOW_MS`) because a sweep that runs every sixty seconds must not import this module and
 * everything it drags in, and that copy decides when a parked run is called lost. The drift has a
 * direction — grow this without growing that, and the sweep starts condemning runs that are still
 * legitimately asleep — so `reconcile.test.ts` pins the two equal, and this export is what lets it.
 */
export const PARK_SLEEP_MS = 5 * 60 * 60 * 1000;

/**
 * How long the review gate waits for a person before this run gives up on it.
 *
 * Exported for the same reason `PARK_SLEEP_MS` is, and not for reuse: `reconcile.ts` keeps a
 * second copy in milliseconds (`REVIEW_WAIT_MS`) because `reportStrandedParks` has to know when a
 * Session left `awaiting_review` by timing out rather than by a decision — a parked round that
 * reaches the gate leaves the Task reading `parked`, so that sweep is the only thing that will
 * ever look at the row again. `reconcile.test.ts` pins the two equal.
 */
export const REVIEW_WAIT_TIMEOUT = "7d";

/**
 * How many times Inngest re-runs the function after a failure. Declared once and read by the
 * prepare step, which has to know whether there is another attempt left before it decides
 * between rethrowing a transient failure and reporting it.
 */
const TASK_RUN_RETRIES = 2;

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
 * How long a declared-finished agent is given to say anything more before the round is ended.
 *
 * Long enough that a model which declares and then adds a closing paragraph is not cut off;
 * short enough that a run does not spend a meaningful part of Inngest's execution budget waiting
 * on a process that has nothing left to do. Every further event re-arms it, so this is a
 * *silence* budget rather than a deadline on the agent.
 */
const COMPLETION_GRACE_MS = 15_000;

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
   * notion of a worktree: the agent works in the `cwd` it is handed, so SoloW makes the
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
  /**
   * Move the branch an approved Task committed into the Repository the Owner has (issue #96
   * round 2). A no-op for a Task that worked in that Repository directly; the one write to it
   * for a Task given a clone of its own.
   */
  publish(repoPath: string, upstreamPath: string, branch: string): Promise<void>;
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
   * function rather than a runner because the protocol comes from the Task's own Agent catalog
   * row: two Tasks in one Workspace can be driven over two different protocols.
   */
  /**
   * Built per run, not once per process: an Agent Profile carries its own permission mode
   * (spec F05), so two Tasks in the same Workspace can run the same agent under different
   * postures — one that may reach the shell, one that may not.
   */
  runner: (
    protocol: AgentProtocol,
    settings: AgentLaunchSettings,
    executor: Executor,
  ) => AgentRunner | null;
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
  /** Where the hub finds the agent belonging to a Task, to deliver input or a stop. */
  registry: AgentRegistry;
  /**
   * How long a declared-finished agent may stay silent before the round is ended
   * (`COMPLETION_GRACE_MS`). Injected only so a test can shorten it — the wait is real time, and
   * a test that spent fifteen seconds proving a timer fired would be a test nobody runs.
   */
  completionGraceMs?: number;
}

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
      createAgentRunner(protocol, {
        executor,
        permissionMode: settings.permissionMode,
        ...(settings.model ? { model: settings.model } : {}),
        ...(settings.modeId ? { modeId: settings.modeId } : {}),
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
      cleanup: (repoPath, worktree, ownRepository) =>
        cleanupWorktree(executor, repoPath, worktree, { ownRepository }),
      hasChanges: (path, patterns) => hasChanges(executor, path, patterns),
      diff: (path, patterns) => diffWorktree(executor, path, patterns),
    }),
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
 * an agent's plan and the durable log, and its two failure modes pull in opposite directions —
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

  /**
   * Announce a Task state change to everyone watching it.
   *
   * Both channels, and the second one is the bug this replaces. It published to the board channel
   * alone, on the reasoning that the board is what shows Task states — but the Task page shows
   * one too, and it subscribes to the *task* channel. So a run that finished, failed or parked
   * updated the board instantly and left the page dedicated to that very Task claiming the agent
   * was still writing, until somebody reloaded. Every `diff` on the line below already went to
   * both; the status was the one that did not.
   *
   * Published twice rather than having the page subscribe to the board channel as well: a Task
   * page would then receive every state change in the Workspace and filter for its own, which is
   * a subscription to other people's work in order to learn about your own.
   */
  const announce = (state: TaskState) => {
    const message = { kind: "status" as const, taskId, state, at: new Date().toISOString() };
    deps.hub.publish(boardChannel, message);
    deps.hub.publish(channel, message);
  };

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
  /**
   * What this Profile asked to launch with (issue #94).
   *
   * The Profile's settings, not a constant — that is the whole of AC-1 — and they reach the run
   * through the one seam that already existed for the permission mode.
   */
  const launchSettings: AgentLaunchSettings = {
    permissionMode: ctx.agentProfile.permissionMode,
    ...(ctx.agentProfile.model ? { model: ctx.agentProfile.model } : {}),
    ...(ctx.agentProfile.modeId ? { modeId: ctx.agentProfile.modeId } : {}),
  };

  /*
   * A setting this protocol cannot carry is **said**, never dropped (issue #94 AC-3).
   *
   * A Profile pinned to a model that its agent's protocol has no way to select would otherwise
   * run on whatever the agent chose, with the Profile still reading as though the pin held — a
   * silent substitution, which is the one outcome that AC forbids by name. It is a notice rather
   * than a refusal: the work can still be done, and failing a Task over a setting nobody can act
   * on mid-run would be the worse trade. The reviewer reads it in the same log as everything
   * else the run said about itself.
   */
  const unsupported = unsupportedLaunchSettings(protocol, launchSettings);
  if (unsupported.length > 0) {
    await step.run("launch-settings-unsupported", async () => {
      await appendSessionEvent(db, workspaceId, {
        sessionId,
        seq: await nextSessionEventSeq(db, workspaceId, sessionId),
        payload: {
          kind: "notice",
          text: `This agent profile pins ${unsupported.join(" and ")}, which ${protocol} cannot select. The run used the agent's own choice instead.`,
        },
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
      await recordTransition(ctx.task.state, "failed", reason);
    });
    logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
    announce("failed");
    captureException(log, new Error(reason), { failureReason: reason });
    return { taskId, result: "failed" as const };
  }

  /**
   * Does this Task get a repository of its own (issue #96 round 2, Principle II)?
   *
   * True whenever the agent runs somewhere other than the orchestrator's own host — today, in a
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
     * empty directory quite happily. Under `claude --worktree` the agent makes its own worktree
     * inside the repository and never touches this path at all; that worktree stays reachable
     * because the repository it lives in is mounted, which is how it was reachable before.
     */
    jailRoot: worktreePath(deps.worktreeRoot, taskId),
    worktreeRoot: deps.worktreeRoot,
    repoCacheRoot: deps.repoCacheRoot,
    bindPaths: executorBindPaths(deps, taskId, ctx.repositories, ownClone),
    // What this run is going to spawn, probed once by the preflight so a missing agent binary
    // throws on the line the runners already guard rather than arriving as an exit 127.
    agentCommands: [ctx.agentCatalog.command],
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
   * Everything about the Task's *content* — commit, discard, status, diff, and the agent — stays
   * on the Task's executor, because after this split those touch only the Task's own repository.
   * That is what keeps the driver gate above honest: a Docker-profiled Task still does all of its
   * work in its container, and what moved to the host is bookkeeping no agent can influence.
   *
   * Identical to `worktreeOps` for a local run, where the two hosts are the same host.
   */
  const repoAdmin = ownClone
    ? deps.worktree(deps.executorFor({ config: HOST_EXECUTOR_CONFIG }, executorOpts))
    : worktreeOps;

  try {
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
        await recordTransition(ctx.task.state, "failed", probe.reason);
      });
      logStateTransition(log, { workspaceId, taskId, from: ctx.task.state, to: "failed" });
      announce("failed");
      captureException(log, new Error(probe.reason), { failureReason: probe.reason });
      return { taskId, result: "failed" as const };
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
    for (const command of probe.agentCommands) executorOpts.probedCommands?.set(command, true);

    /**
     * The adapter that drives the agent, bound to the executor above (issues #10, #58, #96).
     *
     * Built here rather than beside the protocol, because a runner is a protocol *paired with
     * somewhere to spawn it*: built from a process-wide local executor, a Docker-profiled Task
     * would have started its agent on the orchestrator's host with an idle container beside it.
     * The "can this build drive the protocol at all" gate moves with it, so there is still one
     * place that question is asked, and it is still asked before anything is cloned.
     */
    const runner = deps.runner(protocol, launchSettings, executor);
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
      ownClone,
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
     * The Repository as the *deployment* holds it, which for a Task with its own clone is not
     * where it is working (issue #96 round 2).
     *
     * Two things need it and neither can take `repoPathFor`. The setup-file allowlist copies a
     * `.env` that is ignored by git and therefore exists only in the Owner's own working tree —
     * a clone carries what was committed, so seeding from one would silently find nothing and
     * hand the agent a worktree it cannot run the tests in (issue #52). And an approved branch
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
     * For a protocol whose agent makes its own worktree only the *secondary* attachments are
     * created here, and the agent still makes the primary — unless that attachment named a base
     * ref or a branch the agent has no way to honour, which puts it in this list too. For a
     * protocol whose agent cannot, SoloW creates all of them. Either way every attachment
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
     * The primary's copy waits for the agent to announce where it went — SoloW does not
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
     * The worktree every later step — diff, commit, discard, cleanup — acts on. Read back from
     * the agent (Claude Code makes its own) or set from what SoloW provisioned (ACP), and
     * confirmed with git either way before anything is written into it.
     */
    let wt: Worktree | null = provisioned;

    /**
     * Every worktree this Task has, in attachment order, once the primary one is known.
     *
     * The primary is whatever the agent reported and git confirmed; the others are what SoloW
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
          /*
           * What a command run by *this* executor would inherit, not what the orchestrator
           * inherited (issue #96, §1). `SpawnOpts.env` replaces the child's environment wholesale,
           * so the base has to describe the machine the agent is actually on: handing a
           * containerised agent the host's `PATH` and `HOME` describes a machine it is not running
           * on, and it then fails for reasons that have nothing to do with the Task. Identical to
           * `process.env` for the local driver, which is what it always was.
           */
          baseEnv: await executor.baseEnv(),
          subscriptionEnvVar: ctx.agentCatalog.subscriptionEnvVar,
          meteredEnvVar: ctx.agentCatalog.meteredEnvVar,
          // The Executor Profile's environment (issue #73). It is applied under the credential
          // shaping, never over it, so a profile cannot become a route to metered billing.
          profileEnv: ctx.executorProfile.config.env ?? {},
        });
        if (!shaped.ok) return { kind: "failed" as const, cls: CREDENTIAL_EXPIRED_REASON };

        // What must never reach a payload, computed from the env this run actually shaped rather
        // than from a list of variable names, so it holds for whichever Agent is running.
        const needles = secretNeedles(shaped.data, ctx.agentCatalog, ctx.secretCiphertext);

        // Every streamed event is published live *and* appended to the session log, so a client
        // that reconnects can replay from `seq` instead of losing history (TASK-018). Writes are
        // chained to keep log order identical to stream order.
        let seq = await nextSessionEventSeq(db, workspaceId, sessionId);
        let writes: Promise<unknown> = Promise.resolve();

        /**
         * The run outlived the rows it writes into.
         *
         * A Task can be deleted — or its Issue force-deleted — while its agent is mid-turn:
         * cancellation happens *between* Inngest steps, and stopping an agent is a request, not an
         * instant. `cascadeDeleteTasks` takes the `session` row with the Task, so every event this
         * run appends afterwards fails on `session_event.session_id`'s foreign key.
         *
         * What that produced was one logged stack trace per chunk of agent output, for a run whose
         * transcript has nowhere to live, whose work nobody will review, and which keeps spending
         * tokens until it finishes on its own. So the first such failure latches here: the log
         * says it once, the agent is stopped, and the rest of the round is skipped.
         */
        let abandoned = false;
        /** Set once the agent exists, so `abandon` can stop something that started after it. */
        let live: { stop: () => Promise<void> | void } | null = null;

        const abandon = (stage: string) => {
          if (abandoned) return;
          abandoned = true;
          log.warn(
            { stage },
            "the Session this run writes to no longer exists — it was deleted while the agent was live; stopping the agent and abandoning the round",
          );
          try {
            void live?.stop();
          } catch (cause) {
            captureException(log, cause, { stage: "abandon-stop" });
          }
        };
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
         * Ending the round once the agent has said it is finished and gone quiet.
         *
         * `await handle.outcome` waits for the agent **process to exit**, and a declaring agent
         * does not exit — Claude Code says `task_complete` and then sits waiting for whatever the
         * operator wants next. That is a reasonable thing for a CLI to do and a fatal thing for a
         * durable run to wait on: the step never returns, so Inngest never checkpoints it, the
         * platform kills the request after its execution budget (8 minutes, observed), and the
         * whole function is retried from the top — for ever. The gate step below it never runs, so
         * `waitForEvent` is never reached, so the `review.decided` event an approval publishes
         * arrives at a run that is not listening. That is the failure this file's own comment
         * predicted ("an agent that declares and then waits for the operator does not exit") and
         * worked around for the *board* by recording the declaration mid-run; the run itself was
         * still hanging.
         *
         * So the declaration ends the round — after a grace period, not at once. The comment on
         * `completion` is right that an agent can declare and keep working: a `task_complete`
         * followed by more output is a declaration that has been superseded, and cutting the agent
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
          // The agent is still talking, so whatever it declared is not the last word yet.
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
          const frame = toTaskEvent(payload, taskId, sessionId, at);
          if (frame) deps.hub.publish(channel, frame);
          writes = writes
            .then(() => appendSessionEvent(db, workspaceId, { sessionId, seq: at, payload }))
            .catch((cause) =>
              isMissingParentRow(cause)
                ? abandon("session-event-append")
                : captureException(log, cause, { stage: "session-event-append" }),
            );
        };

        /**
         * Where the agent went, resolved as soon as it says so.
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
         * A resuming round already holds it. A first round with a `--worktree` agent does not: the
         * directory is the agent's to create, and it announces the path before its first turn.
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
         * The change the agent has made so far, captured at the boundary of every turn that
         * touched a file.
         *
         * The Changes panel renders `diff` records, and until now exactly one place wrote them:
         * the step that moves a Task to review. An agent that stops mid-run to ask a question —
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
         * than starting a second. Two concurrent reads of a tree the agent is still writing buy
         * nothing but contention — but *dropping* the later turn would leave the panel showing a
         * state the agent has already moved on from, which is the failure this whole capture
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
         * Widgets the agent drew and is still waiting on, by the id this run gave them.
         *
         * The book is per-run and in memory for the same reason the agent registry is: an answer
         * is only deliverable while the process that asked is alive. A run that ends with widgets
         * outstanding leaves them in the log as questions nobody answered, which is exactly what
         * they were.
         */
        const pendingWidgets = new Map<string, Widget>();
        /**
         * The last `task_complete` the agent emitted this round, if it emitted one at all.
         *
         * A holder rather than a bare `let`: the only assignment is inside the output callback, and
         * the compiler cannot see that callback run — it would narrow a `let` to `null` at every
         * read below and refuse the field accesses.
         */
        const completion: { widget: Extract<Widget, { kind: "task_complete" }> | null } = {
          widget: null,
        };
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
          // request to draw one, and the operator's own steering is not the agent's to render.
          if (!ctx.widgetsEnabled || thinking) {
            emit({ kind: "assistant_turn", text, thinking });
            return;
          }
          const out = scanner.push(text);
          if (out.text !== "") emit({ kind: "assistant_turn", text: out.text, thinking });
          for (const widget of out.widgets) {
            const widgetId = randomUUID();
            if (widgetExpectsResponse(widget)) pendingWidgets.set(widgetId, widget);
            /*
             * The agent saying how its run ended.
             *
             * Held for the end of the run, because an agent can emit this and then keep working —
             * it is prose, not a tool call, and nothing stops it — so what counts is the last one
             * standing when the run actually ends.
             *
             * *And* written down immediately, which is the part that was missing. The declaration
             * used to reach the Task row only when the agent's process exited, and an agent that
             * declares and then waits for the operator does not exit: a run could sit for eleven
             * minutes having said "changes_ready" with the board still drawing it as working, and
             * no amount of refreshing would have helped — there was nothing to fetch. A later
             * declaration overwrites this one, which is the same "last one standing" rule.
             */
            if (widget.kind === "task_complete") {
              completion.widget = widget;
              const declared = widget;
              // The agent has said it is done. Give it room to say more, then end the round —
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
            emit({ kind: "widget", widgetId, widget });
          }
        };

        // Launch command and arguments come from the Agent's catalog row (issue #10) — not a
        // global env var, since two Agent Profiles in the same Workspace can point at different
        // catalog entries.
        const { command, argsTemplate: args } = ctx.agentCatalog;
        // First round with a `--worktree`-capable agent: run in the repository and have it create
        // the Task's worktree. Later rounds continue *inside* that worktree — a reviewer asking
        // for changes wants the work carried on, and asking for the worktree again would branch a
        // fresh one from the base ref and throw the earlier round away. An ACP Task arrives here
        // with `wt` already set to the worktree SoloW provisioned, so it takes the same
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
              // in the transcript, with the agent's plan discarded alongside it. Emitting the list
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
               * Cache what the agent advertised (issue #94 AC-2), on the same fire-and-forget
               * chain as the completion record: the run must not fail because its narration did
               * not land, and a capability list is narration — the fallback a Settings form reads
               * between runs, never something this run depends on.
               */
              const advertised = { models: e.models, modes: e.modes };
              writes = writes
                .then(() =>
                  updateAgentCatalogCapabilities(db, workspaceId, ctx.agentCatalog.id, advertised),
                )
                .catch((cause) => captureException(log, cause, { stage: "capabilities-cache" }));
            } else recordUsage(e);
          },
        });
        live = handle;
        // Hand the reported path to the turn capture the moment the agent states it — the capture
        // is already running by now, waiting on exactly this.
        void handle.workspacePath.then(announcePath, () => announcePath(null));
        // Publish the handle for the lifetime of the run so the hub can deliver the operator's
        // input or stop to *this* agent (TASK-022), and withdraw it the moment the run ends.
        const deregister = deps.registry.register(workspaceId, {
          taskId,
          sessionId,
          handle,
          /**
           * Answer one of this run's widgets: validate against the widget that asked, record the
           * answer in the log, then tell the agent in a line it can read. The agent is not blocked
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
          disarmCompletionStop();
          deregister();
          // Drain an in-flight turn capture first: it appends through `emit`, so a capture still
          // running would otherwise chain its write on after the drain below had already passed.
          await pendingCapture;
          // Drain queued log and usage writes even when the run threw. Usage in particular
          // cannot be re-obtained — the agent reports it once — so abandoning the chain on a
          // mid-turn failure would lose it permanently rather than merely delay it.
          await writes;
        }

        // Reported before the worktree is adopted, on purpose: everything below this line writes
        // to rows that no longer exist (compaction, the state transition, the captured diff), so
        // continuing would turn one deleted Task into a failing step and a retried run.
        if (abandoned) return { kind: "abandoned" as const };

        // Confirm with git that the reported path really is a worktree of this repository. An
        // agent working somewhere else has not been isolated, and committing from wherever it
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
         * The agent finished — written down here, inside the step that learned it, and not two
         * steps later when the Task is moved to review.
         *
         * That gap is a bug with a Failed column full of evidence for it. Completion used to exist
         * only as this function's return value: real, in memory, and recorded nowhere. Anything
         * that lost the run before `to-review` committed — a restart, a `bun --hot` reload, an
         * engine that dropped an in-flight run — left no trace that the agent had ever finished, so
         * the reclaim sweep found a `running` Task with no agent, could not tell "died mid-work"
         * from "died having finished", and marked it `failed`. Work that was done and committed
         * ended up filed as a failure.
         *
         * A durable row before the fragile part is the whole fix. It carries the branch because
         * that is what the review gate opens, and whatever the agent said about stopping, because
         * that is the only thing here it could have told us itself.
         */
        emit({
          kind: "agent_done",
          changed,
          branch: adopted.branch,
          ...(completion.widget ? { outcome: completion.widget.outcome } : {}),
          ...(completion.widget?.summary ? { summary: completion.widget.summary } : {}),
        });

        return {
          kind: "completed" as const,
          changed,
          worktree: adopted,
          outcome: completion.widget?.outcome ?? null,
          summary: completion.widget?.summary ?? null,
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
        // because that is the first moment SoloW knows which directory the agent used.
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

      if (run.kind === "failed") {
        if (run.cls === "park") {
          await step.run(`park-${round}`, async () => {
            /*
             * The reason is cleared as the Task parks, and that clearing is load-bearing rather
             * than tidiness.
             *
             * `setTaskState` writes `failureReason` only when it is passed one, so a Task that
             * carried a reason from an earlier round kept it across the park. That made
             * `parked` + a reason ambiguous, and both readers resolved the ambiguity the unsafe
             * way: `heldByRun` reads any reason that is not `STRANDED_PARK_REASON` as a run still
             * sitting in here, so it held for ever, and `reportStrandedParks` selects
             * `isNull(failure_reason)`, so the sweep that would have stamped it never saw the row.
             * Between them the container was unreachable by every path that removes one.
             *
             * Clearing it here rather than relaxing `heldByRun` is the half that is provably safe.
             * A sleeper writes nothing for `PARK_SLEEP_MS`, so a reader that treated any reason as
             * "no run in here" would watch the quiet cushion expire under a perfectly live run and
             * tear its container down — the failure this reaper has already been corrected for
             * once. Writing the row is something only the run does, and at this instant the run is
             * the thing that knows there is no failure outstanding.
             *
             * What remains uncovered is a reason that arrives on an already-`parked` row, which
             * today only an operator can cause. That is their write, not the sleeper's, and
             * guessing at it here would be the same overreach in the other direction.
             */
            await setTaskState(db, workspaceId, taskId, "parked", { failureReason: null });
            await recordTransition("running", "parked");
          });
          logStateTransition(log, { workspaceId, taskId, from: "running", to: "parked" });
          announce("parked");
          // Resume when the quota window resets. A budget/quota check would refine this.
          await step.sleepUntil(`park-wait-${round}`, new Date(Date.now() + PARK_SLEEP_MS));
          /*
           * Awake — and the row has to say so before this round touches an executor.
           *
           * Nothing else in the orchestrator clears `failureReason` for a `parked` Task. The state
           * stays `parked` for the whole of the round this wakes into (only an operator opening the
           * gate moves it), and the resume path at `resume-` below is reached only by a Task that
           * got as far as `review`. So a `park_never_resumed` written by `reportStrandedParks`
           * while this run was asleep — an engine backed up past the sweep's window is enough —
           * stayed readable to the container reaper across every gap between durable steps of the
           * round it woke into, and the reaper reads that pairing as "no run is in here". Verified
           * on Docker 29.7.2 what removal costs when it is wrong: `docker rm -f` on a container
           * with a running exec kills it with 137, and `ensureContainer` turns that into an
           * `ExecutorUnavailableError` that fails the round.
           *
           * A durable step of its own, so the write survives a restart between the sleep and the
           * work, and so a replay does not repeat it. It also refreshes `updatedAt`, which is what
           * stops the same sweep reaching the same conclusion again while this round runs.
           *
           * Conditional on the row still reading `parked`, which is the other half of the fix and
           * not a refinement of it. `setTaskState` has no precondition, so writing `parked` here
           * reverted whatever an operator did during the five hours this run was asleep — a Task
           * they finished went back to `parked`, and the `announce` below published the reverted
           * state to the board — after which the row was out of `reclaimOrphanedRuns`' reach (it
           * selects only `running`) and inside `reportStrandedParks`' window. A Task that moved
           * while this run slept is the operator's call, not the sleeper's, so `clearStrandedPark`
           * takes back only the verdict written about the sleep and leaves the state alone.
           *
           * What it does not do is stop this run: the loop carries on into another round against a
           * Task the operator may have called finished. That is the pre-existing shape of a woken
           * park — the run owns the worktree and nothing else can commit it — and narrowing it
           * means deciding what a run should do when its Task is taken out from under it, which is
           * a lifecycle question and not this step's.
           */
          const stillParked = await step.run(`park-woke-${round}`, () =>
            clearStrandedPark(db, workspaceId, taskId),
          );
          // The card may be showing a stranded badge that is no longer true; this is what takes it
          // off without a reload. Skipped when the row moved, where `parked` is not the state to
          // publish and whoever moved it has already announced what they did.
          if (stillParked) announce("parked");
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

      /*
       * The agent has finished. It does not follow that the Task is in review.
       *
       * This step used to move it there itself, which made the review gate something that happened
       * *to* an operator rather than something they opened — and made "the agent stopped" and "the
       * work is ready" the same event, which they are not: an agent stops when it runs out of
       * things to do, when it runs out of context, and when it decides the brief was already
       * satisfied. Only one of those is worth a person's attention, and only the agent knows which.
       *
       * So the run records the declaration and the change, and stops. The Task stays where it is,
       * the board shows it as finished, and the transition into `review` is the operator's click —
       * one action, theirs (Principle I is a gate for a human to open, not a conveyor).
       */
      const worktree = run.worktree;
      const gate = worktreeBindings(worktree);
      await step.run(`to-review-${round}`, async () => {
        await recordTaskCompletion(db, workspaceId, taskId, {
          // `changes_ready` when the agent said nothing: it stopped having produced a run, and the
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

      const decidedEvent = await step.waitForEvent(`await-review-${round}`, {
        event: "review.decided",
        timeout: REVIEW_WAIT_TIMEOUT,
        match: "data.sessionId",
      });
      if (!decidedEvent) return { taskId, result: "review_timeout" };

      const { decision, feedback } = reviewData.parse(decidedEvent.data);

      if (decision === "approve") {
        const outcome = await step.run(`approve-${round}`, async () => {
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
          //
          // Each group is integrated **inside its own try** (issue #70 AC-4). One decision covers
          // the whole Task, so a failure part-way through leaves it partially integrated — the
          // second repository committed, the third not — and letting the step simply throw would
          // report that as "the approve failed", which is the one reading that is false. Inngest
          // would then retry it, committing a second time to the branches that already took.
          const integrated: string[] = [];
          const failed: { branch: string; error: string }[] = [];
          for (const entry of gate) {
            try {
              if (await worktreeOps.hasChanges(entry.worktree.path, patternsFor(entry))) {
                await worktreeOps.commit(
                  entry.worktree.path,
                  `SoloW: task ${taskId}`,
                  patternsFor(entry),
                );
              }
              /*
               * Then put the branch where a reviewer can reach it (issue #96 round 2).
               *
               * A Task with its own clone has committed into that clone, which is torn down with
               * its worktree — so without this the row written below would name a branch that
               * exists nowhere, and F08's promise of one branch per Repository per Task would be
               * a promise about a directory the next cleanup deletes. Inside the same `try` as
               * the commit, and before the row: a repository this failed for is one where the
               * result is *not* integrated, and the notice below has to be able to say so.
               *
               * A no-op for a local run — the branch is already in the Repository, because that
               * is where the worktree was added.
               */
              await repoAdmin.publish(
                entry.worktree.repoPath,
                upstreamPathFor(entry.binding),
                entry.worktree.branch,
              );
              await setTaskRepositoryResultBranch(
                db,
                workspaceId,
                entry.binding.attachment.id,
                entry.worktree.branch,
              );
              integrated.push(entry.worktree.branch);
            } catch (cause) {
              failed.push({
                branch: entry.worktree.branch,
                error: cause instanceof Error ? cause.message : String(cause),
              });
            }
          }

          if (failed.length > 0) {
            /*
             * Fail loudly, with the partial state named.
             *
             * The names go in the session log rather than in `failureReason`, which stays a class
             * the way `credential_expired` and `interrupted` are — the board matches on it, and a
             * reason carrying branch names would match nothing. The log is where the reviewer who
             * has to decide what to do about a half-landed change is already looking.
             */
            await appendSessionEvent(db, workspaceId, {
              sessionId,
              seq: await nextSessionEventSeq(db, workspaceId, sessionId),
              payload: {
                kind: "notice",
                text: [
                  "Approval integrated only part of this task.",
                  integrated.length > 0
                    ? `Committed and recorded: ${integrated.join(", ")}.`
                    : "Nothing was committed.",
                  `Not integrated: ${failed.map((f) => `${f.branch} (${f.error})`).join("; ")}.`,
                  "The branches listed as committed are real and already hold the change — decide what to do with them by hand.",
                ].join(" "),
              },
            });
            await setTaskState(db, workspaceId, taskId, "failed", {
              failureReason: PARTIAL_INTEGRATION_REASON,
            });
            await recordTransition("review", "failed", PARTIAL_INTEGRATION_REASON);
            await setSessionState(db, workspaceId, sessionId, "closed", {
              endedAt: new Date().toISOString(),
            });
            return { integrated, failed };
          }

          await setTaskState(db, workspaceId, taskId, "done");
          await recordTransition("review", "done");
          await setSessionState(db, workspaceId, sessionId, "closed", {
            endedAt: new Date().toISOString(),
          });
          return { integrated, failed };
        });

        if (outcome.failed.length > 0) {
          logStateTransition(log, { workspaceId, taskId, from: "review", to: "failed" });
          // Branch names, not diff content — safe to log, and the only way an operator learns which
          // half of a partially-integrated Task landed without opening the session.
          captureException(log, new Error(`partial integration: ${outcome.failed.length} failed`), {
            failureReason: PARTIAL_INTEGRATION_REASON,
            integrated: outcome.integrated,
            notIntegrated: outcome.failed.map((f) => f.branch),
          });
          announce("failed");
          return { taskId, result: PARTIAL_INTEGRATION_REASON };
        }
        logStateTransition(log, { workspaceId, taskId, from: "review", to: "done" });
        announce("done");
        break;
      }
      if (decision === "reject") {
        await step.run(`reject-${round}`, async () => {
          for (const entry of gate) await worktreeOps.discard(entry.worktree.path);
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
      // `""` rather than `undefined` when the reviewer wrote nothing: the next round's brief still
      // has to say the last one was rejected, and only the presence of the field distinguishes a
      // redo from a first attempt.
      pendingFeedback = feedback ?? "";
      await step.run(`resume-${round}`, async () => {
        await setTaskState(db, workspaceId, taskId, "running");
        // The previous round's declaration does not describe the round about to start. Left in
        // place, the board would keep offering to review work that is being rewritten as you look.
        await clearTaskCompletion(db, workspaceId, taskId);
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
          // SoloW provisioned, a run that ended before the agent reported anything still has
          // that directory to remove.
          const worktree = provisionedByAttachment.get(binding.attachment.id);
          return worktree ? [{ binding, worktree }] : [];
        });
    if (remaining.length > 0) {
      await step.run("cleanup", async () => {
        for (const entry of remaining) {
          await repoAdmin.cleanup(entry.worktree.repoPath, entry.worktree.path, ownClone);
        }
        // After the directories are gone, not before: a row marked removed while the removal is
        // still in flight would be a table that disagrees with the disk in the one direction that
        // matters — telling the delete path there is nothing left to tear down.
        await markWorktreesRemoved(
          db,
          workspaceId,
          taskId,
          remaining.map((entry) => entry.worktree.path),
        );
      });
    }
    return { taskId, result: "done" };
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
function repositoryHostPath(
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
 * worktree in the deployment, across Workspaces — Task A's agent could read the `.env` seeded
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
 * `guardMountSource` refuses a source that would hand the agent the machine, and refusing it in
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
      // The branch the agent will actually find itself on. A worktree SoloW provisioned is
      // on the attachment's branch by construction, and one that does not exist yet will be —
      // but a worktree the agent made for itself is on a branch it named (`solow-task-<id>`,
      // not `solow/task-<id>`), which is only knowable once git has been asked. Until then
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
 * What the agent is told when someone answers its widget.
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
  // ids are how it referred to the same options. The question is quoted back because an agent can
  // have more than one widget outstanding, and it is the only reference *the agent itself*
  // recognises — this build's own widget id was generated after the emission and the agent has
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
  // Widgets are taught, not assumed: an agent emits one only because the brief told it how, so
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
  // A rejection is announced whether or not the reviewer wrote anything. `undefined` is round
  // one and says nothing; an empty string is "rejected, no words", which the review gate now
  // produces on every Request changes. Without this the redo brief was byte-identical to the
  // first — and since each round is a fresh process with no memory of the last, the agent was
  // handed the original instructions in a worktree already holding its own rejected work, with
  // nothing anywhere telling it the work had been turned down.
  if (feedback !== undefined) {
    const detail = feedback.trim();
    parts.push(
      detail
        ? `# Review feedback\nYour previous attempt was not accepted. Address this feedback:\n${detail}`
        : "# Review feedback\nYour previous attempt was not accepted. The reviewer left no notes. The worktree still holds that attempt — reconsider it rather than repeating it.",
    );
  }
  if (ctx.widgetsEnabled) parts.push(`# Widgets\n${WIDGET_BRIEF_INSTRUCTIONS}`);
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
