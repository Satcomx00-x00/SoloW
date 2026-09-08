import { z } from "zod";
import { authModeSchema, idSchema, timestampsSchema } from "./common.js";
import {
  DEFAULT_EXECUTOR_CONFIG,
  executorConfigSchema,
  executorKindSchema,
} from "./executor-config.js";
import { pageInputSchema, pageOf } from "./page.js";

/**
 * How much a harness may do without stopping to ask (spec F05).
 *
 * These are the vendor CLI's own `--permission-mode` values, deliberately not renamed: the
 * profile is configuring the harness, and inventing a second vocabulary for it would mean
 * translating in both directions and being wrong the day the CLI adds a fourth.
 *
 * - `acceptEdits` — the default, and what every Profile ran as before this field existed. The
 *   harness edits inside its own worktree freely and asks for everything else.
 * - `plan` — it may read and reason but not change anything. A Profile for "tell me what you
 *   would do" rather than "do it".
 * - `bypassPermissions` — it never asks.
 *
 * The last one deserves its name. SoloW runs a harness headless, in a worktree, with **no
 * channel to ask an operator on** for the stream-json protocol — so under `acceptEdits` every
 * shell command and every fetch is refused by a prompt nobody can answer, and a task that needs
 * either simply cannot be done (observed: a harness asking for `pip index versions` in a loop
 * until it gave up). `bypassPermissions` is the answer to that, and it is a real grant: the
 * harness gets the shell and the network, bounded by the worktree it runs in and by the review
 * gate that still holds every change before it reaches a branch (Principle I).
 */
export const harnessPermissionModeSchema = z.enum(["acceptEdits", "plan", "bypassPermissions"]);
export type HarnessPermissionMode = z.infer<typeof harnessPermissionModeSchema>;

/**
 * What a Profile runs as when it says nothing.
 *
 * `bypassPermissions`, by decision (2026-08-22): SoloW runs harnesses headless, and under any
 * asking mode a prompt reaches nobody — so the cautious-looking default did not produce caution,
 * it produced runs that failed partway through with the work half done. The bound on a harness is
 * the worktree it is confined to and the review gate every change still stops at (Principle I),
 * not a question with no answerer.
 *
 * A Profile can still choose otherwise, and `plan` in particular is a real posture for a harness
 * meant to propose rather than act.
 */
export const DEFAULT_HARNESS_PERMISSION_MODE: HarnessPermissionMode = "bypassPermissions";

/**
 * Harness Profile (spec F05/F06, issue #10). `agentCatalogId` replaces the old closed
 * `agentKind` enum — which harness this Profile runs, and how, is data in `agent_catalog`, not a
 * literal the contract has to know about.
 */

/**
 * What a Profile chooses about *how* its harness is launched (spec F05, issue #94).
 *
 * Both are **null by default, and null means "whatever the harness chooses"** — not a value picked
 * here. A harness advertises its own models and modes at handshake, and those lists change on the
 * provider's schedule, not this codebase's: a default written down here would be a choice that
 * rots into a launch failure the first time a model is retired. Null is the only value that
 * cannot go stale.
 *
 * `model` is the model id as the harness names it. `modeId` is one of the modes it advertises —
 * ACP's `session/set_mode` takes exactly this, and the client already refuses to send an id the
 * harness never offered rather than guessing.
 */
export const harnessModelIdSchema = z.string().min(1).max(120);
export const harnessModeIdSchema = z.string().min(1).max(120);

export const createHarnessProfileInput = z.object({
  name: z.string().min(1).max(120),
  agentCatalogId: idSchema,
  authMode: authModeSchema,
  /** References a stored Secret (subscription token or API key). */
  secretId: idSchema,
  concurrencyCap: z.number().int().min(1).max(20).default(3),
  permissionMode: harnessPermissionModeSchema.default(DEFAULT_HARNESS_PERMISSION_MODE),
  /** Null — the default — leaves the choice to the harness. See `harnessModelIdSchema`. */
  model: harnessModelIdSchema.nullable().default(null),
  modeId: harnessModeIdSchema.nullable().default(null),
});
export type CreateHarnessProfileInput = z.infer<typeof createHarnessProfileInput>;

/**
 * What still holds this Harness Profile, so Settings can disable Delete and say why before the
 * Owner tries it rather than only after the server refuses (same reasoning as `secretRefDto`'s
 * `usedBy`). Counts rather than named rows: unlike a Secret — typically held by one or two named
 * Integrations or Profiles — a Profile can be referenced by hundreds of Tasks, and "used by 42
 * tasks" is the useful summary, not a list of their titles.
 */
