import { z } from "zod";
import { idSchema, taskStateSchema } from "./common.js";

/**
 * The product's view of its own health (FINDINGS F3): whether the services a run needs are
 * reachable, and which Tasks need a person because their run failed or stopped moving.
 */

/**
 * One service, as the browser is told about it.
 *
 * - `ok`: answered.
 * - `unreachable`: was asked and did not answer, or answered with an error.
 * - `not_configured`: nothing says where it is (a dev stack started without an orchestrator).
 * - `unknown`: could not be asked — the engine, when the orchestrator in front of it is down, or
 *   a hosted engine this deployment has no address for.
 */
export const serviceStateSchema = z.enum(["ok", "unreachable", "not_configured", "unknown"]);
export type ServiceState = z.infer<typeof serviceStateSchema>;

export const serviceHealthDto = z.object({
  state: serviceStateSchema,
  /** What went wrong, in a few words, for whoever is debugging it — null when `ok`. */
  detail: z.string().nullable(),
});
export type ServiceHealthDto = z.infer<typeof serviceHealthDto>;

/**
 * What the orchestrator's `GET /health` answers.
 *
 * The orchestrator answering at all is its own health; the engine half is its probe of the
 * durable engine it hands runs to, because only the orchestrator knows that address.
 */
export const orchestratorHealthReport = z.object({
  status: z.literal("ok"),
  service: z.literal("orchestrator"),
  engine: serviceHealthDto,
});
export type OrchestratorHealthReport = z.infer<typeof orchestratorHealthReport>;

/** What the web app tells the browser: both services the run loop depends on, as of `checkedAt`. */
export const systemHealthDto = z.object({
  orchestrator: serviceHealthDto,
  engine: serviceHealthDto,
  checkedAt: z.string().datetime(),
});
export type SystemHealthDto = z.infer<typeof systemHealthDto>;

/**
 * Why a Task needs a person. The rule that assigns these is `runAttention` in `@solow/core`.
 *
 * - `failed`: the Task is `failed`, whatever its reason.
 * - `decision_not_applied`: a review decision was recorded and the run that applies it never ran.
 * - `park_never_resumed`: the orchestrator found a parked run that slept through its wake-up.
 * - `park_overdue`: the same, read from the clock before (or without) the orchestrator saying so.
 * - `run_silent`: running, not finished, and nothing in its log for a long while.
 */
export const attentionCauseSchema = z.enum([
  "failed",
  "decision_not_applied",
  "park_never_resumed",
  "park_overdue",
  "run_silent",
]);
export type AttentionCause = z.infer<typeof attentionCauseSchema>;

/** `failed` ended badly; `stuck` has not ended and is not moving. */
export const attentionKindSchema = z.enum(["failed", "stuck"]);
export type AttentionKind = z.infer<typeof attentionKindSchema>;

export const attentionItemDto = z.object({
  taskId: idSchema,
  title: z.string(),
  state: taskStateSchema,
  failureReason: z.string().nullable(),
  kind: attentionKindSchema,
  cause: attentionCauseSchema,
  /** When the condition began, as best the rows can say. */
  since: z.string().datetime(),
});
export type AttentionItemDto = z.infer<typeof attentionItemDto>;

export const attentionListDto = z.object({
  /** Newest first. */
  items: z.array(attentionItemDto),
  /** More Tasks qualified than the list carries. */
  truncated: z.boolean(),
  /**
   * The next moment a Task not on the list would join it by the clock alone (a run going quiet,
   * a park overrunning its wake-up), or null when none would. A screen re-reads then instead of
   * polling: nothing announces a run that has gone quiet, because going quiet is not an event.
   */
  recheckAt: z.string().datetime().nullable(),
  /**
   * The same moment as a delay from when the server answered, in milliseconds. This is what a
   * client should wait: `recheckAt` is on the server's clock, and a browser comparing it against
   * its own would re-read early, or late, by however far the two disagree.
   */
  recheckInMs: z.number().int().nonnegative().nullable(),
});
export type AttentionListDto = z.infer<typeof attentionListDto>;
