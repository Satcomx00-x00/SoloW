import "server-only";
import {
  type AuthMode,
  CommonErrorCode,
  err,
  type OutcomesDto,
  type OutcomesSpendDto,
  ok,
  type Result,
  type TaskState,
} from "@solow/contracts";
import { DELIVERY_FAILED_REASON, deriveCostUsd, PARTIAL_INTEGRATION_REASON } from "@solow/core";
import { workspace } from "@solow/db";
import { eq, type SQL, sql } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Outcomes (finding A4, spec F14): Tasks shipped per week, how often a run reaches an approval
 * and in how many attempts, and what the turns cost. The definitions are on `outcomesDto` in
 * `@solow/contracts`, where the page reads them too; this file is their SQL.
 *
 * Everything is aggregated in SQLite from rows other features already write. Raw SQL rather than
 * the query builder because the per-Task facts below are correlated subqueries read through a
 * CTE, and in builder form the definition the page prints would be hard to find in the code.
 * The names are the database's, not Drizzle's: `session.startedAt` and `session_usage.at` are
 * both stored as `created_at`.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
const TOP_TASKS = 10;

/** Monday 00:00 UTC of the week `now` is in, minus `weeks - 1` whole weeks. */
export function outcomesWindowStart(now: Date, weeks: number): Date {
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // getUTCDay is 0 for Sunday; the ISO week starts on Monday.
  const sinceMonday = (new Date(midnight).getUTCDay() + 6) % 7;
  return new Date(midnight - sinceMonday * DAY_MS - (weeks - 1) * WEEK_MS);
}

/**
 * One row per live Task in the Workspace, with the facts every figure is built from.
 *
 * `approved_at` is the latest `approve` decision on any of its Sessions; `committed` says the
 * approval actually integrated (an attachment holds a result branch, which only integration
 * writes); `has_pr` says a pull or merge request was opened for it, which only a successful ship
 * writes. Every subquery repeats the tenant key rather than trusting the Task id to imply it
 * (Principle V).
 */
function perTask(ws: string): SQL {
  return sql`per_task AS (
    SELECT
      t.id AS id,
      t.title AS title,
      t.state AS state,
      t.failure_reason AS failure_reason,
      (SELECT max(r.created_at) FROM review r
        JOIN session s ON s.id = r.session_id
        WHERE s.task_id = t.id AND s.workspace_id = ${ws} AND r.workspace_id = ${ws}
          AND r.decision = 'approve') AS approved_at,
      EXISTS (SELECT 1 FROM task_repository tr
        WHERE tr.task_id = t.id AND tr.workspace_id = ${ws}
          AND tr.result_branch IS NOT NULL) AS committed,
      EXISTS (SELECT 1 FROM task_repository tr
        WHERE tr.task_id = t.id AND tr.workspace_id = ${ws}
          AND tr.change_request_url IS NOT NULL) AS has_pr,
      (SELECT min(s.created_at) FROM session s
        WHERE s.task_id = t.id AND s.workspace_id = ${ws}) AS first_run_at
    FROM task t
    WHERE t.workspace_id = ${ws} AND t.deleted_at IS NULL
  )`;
}

/**
 * `per_task` plus whether the Task is approved and how many attempts that took: 1, plus every
 * round sent back (`reject` or `request_changes`) before the latest approval.
 */
function judged(ws: string): SQL {
  return sql`${perTask(ws)},
  judged AS (
    SELECT p.*,
      (p.approved_at IS NOT NULL AND p.committed) AS approved,
      1 + (SELECT count(*) FROM review r
        JOIN session s ON s.id = r.session_id
        WHERE s.task_id = p.id AND s.workspace_id = ${ws} AND r.workspace_id = ${ws}
          AND r.decision IN ('reject', 'request_changes')
          AND r.created_at < p.approved_at) AS attempts
    FROM per_task p
  )`;
}

