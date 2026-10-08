import { z } from "zod";
import { authModeSchema, idSchema, taskStateSchema } from "./common.js";

/**
 * Outcomes (finding A4, spec F14): whether the product works, read off what it already records.
 *
 * Every figure here is derived at read time from rows other features write — `task`, `session`,
 * `review`, `task_repository` and `session_usage` — so nothing new is tracked and nothing here can
 * disagree with the board. The definitions live beside the schema because the page prints them
 * next to each number, and a figure whose meaning is only in a code comment is a guess to the
 * person reading it.
 *
 * Shared rules:
 *  - **Deleted Tasks are left out of every figure.** A deleted Task is purged after the retention
 *    window, so counting it would make last month's numbers change on their own a week later.
 *  - **Weeks start on Monday, in UTC**, and the window is the last `weeks` of them including the
 *    current, partial one.
 */

/** The windows the page offers. Any count of weeks in range is accepted over the API. */
export const OUTCOMES_WINDOW_WEEKS = [4, 12, 26] as const;

export const outcomesInput = z.object({
  weeks: z.number().int().min(1).max(104).default(12),
});
export type OutcomesInput = z.infer<typeof outcomesInput>;

/**
 * Token counts and what they cost, for one slice of the window's turns.
 *
 * Tokens are counted only from turns the harness reported usage for; `unreportedTurns` is the gap.
 * Cost is **metered** cost: API-key turns priced from the price table in `@solow/core`. A
 * subscription turn has no per-token charge and is never priced, and an API-key turn whose model
 * the table does not know is counted in `unpricedTurns` instead of being treated as free — so
 * `meteredCostUsd` is a lower bound whenever that counter is above zero.
 */
export const outcomesSpendDto = z.object({
  turns: z.number().int().nonnegative(),
  unreportedTurns: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  /** Reported turns run under an API-key Profile: the turns that cost money per token. */
  meteredTurns: z.number().int().nonnegative(),
  unpricedTurns: z.number().int().nonnegative(),
  meteredCostUsd: z.number().nonnegative(),
});
export type OutcomesSpendDto = z.infer<typeof outcomesSpendDto>;

export const outcomesWeekDto = z.object({
  /** `YYYY-MM-DD`, the Monday the week starts on (UTC). */
  weekStart: z.string(),
  shipped: z.number().int().nonnegative(),
  /** Of `shipped`, the Tasks with a pull or merge request on at least one Repository. */
  asPullRequest: z.number().int().nonnegative(),
});
export type OutcomesWeekDto = z.infer<typeof outcomesWeekDto>;

export const outcomesDto = z.object({
  window: z.object({
    weeks: z.number().int().positive(),
    /** Start of the first week in the window, ISO timestamp. */
    from: z.string(),
    /** When the figures were read. */
    to: z.string(),
  }),
  /**
   * **Shipped**: a Task that is `done`, has an `approve` decision on one of its Sessions, and has
   * at least one Repository attachment with a result branch (the approval was committed). Dated by
   * its latest approval. "As pull request" when an attachment also carries a change request URL;
   * otherwise the result is a local commit (no remote, or Keep local).
   *
   * A Task moved to Done on the board without an approval is not shipped. A reopened Task is not
   * counted until it is Done again, and then it counts once, in the week of its latest approval.
   */
  shipped: z.object({
    total: z.number().int().nonnegative(),
    asPullRequest: z.number().int().nonnegative(),
    localCommit: z.number().int().nonnegative(),
    /**
     * Approved in the window and committed, but not delivered: `failed` with `delivery_failed`
     * (waiting on Ship again or Keep local) or `partial_integration`.
     */
    approvedNotDelivered: z.number().int().nonnegative(),
    weeks: z.array(outcomesWeekDto),
  }),
  /**
   * The Tasks whose first Session started in the window (**run Tasks**), and how they ended.
   *
   * **Approved**: has an `approve` decision and a committed result branch, whatever happened to
   * the delivery after. **Attempt**: one round of work judged at the review gate. An approved
   * Task's attempts are 1 plus the rounds sent back (`reject` or `request_changes`) before its
   * latest approval, across all of its Sessions and Workflow Steps — so a three-Step Workflow
   * approved first time at every gate is one attempt. A run that failed and was retried without
   * reaching the gate is not an attempt.
   *
   * **In flight**: not approved and `running`, `review` or `parked` now. It has not had its chance
   * yet, so it is left out of both rates' denominator (`settled`).
   */
  approval: z.object({
    runTasks: z.number().int().nonnegative(),
    inFlight: z.number().int().nonnegative(),
    settled: z.number().int().nonnegative(),
    approved: z.number().int().nonnegative(),
    approvedWithinTwo: z.number().int().nonnegative(),
    /** `approved / settled`, or null with nothing settled. */
    approvalRate: z.number().min(0).max(1).nullable(),
    /** `approvedWithinTwo / settled` — the roadmap's success metric. Null with nothing settled. */
    withinTwoRate: z.number().min(0).max(1).nullable(),
    /** Mean attempts per approved Task, or null with none approved. */
    meanAttempts: z.number().nullable(),
    /** Approved Tasks by attempts; the last bucket is "4 or more". */
    attempts: z.array(
      z.object({
        attempts: z.number().int().positive(),
        orMore: z.boolean(),
        tasks: z.number().int().nonnegative(),
      }),
    ),
  }),
  /**
   * Usage recorded in the window (`session_usage.at`), attributed to the Harness Profile each turn
   * ran under. The billing mode is the Profile's **current** mode: a turn does not record the mode
   * it was billed under, so changing a Profile's mode re-labels its past turns.
   */
  spend: z.object({
    total: outcomesSpendDto,
    /** Tasks with at least one turn in the window. */
    tasks: z.number().int().nonnegative(),
    byBillingMode: z.array(outcomesSpendDto.extend({ authMode: authModeSchema })),
    byProfile: z.array(
      outcomesSpendDto.extend({
        profileId: idSchema,
        name: z.string(),
        authMode: authModeSchema,
        tasks: z.number().int().nonnegative(),
      }),
    ),
    /** The Tasks that used the most tokens (input + output + cache) in the window, most first. */
    topTasks: z.array(
      outcomesSpendDto.extend({
        taskId: idSchema,
        title: z.string(),
        state: taskStateSchema,
      }),
    ),
  }),
  /**
   * From the Workspace's creation to the first Task shipped as a pull request (dated by that
   * Task's latest approval). All-time, not windowed. Null `shippedAt` when none has yet.
   */
  firstPullRequest: z.object({
    workspaceCreatedAt: z.string(),
    shippedAt: z.string().nullable(),
    elapsedMs: z.number().int().nonnegative().nullable(),
  }),
});
export type OutcomesDto = z.infer<typeof outcomesDto>;
