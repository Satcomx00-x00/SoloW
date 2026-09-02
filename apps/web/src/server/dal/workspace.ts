import "server-only";
import {
  CommonErrorCode,
  err,
  ok,
  type RenameWorkspaceInput,
  type Result,
  type SetupStepDto,
  type SyncRequestDto,
  type SyncStatusDto,
  type WorkspaceDto,
  type WorkspaceSetupDto,
} from "@solow/contracts";
import {
  agentCatalog,
  agentProfile,
  type Db,
  executorProfile,
  FLAGS,
  type FlagKey,
  repository,
  secret,
  workspace,
} from "@solow/db";
import { and, count, eq, isNotNull } from "drizzle-orm";
import { orchestrator } from "../orchestrator-client.js";
import type { RequestContext } from "./context.js";

/**
 * Workspace-level reads used before a `RequestContext` exists — the flag overrides are needed to
 * build the request context itself, so this one takes the db and the tenant key directly.
 */

/**
 * Feature-flag overrides stored on the Workspace (task TASK-001). Absent or malformed JSON
 * yields no overrides, so the registry default (OFF) stands — a corrupt column must never be
 * read as "the feature is on".
 */
export async function getWorkspaceFlags(
  db: Db,
  workspaceId: string,
): Promise<Partial<Record<FlagKey, boolean>>> {
  const [row] = await db
    .select({ enabledFlags: workspace.enabledFlags })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);

  const raw = row?.enabledFlags;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};

  // Validated against the flag registry rather than a hardcoded key. The previous version named
  // `ff-core-program` literally, which silently dropped every later flag — `ff-integrations`
  // (issue #15) could be set in this column and would still read as OFF. Driving the check off
  // FLAGS means registering a flag is the only step needed for it to be readable here.
  const overrides: Partial<Record<FlagKey, boolean>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key in FLAGS && typeof value === "boolean") overrides[key as FlagKey] = value;
  }
  return overrides;
}

/** The Workspace's display name, for the shell. Null when the row has gone. */
export async function getWorkspaceName(db: Db, workspaceId: string): Promise<string | null> {
  const [row] = await db
    .select({ name: workspace.name })
    .from(workspace)
    .where(eq(workspace.id, workspaceId))
    .limit(1);
  return row?.name ?? null;
}

/**
 * How current the mirror is — one read, no network, for the status bar.
 *
 * Every field is the *pessimistic* aggregate, and that is the whole design. A bar that averaged
 * its repositories, or took the newest watermark, would read "synced just now" while one
 * connection had been rate limited since yesterday — which is precisely the situation the bar
 * exists to make visible. So the age shown is the age of the repository that is furthest behind,
 * and a repository that has never been read makes the answer null rather than optimistic.
 */
export async function getSyncStatus(ctx: RequestContext): Promise<Result<SyncStatusDto>> {
  const rows = await ctx.db
    .select({
      issuesSyncedAt: repository.issuesSyncedAt,
      syncStaleSince: repository.syncStaleSince,
      syncStaleReason: repository.syncStaleReason,
    })
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), isNotNull(repository.integrationId)));

  let oldest: string | null = null;
  let neverRead = false;
  let stale = 0;
  let staleReason: string | null = null;
  for (const row of rows) {
    if (!row.issuesSyncedAt) neverRead = true;
    else if (oldest === null || row.issuesSyncedAt < oldest) oldest = row.issuesSyncedAt;
    if (row.syncStaleSince) {
      stale += 1;
      staleReason ??= row.syncStaleReason;
    }
  }

  return ok({
    repositories: rows.length,
    // One repository that has never been read makes the whole answer unknown. "Synced 2 minutes
    // ago" alongside a repository nobody has ever read is a claim about rows that do not exist.
    syncedAt: neverRead ? null : oldest,
    stale,
    staleReason,
  });
}

/**
 * Run the poll now, across everything this Workspace has linked.
 *
 * The global counterpart to the project-scoped refresh, and deliberately the *same* durable pass
 * the five-minute cron runs rather than a second implementation of it — see
 * `requestMirrorSync` in the orchestrator client for why "refresh" must mean one thing.
 *
 * Returns on the handoff, not on the read: a button that blocked until every repository had
 * answered would hold a request open for as long as the slowest provider takes, and the screen
 * would learn nothing it is not about to be told anyway. The mirror announcement on the
 * WebSocket is what says the pass landed.
 */
/**
 * The slice of the orchestrator client this needs, injected so a test can assert the handoff.
 *
 * Injected rather than mocked at the module level, and the difference is not stylistic: Bun's
 * `mock.module` replaces a module for the whole test *process*, so a stub installed here would
 * have followed every other suite in the run — which it did, taking nineteen unrelated tests
 * with it before this became a parameter. Every other collaborator in this codebase is passed
 * in for the same reason.
 */
export interface MirrorSyncRequester {
  isWired(): boolean;
  requestMirrorSync(input: { workspaceId: string }): Promise<void>;
}

