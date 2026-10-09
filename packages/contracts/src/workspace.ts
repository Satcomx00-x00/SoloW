import { z } from "zod";
import { authModeSchema, idSchema } from "./common.js";
import { executorKindSchema } from "./executor-config.js";
import { harnessPermissionModeSchema } from "./profile.js";
import { setSecretInput } from "./secret.js";

/**
 * The Workspace, as something an Owner can see and act on (2026-08-28).
 *
 * It has always been the tenant key every table is scoped by (Principle V) and every procedure
 * re-checks — and it appeared in the product as four words of grey text in a breadcrumb. There
 * was no way to read its name, change it, or find out what it still needed. This is that
 * surface.
 */

export const workspaceDto = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type WorkspaceDto = z.infer<typeof workspaceDto>;

export const renameWorkspaceInput = z.object({
  /** No `id`: the Workspace is the caller's own, from the session (Principle V). */
  name: z.string().trim().min(1).max(80),
});
export type RenameWorkspaceInput = z.infer<typeof renameWorkspaceInput>;

/**
 * The guided setup's steps, in the order a newcomer meets them (roadmap E1): connect Claude,
 * choose a repository, try it.
 *
 * Three, where there used to be seven Settings errands — a credential, a Harness Profile, an
 * Executor and the rest — because the person setting up thinks of one thing, "my Claude
 * account", and every object underneath it is something SoloW can make for them. Those objects
 * still exist and stay editable in Settings; they are just not the vocabulary of getting started.
 */
export const setupStepKeySchema = z.enum(["claude", "repository", "test"]);
export type SetupStepKey = z.infer<typeof setupStepKeySchema>;

/**
 * One step, and whether it is done.
 *
 * `done` is derived from the rows that exist, never from a "dismissed" flag: a checklist that
 * remembered being completed would keep saying so after the credential it was counting got
 * deleted, which is exactly when someone needs to be told otherwise. The test run is the one step
 * with something remembered behind it — see `setupVerifiedSchema` for why that memory still
 * cannot outlive what it tested.
 */
export const setupStepDto = z.object({
  key: setupStepKeySchema,
  done: z.boolean(),
  /** What exists, when something does — "Claude Code · subscription", "solow, crawler". */
  detail: z.string(),
  /**
   * The earlier step this one waits on, or null when it can start. The test run needs something
   * to test, and a button that could only fail is a worse answer than naming what is missing.
   */
  blockedBy: setupStepKeySchema.nullable(),
});
export type SetupStepDto = z.infer<typeof setupStepDto>;

/**
 * The agent a new Task would run with, as the setup describes it: which harness, how it is paid
 * for, and how much it may do unasked. Chosen by the rule `quickTaskProfiles` applies, so the
 * setup and a Quick task can never disagree about which one that is.
 */
export const setupAgentDto = z.object({
  harness: z.string(),
  billing: authModeSchema,
  permissionMode: harnessPermissionModeSchema,
});
export type SetupAgentDto = z.infer<typeof setupAgentDto>;

export const workspaceSetupDto = z.object({
  workspace: workspaceDto,
  /**
   * Whether the core loop's kill switch is on. Not a step: it ships on and only matters once
   * somebody turns it off — and then it matters more than any step, because none of them can be
   * done until it is back.
   */
  coreLoop: z.boolean(),
  steps: z.array(setupStepDto),
  /** Null until a Harness Profile exists. */
  agent: setupAgentDto.nullable(),
  /**
   * Where a new Task runs: the kind of executor it would get, or null when there is none yet — in
   * which case connecting creates one on this machine, and the setup says so before it does.
   */
  executorKind: executorKindSchema.nullable(),
  /**
   * Whether that executor is the local one the setup made when there was nothing else, in a
   * Workspace with no container executor — the one case where connecting again moves Claude into
   * the isolated container once its image exists (`setupExecutorPlan`).
   */
  executorReplaceable: z.boolean(),
  /** True once every step is done and the core loop is on — what stops the setup showing. */
  ready: z.boolean(),
});
export type WorkspaceSetupDto = z.infer<typeof workspaceSetupDto>;

/**
 * "Connect Claude": the one question the setup cannot answer for itself.
 *
 * The credential goes through `setSecretInput`'s own rule, trimmed first because a token pasted
 * from a terminal arrives with its newline. Write-only, like every Secret value (Principle IV).
 */
export const connectClaudeInput = z.object({
  billing: authModeSchema,
  credential: z.string().trim().pipe(setSecretInput.shape.value),
});
export type ConnectClaudeInput = z.infer<typeof connectClaudeInput>;

/** What connecting left in place — ids and kinds only; the credential never comes back. */
export const connectClaudeResultDto = z.object({
  harnessProfileId: idSchema,
  executorProfileId: idSchema,
  executorKind: executorKindSchema,
  /**
   * False when an executor already existed and was kept. True when there was none, and when the
   * setup's own local executor was succeeded by the isolated one — which then becomes the default
   * while the local one stays, unchanged, in Settings.
   */
  createdExecutor: z.boolean(),
  /** Tasks paused on this credential and restarted by replacing it, as `secret.set` does. */
  resumedTaskCount: z.number().int().nonnegative(),
});
export type ConnectClaudeResultDto = z.infer<typeof connectClaudeResultDto>;

