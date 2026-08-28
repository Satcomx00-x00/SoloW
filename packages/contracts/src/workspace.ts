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