interface UsageSlice {
  authMode: AuthMode;
  model: string | null;
  turns: number;
  unreported: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

function emptySpend(): OutcomesSpendDto {
  return {
    turns: 0,
    unreportedTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    meteredTurns: 0,
    unpricedTurns: 0,
    meteredCostUsd: 0,
  };
}

/**
 * Fold one (group, model) aggregate into a spend total.
 *
 * Priced per model on the summed counts, which is exact: cost is linear in each count. Only
 * API-key turns are priced; a subscription turn has no per-token charge to report.
 */
function addSlice(into: OutcomesSpendDto, slice: UsageSlice): void {
  into.turns += slice.turns;
  into.unreportedTurns += slice.unreported;
  into.inputTokens += slice.inputTokens;
  into.outputTokens += slice.outputTokens;
  into.cacheReadTokens += slice.cacheReadTokens;
  into.cacheWriteTokens += slice.cacheWriteTokens;
  if (slice.authMode !== "api_key") return;
  const reported = slice.turns - slice.unreported;
  if (reported === 0) return;
  into.meteredTurns += reported;
  const cost = deriveCostUsd(slice);
  if (cost === null) into.unpricedTurns += reported;
  else into.meteredCostUsd += cost;
}

function totalTokens(spend: OutcomesSpendDto): number {
  return spend.inputTokens + spend.outputTokens + spend.cacheReadTokens + spend.cacheWriteTokens;
}

const n = (value: number | null | undefined): number => Number(value ?? 0);

/** The usage columns every spend query selects, summed per group. */
const USAGE_SUMS = sql`
  count(*) AS turns,
  sum(CASE WHEN su.reported THEN 0 ELSE 1 END) AS unreported,
  sum(su.input_tokens) AS input_tokens,
  sum(su.output_tokens) AS output_tokens,
  sum(su.cache_read_tokens) AS cache_read_tokens,
  sum(su.cache_write_tokens) AS cache_write_tokens`;

interface UsageRow {
  model: string | null;
  auth_mode: AuthMode;
  turns: number;
  unreported: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
}

function sliceOf(row: UsageRow): UsageSlice {
  return {
    authMode: row.auth_mode,
    model: row.model,
    turns: n(row.turns),
    unreported: n(row.unreported),
    inputTokens: n(row.input_tokens),
    outputTokens: n(row.output_tokens),
    cacheReadTokens: n(row.cache_read_tokens),
    cacheWriteTokens: n(row.cache_write_tokens),
  };
}

export async function workspaceOutcomes(
  ctx: RequestContext,
  input: { weeks: number },
  now: Date = new Date(),
): Promise<Result<OutcomesDto>> {
  const ws = ctx.workspaceId;
  const fromDate = outcomesWindowStart(now, input.weeks);
  const from = fromDate.toISOString();

  const [owner] = await ctx.db
    .select({ createdAt: workspace.createdAt })
    .from(workspace)
    .where(eq(workspace.id, ws))
    .limit(1);
  if (!owner) return err(CommonErrorCode.NotFound);

  // Shipped, per week of the latest approval. `date(x, 'weekday 0', '-6 days')` is the Monday on
  // or before x: forward to the next Sunday (x itself on a Sunday), then back six days.
  const weekRows = await ctx.db.all<{ week_start: string; shipped: number; as_pr: number }>(sql`
    WITH ${perTask(ws)}
    SELECT date(approved_at, 'weekday 0', '-6 days') AS week_start,
      count(*) AS shipped,
      sum(has_pr) AS as_pr
    FROM per_task
    WHERE state = 'done' AND committed AND approved_at IS NOT NULL AND approved_at >= ${from}
    GROUP BY week_start`);

  const [stranded] = await ctx.db.all<{ tasks: number }>(sql`
    WITH ${perTask(ws)}
    SELECT count(*) AS tasks FROM per_task
    WHERE state = 'failed' AND committed AND approved_at >= ${from}
      AND failure_reason IN (${DELIVERY_FAILED_REASON}, ${PARTIAL_INTEGRATION_REASON})`);

  const [cohort] = await ctx.db.all<{
    run: number;
    in_flight: number | null;
    approved: number | null;
    within_two: number | null;
    mean_attempts: number | null;
  }>(sql`
    WITH ${judged(ws)}
    SELECT count(*) AS run,
      sum(CASE WHEN NOT approved AND state IN ('running', 'review', 'parked') THEN 1 ELSE 0 END)
        AS in_flight,
      sum(approved) AS approved,
      sum(CASE WHEN approved AND attempts <= 2 THEN 1 ELSE 0 END) AS within_two,
      avg(CASE WHEN approved THEN attempts END) AS mean_attempts
    FROM judged
    WHERE first_run_at >= ${from}`);

  const attemptRows = await ctx.db.all<{ bucket: number; tasks: number }>(sql`
    WITH ${judged(ws)}
    SELECT min(attempts, 4) AS bucket, count(*) AS tasks
    FROM judged
    WHERE first_run_at >= ${from} AND approved
    GROUP BY bucket`);

  const [firstPr] = await ctx.db.all<{ shipped_at: string | null }>(sql`
    WITH ${perTask(ws)}
    SELECT min(approved_at) AS shipped_at FROM per_task WHERE has_pr AND approved_at IS NOT NULL`);

  // Spend. Usage joins its Task so a deleted Task's turns leave with it, and its Profile for the
  // name and billing mode. Grouped by model as well as by the slice, because price is per model.
  const usageScope = sql`
    FROM session_usage su
    JOIN task t ON t.id = su.task_id AND t.workspace_id = ${ws} AND t.deleted_at IS NULL
    JOIN agent_profile p ON p.id = su.agent_profile_id AND p.workspace_id = ${ws}
    WHERE su.workspace_id = ${ws} AND su.created_at >= ${from}`;

  const profileRows = await ctx.db.all<
    UsageRow & { profile_id: string; name: string; tasks: number }
  >(sql`
    SELECT su.agent_profile_id AS profile_id, p.name AS name, p.auth_mode AS auth_mode,
      su.model AS model, ${USAGE_SUMS}
    ${usageScope}
    GROUP BY su.agent_profile_id, su.model`);

  const profileTaskRows = await ctx.db.all<{ profile_id: string; tasks: number }>(sql`
    SELECT su.agent_profile_id AS profile_id, count(DISTINCT su.task_id) AS tasks
    ${usageScope}
    GROUP BY su.agent_profile_id`);

  const [usedTasks] = await ctx.db.all<{ tasks: number }>(sql`
    SELECT count(DISTINCT su.task_id) AS tasks ${usageScope}`);

  const taskRows = await ctx.db.all<
    UsageRow & { task_id: string; title: string; state: TaskState }
  >(
    sql`
    SELECT su.task_id AS task_id, t.title AS title, t.state AS state, p.auth_mode AS auth_mode,
      su.model AS model, ${USAGE_SUMS}
    ${usageScope}
    GROUP BY su.task_id, p.auth_mode, su.model`,
  );

  // Fold the model-level groups into the slices the page shows.
  const total = emptySpend();
  const modes = new Map<AuthMode, OutcomesSpendDto>();
  const profiles = new Map<
    string,
    OutcomesSpendDto & { profileId: string; name: string; authMode: AuthMode; tasks: number }
  >();
  const profileTasks = new Map(profileTaskRows.map((r) => [r.profile_id, n(r.tasks)]));
  for (const row of profileRows) {
    const slice = sliceOf(row);
    addSlice(total, slice);
    const mode = modes.get(slice.authMode) ?? emptySpend();
    addSlice(mode, slice);
    modes.set(slice.authMode, mode);
    const profile = profiles.get(row.profile_id) ?? {
      ...emptySpend(),
      profileId: row.profile_id,
      name: row.name,
      authMode: row.auth_mode,
      tasks: profileTasks.get(row.profile_id) ?? 0,
    };
    addSlice(profile, slice);
    profiles.set(row.profile_id, profile);
  }

  const tasks = new Map<
    string,
    OutcomesSpendDto & { taskId: string; title: string; state: TaskState }
  >();
  for (const row of taskRows) {
    const entry = tasks.get(row.task_id) ?? {
      ...emptySpend(),
      taskId: row.task_id,
      title: row.title,
      state: row.state,
    };
    addSlice(entry, sliceOf(row));
    tasks.set(row.task_id, entry);
  }

  const weeks = new Map(weekRows.map((r) => [r.week_start, r]));
  const weekList = Array.from({ length: input.weeks }, (_, i) => {
    const weekStart = new Date(fromDate.getTime() + i * WEEK_MS).toISOString().slice(0, 10);
    const row = weeks.get(weekStart);
    return { weekStart, shipped: n(row?.shipped), asPullRequest: n(row?.as_pr) };
  });
  const shippedTotal = weekList.reduce((sum, w) => sum + w.shipped, 0);
  const asPullRequest = weekList.reduce((sum, w) => sum + w.asPullRequest, 0);

  const runTasks = n(cohort?.run);
  const inFlight = n(cohort?.in_flight);
  const settled = runTasks - inFlight;
  const approved = n(cohort?.approved);
  const approvedWithinTwo = n(cohort?.within_two);
  const buckets = new Map(attemptRows.map((r) => [n(r.bucket), n(r.tasks)]));

  const shippedAt = firstPr?.shipped_at ?? null;

  return ok({
    window: { weeks: input.weeks, from, to: now.toISOString() },
    shipped: {
      total: shippedTotal,
      asPullRequest,
      localCommit: shippedTotal - asPullRequest,
      approvedNotDelivered: n(stranded?.tasks),
      weeks: weekList,
    },
    approval: {
      runTasks,
      inFlight,
      settled,
      approved,
      approvedWithinTwo,
      approvalRate: settled > 0 ? approved / settled : null,
      withinTwoRate: settled > 0 ? approvedWithinTwo / settled : null,
      meanAttempts: cohort?.mean_attempts ?? null,
      attempts: [1, 2, 3, 4].map((attempts) => ({
        attempts,
        orMore: attempts === 4,
        tasks: buckets.get(attempts) ?? 0,
      })),
    },
    spend: {
      total,
      tasks: n(usedTasks?.tasks),
      byBillingMode: (["subscription", "api_key"] as const).flatMap((authMode) => {
        const mode = modes.get(authMode);
        return mode ? [{ ...mode, authMode }] : [];
      }),
      byProfile: [...profiles.values()].sort((a, b) => totalTokens(b) - totalTokens(a)),
      topTasks: [...tasks.values()]
        .sort((a, b) => totalTokens(b) - totalTokens(a))
        .slice(0, TOP_TASKS),
    },
    firstPullRequest: {
      workspaceCreatedAt: owner.createdAt,
      shippedAt,
      elapsedMs: shippedAt
        ? Math.max(0, Date.parse(shippedAt) - Date.parse(owner.createdAt))
        : null,
    },
  });
}
