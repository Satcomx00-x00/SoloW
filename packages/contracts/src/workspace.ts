import { z } from "zod";

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
 * One thing a Workspace needs before it can run anything.
 *
 * `done` is derived from the rows that exist, never from a "dismissed" flag: a checklist that
 * remembered being completed would keep saying so after the Secret it was counting got deleted,
 * which is exactly when someone needs to be told otherwise. The cost is that it is a live view
 * of the Workspace rather than a one-time ceremony — which is the more useful thing anyway.
 */
export const setupStepDto = z.object({
  key: z.enum([
    "workspace",
    "agents",
    "secret",
    "agent-profile",
    "executor",
    "repository",
    "core-loop",
  ]),
  done: z.boolean(),
  /** What exists, when something does — "2 secrets", "Claude Code, opencode". Empty when not. */
  detail: z.string(),
  /**
   * Why this step cannot be started yet, or null when it can. A step gated on an earlier one
   * says so instead of offering an action that would fail — a Harness Profile needs a Secret to
   * point at, and a button that opens a form with an empty picker is a worse answer than a
   * sentence naming what is missing.
   */
  blockedBy: z.string().nullable(),
});
export type SetupStepDto = z.infer<typeof setupStepDto>;

export const workspaceSetupDto = z.object({
  workspace: workspaceDto,
  steps: z.array(setupStepDto),
  /** True once every step is done — what the shell reads to stop showing the checklist. */
  ready: z.boolean(),
});
export type WorkspaceSetupDto = z.infer<typeof workspaceSetupDto>;

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
 * The two older orchestrator events (`task.launch.requested`, `review.decided`) are still spelled
 * out on both sides. They predate this and are not touched here, but this is the shape they
 * should take.
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