export const harnessProfileUsageDto = z.object({
  taskCount: z.number().int().nonnegative(),
  workflowStepCount: z.number().int().nonnegative(),
  /** Historical billing attribution (issue #14) — present even for a Profile whose every Task
   * has since been deleted, which is exactly the case a Task/Step count alone would miss. */
  sessionUsageCount: z.number().int().nonnegative(),
  /**
   * What this Profile is doing *now*, as opposed to what has ever referenced it.
   *
   * The three counts above are history and attachment; these two are the present tense, and they
   * are the reason Settings can say "2 of 3 running" beside a concurrency cap instead of printing
   * the cap as a number in a form. A cap is only meaningful against the slots it is currently
   * spending, and "Parked" is the state that cap *causes* — a Profile at its ceiling with work
   * waiting behind it is the single most useful fact this page can carry, and until now it was
   * only visible on the board.
   *
   * Free to compute: the Task pass that produces `taskCount` already reads every Task in the
   * Workspace, so these are a second and third tally over rows that were being fetched anyway.
   */
  runningCount: z.number().int().nonnegative(),
  parkedCount: z.number().int().nonnegative(),
});
export type HarnessProfileUsageDto = z.infer<typeof harnessProfileUsageDto>;

export const harnessProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    agentCatalogId: idSchema,
    authMode: authModeSchema,
    secretId: idSchema,
    concurrencyCap: z.number().int(),
    permissionMode: harnessPermissionModeSchema,
    model: harnessModelIdSchema.nullable(),
    modeId: harnessModeIdSchema.nullable(),
    usage: harnessProfileUsageDto,
  })
  .merge(timestampsSchema);
export type HarnessProfileDto = z.infer<typeof harnessProfileDto>;

/**
 * Edit a Profile. No `agentCatalogId`, `authMode` or `secretId`: which harness a Profile runs and
 * how it authenticates are what a Profile *is*, and changing them under Tasks that already
 * reference it would rewrite the meaning of finished runs. What can change is what it is called,
 * how many of it may run at once, and how much it is allowed to do.
 */
export const updateHarnessProfileInput = z.object({
  id: idSchema,
  name: z.string().min(1).max(120).optional(),
  concurrencyCap: z.number().int().min(1).max(20).optional(),
  permissionMode: harnessPermissionModeSchema.optional(),
  /*
   * `.nullable().optional()` on both, and the two mean different things: absent leaves the
   * setting alone, null hands the choice back to the harness. Collapsing them would make "stop
   * pinning a model" unexpressible.
   */
  model: harnessModelIdSchema.nullable().optional(),
  modeId: harnessModeIdSchema.nullable().optional(),
});
export type UpdateHarnessProfileInput = z.infer<typeof updateHarnessProfileInput>;

export const deleteHarnessProfileInput = z.object({ id: idSchema });
export type DeleteHarnessProfileInput = z.infer<typeof deleteHarnessProfileInput>;

export const deleteExecutorProfileInput = z.object({ id: idSchema });
export type DeleteExecutorProfileInput = z.infer<typeof deleteExecutorProfileInput>;

/**
 * Executor Profile (spec F07, issue #73).
 *
 * The kind is *inside* the configuration, not beside it: a separate `kind` field could disagree
 * with `config.kind`, and there is no sensible answer to which one a driver should believe. The
 * `executor_profile.kind` column is a denormalised copy the DAL derives on write, kept only so
 * the kind is queryable.
 */
export const createExecutorProfileInput = z.object({
  name: z.string().min(1).max(120),
  config: executorConfigSchema.default(DEFAULT_EXECUTOR_CONFIG),
});
export type CreateExecutorProfileInput = z.infer<typeof createExecutorProfileInput>;

export const updateExecutorProfileInput = z.object({
  id: idSchema,
  name: z.string().min(1).max(120).optional(),
  config: executorConfigSchema.optional(),
});
export type UpdateExecutorProfileInput = z.infer<typeof updateExecutorProfileInput>;

/**
 * The configuration is safe to return: every member holds secret *references*, never secret
 * values (AC-3), so there is nothing here to redact.
 */
export const executorProfileDto = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: executorKindSchema,
    config: executorConfigSchema,
  })
  .merge(timestampsSchema);
export type ExecutorProfileDto = z.infer<typeof executorProfileDto>;

/**
 * The two profile catalogues, paged — see `listRepositoriesInput` for why a small list is paged
 * too. `harnessCatalog` is deliberately not among them: it is the fixed set of harnesses this build
 * knows how to run, not a collection that grows with use.
 */
export const listProfilesInput = pageInputSchema;
export type ListProfilesInput = z.infer<typeof listProfilesInput>;

export const harnessProfileListDto = pageOf(harnessProfileDto);
export type HarnessProfileListDto = z.infer<typeof harnessProfileListDto>;

export const executorProfileListDto = pageOf(executorProfileDto);
export type ExecutorProfileListDto = z.infer<typeof executorProfileListDto>;