export async function requestWorkspaceSync(
  ctx: RequestContext,
  client: MirrorSyncRequester = orchestrator,
): Promise<Result<SyncRequestDto>> {
  const [linked] = await ctx.db
    .select({ value: count() })
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), isNotNull(repository.integrationId)));
  const repositories = linked?.value ?? 0;

  if (!client.isWired()) return ok({ accepted: false, repositories });
  try {
    await client.requestMirrorSync({ workspaceId: ctx.workspaceId });
  } catch {
    // The engine is unreachable. Answered rather than thrown, because the caller is a status bar
    // button and "we could not ask" is a state it can show — where a red toast reading
    // "Internal error" would send someone looking for a fault in their provider.
    return ok({ accepted: false, repositories });
  }
  return ok({ accepted: true, repositories });
}

/** The Workspace itself, for the header control and the Settings section. */
export async function getWorkspace(ctx: RequestContext): Promise<Result<WorkspaceDto>> {
  const [row] = await ctx.db
    .select({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt })
    .from(workspace)
    .where(eq(workspace.id, ctx.workspaceId))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  return ok({ id: row.id, name: row.name, createdAt: row.createdAt });
}

/** Rename it. The id is never taken from the caller — it is the session's own (Principle V). */
export async function renameWorkspace(
  ctx: RequestContext,
  input: RenameWorkspaceInput,
): Promise<Result<WorkspaceDto>> {
  const updated = await ctx.db
    .update(workspace)
    .set({ name: input.name, updatedAt: new Date().toISOString() })
    .where(eq(workspace.id, ctx.workspaceId))
    .returning({ id: workspace.id, name: workspace.name, createdAt: workspace.createdAt });

  const row = updated[0];
  if (!row) return err(CommonErrorCode.NotFound);
  return ok({ id: row.id, name: row.name, createdAt: row.createdAt });
}

/** How many rows of one kind this Workspace has. */
async function tally(
  ctx: RequestContext,
  table: typeof secret | typeof agentProfile | typeof executorProfile | typeof repository,
): Promise<number> {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(table)
    .where(eq(table.workspaceId, ctx.workspaceId));
  return row?.n ?? 0;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What this Workspace still needs, read from what it actually has (2026-08-28).
 *
 * This replaced a fixture. A local install used to arrive with two invented companies, each
 * already holding a credential, an Agent Profile, an Executor and a repository — so the product
 * looked configured on first launch and the real gap stayed invisible: a Workspace made by a
 * genuine sign-up has none of those, and its feature flags are off, so the core loop is
 * disabled. The honest version is to ask the database.
 *
 * Derived on every read rather than stored. A checklist that recorded "completed" would go on
 * saying so after the Secret it counted was deleted, which is precisely the moment it should say
 * otherwise — so this doubles as a standing health view instead of a one-time ceremony.
 */
export async function getWorkspaceSetup(ctx: RequestContext): Promise<Result<WorkspaceSetupDto>> {
  const found = await getWorkspace(ctx);
  if (!found.ok) return found;

  const [catalog] = await ctx.db
    .select({ n: count() })
    .from(agentCatalog)
    .where(eq(agentCatalog.workspaceId, ctx.workspaceId));
  const agents = catalog?.n ?? 0;

  const [secrets, profiles, executors, repositories] = await Promise.all([
    tally(ctx, secret),
    tally(ctx, agentProfile),
    tally(ctx, executorProfile),
    tally(ctx, repository),
  ]);

  const flags = await getWorkspaceFlags(ctx.db, ctx.workspaceId);
  const coreLoop = flags["ff-core-program"] ?? FLAGS["ff-core-program"].default;

  const steps: SetupStepDto[] = [
    // Always done by the time anyone can read this — but listed, because a checklist that only
    // shows what is missing gives no sense of how much of the whole it represents.
    { key: "workspace", done: true, detail: found.data.name, blockedBy: null },
    {
      key: "agents",
      done: agents > 0,
      detail: agents > 0 ? plural(agents, "agent") : "",
      blockedBy: null,
    },
    {
      key: "secret",
      done: secrets > 0,
      detail: secrets > 0 ? plural(secrets, "secret") : "",
      blockedBy: null,
    },
    {
      key: "agent-profile",
      done: profiles > 0,
      detail: profiles > 0 ? plural(profiles, "profile") : "",
      // A Profile binds an agent to a credential, so offering the form before one exists would
      // open it on an empty picker — a worse answer than naming what is missing.
      blockedBy: profiles === 0 && secrets === 0 ? "secret" : null,
    },
    {
      key: "executor",
      done: executors > 0,
      detail: executors > 0 ? plural(executors, "executor") : "",
      blockedBy: null,
    },
    {
      key: "repository",
      done: repositories > 0,
      detail: repositories > 0 ? plural(repositories, "repository", "repositories") : "",
      blockedBy: null,
    },
    {
      key: "core-loop",
      done: coreLoop,
      detail: coreLoop ? "on" : "",
      blockedBy: null,
    },
  ];

  return ok({ workspace: found.data, steps, ready: steps.every((step) => step.done) });
}
