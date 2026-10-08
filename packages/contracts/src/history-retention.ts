import { z } from "zod";
import type { SessionEventKind } from "./session.js";

/**
 * History retention for finished Tasks (Decision 0032, FINDINGS F4).
 *
 * A finished Task keeps its *record* for as long as it exists — the Task, its Sessions, reviews,
 * Workflow decisions, state changes and token usage, which are what History and the outcome
 * metrics read. What it does not keep forever is the *transcript*: every line the harness said
 * and every tool call and result it made, which is where nearly all of the database's growth is.
 * This is the rule that decides when a transcript goes, stored per Workspace.
 */

/**
 * The windows the Settings picker offers, in days. A closed list rather than any integer:
 * every value here has been looked at against the seven-day History window, and an API caller
 * choosing 8 is not a case anyone needs.
 *
 * Never shorter than `TASK_RETENTION_DAYS` (7, `@solow/core`): a Task is restorable and
 * resumable for that week, and one whose transcript vanished inside it would come back from
 * History as a shell. `@solow/core`'s tests hold the two numbers together.
 */
export const HISTORY_RETENTION_DAY_OPTIONS = [7, 30, 90, 365] as const;
export type HistoryRetentionDays = (typeof HISTORY_RETENTION_DAY_OPTIONS)[number];

/**
 * What a Workspace starts with — and what every existing Workspace got when the rule arrived
 * (the migration that added the column fills it with this). Four times the History window, long enough to look
 * back over a month's work; see Decision 0032 for why a default at all.
 */
export const HISTORY_RETENTION_DEFAULT_DAYS: HistoryRetentionDays = 30;

/**
 * The event kinds a transcript is made of — removed outright once the window is up.
 *
 * Everything a person or a harness *said or did* in the conversation. None of it is read by
 * anything once the Task is finished except a person scrolling the terminal.
 */
export const HISTORY_PRUNED_EVENT_KINDS = [
  "user_turn",
  "assistant_turn",
  "notice",
  "tool_call",
  "tool_result",
  "todos",
  "permission_request",
  "permission_resolved",
  "widget",
  "widget_response",
] as const satisfies readonly SessionEventKind[];

/**
 * The event kinds that survive, and why each one does:
 *
 *  - `state` — the Task's transitions. Rounds, the reclaim sweep's review clock and the outcome
 *    metrics (time to approval) are read from these.
 *  - `workflow_decision` — which Step ended and where the Workflow went (`session.stepDecisions`).
 *  - `agent_done` — how each run ended, the one-line fact a health view counts.
 *  - `diff` — kept as the file list with its line counts; only the `patch` text is emptied
 *    (`truncated: true`). The round view is built from these rows, and the patch itself lives on
 *    in the branch or the pull request.
 *
 * Small, structural, and few per Session — together a rounding error beside the transcript.
 */
export const HISTORY_KEPT_EVENT_KINDS = [
  "state",
  "workflow_decision",
  "agent_done",
  "diff",
  "usage",
] as const satisfies readonly SessionEventKind[];

export const historyRetentionDaysSchema = z
  .number()
  .int()
  .refine(
    (n): n is HistoryRetentionDays =>
      (HISTORY_RETENTION_DAY_OPTIONS as readonly number[]).includes(n),
    {
      message: `Must be one of ${HISTORY_RETENTION_DAY_OPTIONS.join(", ")} days`,
    },
  );

/** `null` keeps transcripts forever. */
export const historyRetentionSettingSchema = historyRetentionDaysSchema.nullable();

export const historyRetentionDto = z.object({
  /** The stored window, or null for "keep forever". */
  days: historyRetentionSettingSchema,
  defaultDays: z.number().int(),
  options: z.array(z.number().int()),
});
export type HistoryRetentionDto = z.infer<typeof historyRetentionDto>;

export const setHistoryRetentionInput = z.object({ days: historyRetentionSettingSchema });
export type SetHistoryRetentionInput = z.infer<typeof setHistoryRetentionInput>;

/**
 * What a window *would* remove if the sweep ran now — asked before the Owner saves a shorter
 * one, so the choice is made looking at its cost. No null: "keep forever" removes nothing, and
 * a GET's query string has no way to spell it.
 */
export const previewHistoryRetentionInput = z.object({ days: historyRetentionDaysSchema });
export type PreviewHistoryRetentionInput = z.infer<typeof previewHistoryRetentionInput>;

export const historyRetentionPreviewDto = z.object({
  /** Finished Tasks with at least one Session still holding a transcript past the window. */
  tasks: z.number().int().nonnegative(),
  sessions: z.number().int().nonnegative(),
  /** Transcript events that would be deleted. */
  events: z.number().int().nonnegative(),
  /** Captured diffs whose patch text would be emptied. */
  diffs: z.number().int().nonnegative(),
  /** Approximate bytes of payload freed — the stored JSON's length, not pages on disk. */
  bytes: z.number().int().nonnegative(),
});
export type HistoryRetentionPreviewDto = z.infer<typeof historyRetentionPreviewDto>;
