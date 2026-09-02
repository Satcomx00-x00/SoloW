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
   * says so instead of offering an action that would fail — an Agent Profile needs a Secret to
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