/**
 * Why a test run failed, as a cause the screen can turn into a sentence and a step to go back to
 * (F18, edge cases) — never the harness's own error text.
 *
 * - `not-connected` — nothing to test yet.
 * - `unreachable` — the orchestrator did not answer the request at all.
 * - `not-installed` — the harness binary is not on the orchestrator's host.
 * - `credential` — the provider refused the token or key.
 * - `quota` — the plan's usage window is spent; the setup is fine and the test can wait.
 * - `harness` — it started and then failed some other way.
 */
export const setupTestProblemSchema = z.enum([
  "not-connected",
  "unreachable",
  "not-installed",
  "credential",
  "quota",
  "harness",
]);
export type SetupTestProblem = z.infer<typeof setupTestProblemSchema>;

export const setupTestResultDto = z.object({
  ok: z.boolean(),
  problem: setupTestProblemSchema.nullable(),
  /** The step to go back to, or null when no step can fix it (a spent quota, a stopped server). */
  fixStep: setupStepKeySchema.nullable(),
  /** The harness that was tested, by its display name. Null when there was none. */
  harness: z.string().nullable(),
  /**
   * Whether it answered a prompt — the proof that the credential works. False only for a harness
   * this build cannot prompt outside a run, where starting it and its handshake are all there is.
   */
  answered: z.boolean(),
});
export type SetupTestResultDto = z.infer<typeof setupTestResultDto>;

/**
 * A passed test run, remembered (`ui_preference`, under `SETUP_VERIFIED_PREFERENCE_KEY`).
 *
 * The one part of the setup that is not a count of rows, because a test run leaves none behind.
 * It names what it tested — the Profile, and when that Profile's credential was last written — so
 * it stops counting the moment either changes: a replaced token is an untested token.
 */
export const setupVerifiedSchema = z.object({
  harnessProfileId: idSchema,
  secretUpdatedAt: z.string(),
});
export type SetupVerified = z.infer<typeof setupVerifiedSchema>;

export const SETUP_VERIFIED_PREFERENCE_KEY = "setup-verified";

/**
 * How current the mirror is, as one line a status bar can hold.
 *
 * Derived from the repository rows rather than stored, for the same reason `setupStepDto.done`
 * is: a remembered "last synced" would keep claiming freshness after the repository it was
 * describing had its connection removed. This is a view of what the rows actually say.
 *
 * The pessimistic aggregate is deliberate on both fields. `syncedAt` is the *oldest* watermark
 * across the linked repositories, not the newest, because a bar that reads "synced 10s ago" while
 * one repository has been failing for a day is a bar that lies in the one situation it exists
 * for. `stale` counts repositories that backed off — a rate limit, an unreachable host — so the
 * bar can say the mirror is behind instead of presenting hours-old rows as current (F23 NFR-3).
 */
export const syncStatusDto = z.object({
  /** Linked repositories — the ones a poll has anything to do for. Zero means nothing to sync. */
  repositories: z.number().int().nonnegative(),
  /** The oldest watermark across them, or null when any of them has never been read. */
  syncedAt: z.string().nullable(),
  /** How many are currently behind, and why the first of them is. */
  stale: z.number().int().nonnegative(),
  staleReason: z.string().nullable(),
});
export type SyncStatusDto = z.infer<typeof syncStatusDto>;

/**
 * The answer to "sync everything now".
 *
 * `accepted` is about the *handoff*, never about the provider: the request goes to the durable
 * engine and returns as soon as that engine has it, because a button that blocked until ten
 * repositories had been read would be a button nobody presses twice. What tells the screen the
 * pass actually landed is the mirror announcement on the WebSocket, the same way it learns about
 * a pass nobody asked for.
 *
 * False means there was no engine to hand it to — a local run without an orchestrator. Saying so
 * is the point: a spinner that resolved into silence would be indistinguishable from a sync that
 * worked.
 */
export const syncRequestDto = z.object({
  accepted: z.boolean(),
  repositories: z.number().int().nonnegative(),
});
export type SyncRequestDto = z.infer<typeof syncRequestDto>;

/**
 * The name of the event that asks the poll to run now.
 *
 * Here rather than in either app, because both of them say it: the web app emits it and the
 * orchestrator's `repository-sync` triggers on it. Two string literals that must agree is a
 * coupling nothing checks — they stay in step until one is renamed, and then the button goes
 * quiet with no error anywhere, which is the worst way for a feature to stop working.
 *
 * The older orchestrator event (`task.launch.requested`, which also carries review decisions) is
 * still spelled out on both sides. It predates this and is not touched here, but this is the
 * shape it should take.
 */
export const REPOSITORY_SYNC_REQUESTED = "repository.sync.requested";

/**
 * The web app deleted a Task's rows outright — an Issue went with its Tasks — and the files
 * those rows pointed at are the orchestrator's to remove (Decision 0025): the worktree
 * directories, by path, plus the Task's transcript and checkpoint stores. Best effort, after
 * the fact: the rows are already gone, which is why the paths travel in the event.
 */
export const TASK_PURGE_REQUESTED = "task.purge.requested";
export const taskPurgeRequestedData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
  worktrees: z.array(z.string().min(1)).max(64),
});
export type TaskPurgeRequestedData = z.infer<typeof taskPurgeRequestedData>;

/**
 * Ship an approved Task's branches again (A1): push each committed result branch and open or find
 * its pull request, and nothing else — no harness, no new commit. Sent by `task.redeliver` for a
 * Task whose approval committed but could not ship; the orchestrator re-checks that it still is
 * one before touching the remote.
 */
export const TASK_REDELIVER_REQUESTED = "task.redeliver.requested";
export const taskRedeliverRequestedData = z.object({
  workspaceId: z.string().min(1),
  taskId: z.string().min(1),
});
export type TaskRedeliverRequestedData = z.infer<typeof taskRedeliverRequestedData>;

/**
 * How much of a Workspace "clean up the database" removes.
 *
 * Two scopes rather than one, because the two things people mean by it are genuinely different
 * and only one of them is recoverable in practice:
 *
 * - `work-data` empties what the Workspace has *done* — Projects, Issues, Tasks, Sessions and
 *   everything hanging off them — and keeps what it *is*: Repositories, Harness and Executor
 *   Profiles, Secrets, Integrations, libraries, flags and preferences. After it you can start
 *   work again immediately, which is what someone clearing out a pile of experiments wants.
 * - `everything` additionally removes the setup. What survives is the account and the Workspace
 *   row itself, reseeded with the harness catalog a fresh install gets — a factory reset.
 *
 * Neither touches the account or the Workspace row: a surface that could delete the tenant it
 * is addressed through would have nowhere to answer from (Principle V).
 */
export const workspaceResetScopeSchema = z.enum(["work-data", "everything"]);
export type WorkspaceResetScope = z.infer<typeof workspaceResetScopeSchema>;

/**
 * Typing the Workspace's own name back is the gate, rather than a second "are you sure".
 *
 * A confirm dialog is the right weight for deleting one row you are looking at; it is the wrong
 * weight for something with no undo and no record of what it removed. Re-typing a name cannot
 * be done by a mis-aimed click or a keyboard repeat, and it fails closed — the server compares
 * it against the name it holds, so a stale tab whose Workspace was renamed underneath it is
 * refused rather than honoured.
 *
 * No `id`: the Workspace is the caller's own, from the session (Principle V).
 */
export const resetWorkspaceInput = z.object({
  scope: workspaceResetScopeSchema,
  confirmName: z.string().min(1).max(80),
});
export type ResetWorkspaceInput = z.infer<typeof resetWorkspaceInput>;

/**
 * What one table lost. An array of named counts rather than a map, so the shape survives the
 * OpenAPI export intact and a table added later cannot silently widen a record type.
 */
export const workspaceResetCountDto = z.object({
  table: z.string(),
  rows: z.number().int().nonnegative(),
});
export type WorkspaceResetCountDto = z.infer<typeof workspaceResetCountDto>;

/**
 * The receipt.
 *
 * It exists because the action has no undo: the only thing that can tell an Owner what actually
 * happened is a truthful account of it, immediately, and "Removed 412 rows across 14 tables"
 * is that. `worktrees` carries the directories the orchestrator is asked to remove afterwards —
 * the rows are already gone by then, which is why the paths travel out of the transaction
 * (Decision 0025, the same handoff `TASK_PURGE_REQUESTED` uses).
 */
export const workspaceResetDto = z.object({
  scope: workspaceResetScopeSchema,
  removed: z.array(workspaceResetCountDto),
  /** Total across every table — what the confirmation line says. */
  rows: z.number().int().nonnegative(),
  worktrees: z.array(z.string()),
});
export type WorkspaceResetDto = z.infer<typeof workspaceResetDto>;

/**
 * Counts the app's navigation shows beside its destinations, computed in SQL.
 *
 * Its own read rather than the length of a list: the sidebar used to download every unassigned
 * Issue on every page to show one number beside "Unassigned".
 */
export const workspaceCountsDto = z.object({
  /** Issues held by no Project — what the Unassigned page lists. */
  unassignedIssues: z.number().int().nonnegative(),
  /**
   * Tasks waiting on a person's review, per Project that holds their Issue. Only Projects with
   * at least one appear. Review is the one Task state that is waiting on a human (Principle I),
   * so it is the one the navigation points at.
   */
  reviewByProject: z.array(z.object({ projectId: z.string(), tasks: z.number().int().positive() })),
});
export type WorkspaceCountsDto = z.infer<typeof workspaceCountsDto>;
