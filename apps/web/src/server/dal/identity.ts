import "server-only";
import {
  type ClearProviderIdentityInput,
  CommonErrorCode,
  err,
  ok,
  type ProjectIdentityDto,
  type ProjectIdentityInput,
  type ProviderIdentityDto,
  type Result,
  type SetProviderIdentityInput,
} from "@gatecontrol/contracts";
import { integration, project, providerIdentity } from "@gatecontrol/db";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Who the signed-in user is on each connected provider (spec F23 FR-11).
 *
 * This exists to answer one question honestly: **who is `@me`?** The planning table filters
 * `assignee:@me` against the logins the provider mirrored onto each row, and a GateControl
 * account name is not one of those. Before this, `@me` compared the two and matched when they
 * happened to agree — a `My items` tab that is empty for almost everyone.
 *
 * The mapping is *stated by each user*, per Integration, rather than read off the token. The PAT
 * is the Workspace's: whoever connected the Integration issued it, and everyone reads through
 * it, so the provider's answer to "who am I" is the login of the person who pasted the token —
 * not the person looking at the table. See `providerIdentity` in the schema for the full
 * reasoning and for what a derived *suggestion* would still need.
 *
 * Every read joins through `integration` and is scoped by `workspaceId` and `userId` from the
 * session (Principle V). No token, and no fact about one, passes through here (Principle IV).
 */

/**
 * The signed-in user's mappings in this Workspace, one per Integration they have stated.
 *
 * Inner-joined to `integration` on purpose: a mapping whose Integration was disconnected is not
 * a mapping. `provider_identity.integration_id` carries no foreign key (disconnecting must not
 * be blocked by a convenience row), so this join is what keeps a stale row from being offered as
 * a live connection — and from being inherited by a reconnection that is a different connection.
 */
export async function listProviderIdentities(
  ctx: RequestContext,
): Promise<Result<ProviderIdentityDto[]>> {
  const rows = await ctx.db
    .select({
      integrationId: providerIdentity.integrationId,
      provider: integration.provider,
      login: providerIdentity.login,
      createdAt: providerIdentity.createdAt,
      updatedAt: providerIdentity.updatedAt,
    })
    .from(providerIdentity)
    .innerJoin(integration, eq(integration.id, providerIdentity.integrationId))
    .where(
      and(
        eq(providerIdentity.workspaceId, ctx.workspaceId),
        eq(providerIdentity.userId, ctx.userId),
        eq(integration.workspaceId, ctx.workspaceId),
      ),
    );
  return ok(rows);
}

/**
 * State — or correct — the signed-in user's login on one Integration.
 *
 * The Integration is checked to exist *in this Workspace* first, so an id belonging to another
 * tenant is a NotFound rather than a row this Workspace can never read back (Principle V). The
 * write is an upsert against the unique triple, which is what makes a correction replace the
 * previous answer instead of adding a second one.
 */
export async function setProviderIdentity(
  ctx: RequestContext,
  input: SetProviderIdentityInput,
): Promise<Result<ProviderIdentityDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select({ id: integration.id, provider: integration.provider })
    .from(integration)
    .where(
      and(eq(integration.workspaceId, ctx.workspaceId), eq(integration.id, input.integrationId)),
    )
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const now = new Date().toISOString();
  const [saved] = await ctx.db
    .insert(providerIdentity)
    .values({
      workspaceId: ctx.workspaceId,
      integrationId: row.id,
      userId: ctx.userId,
      login: input.login,
    })
    .onConflictDoUpdate({
      target: [
        providerIdentity.workspaceId,
        providerIdentity.integrationId,
        providerIdentity.userId,
      ],
      set: { login: input.login, updatedAt: now },
    })
    .returning();
  if (!saved) return err(CommonErrorCode.NotFound);

  return ok({
    integrationId: saved.integrationId,
    provider: row.provider,
    login: saved.login,
    createdAt: saved.createdAt,
    updatedAt: saved.updatedAt,
  });
}

/**
 * Forget the signed-in user's login on one Integration.
 *
 * Deleting rather than storing an empty string: "not stated" and "stated as nothing" have to
 * stay the same state, or `@me` would have a second way to mean nothing and the UI a second
 * thing to explain.
 */
export async function clearProviderIdentity(
  ctx: RequestContext,
  input: ClearProviderIdentityInput,
): Promise<Result<{ integrationId: string }, typeof CommonErrorCode.NotFound>> {
  const deleted = await ctx.db
    .delete(providerIdentity)
    .where(
      and(
        eq(providerIdentity.workspaceId, ctx.workspaceId),
        eq(providerIdentity.userId, ctx.userId),
        eq(providerIdentity.integrationId, input.integrationId),
      ),
    )
    .returning({ integrationId: providerIdentity.integrationId });
  if (deleted.length === 0) return err(CommonErrorCode.NotFound);
  return ok({ integrationId: input.integrationId });
}

/**
 * What `@me` resolves to on one Project — the whole point of the table above.
 *
 * Resolved here rather than in the client, because the client would have to join Project →
 * Integration → mapping itself and would then own a rule about *whose* login it may read. A
 * Project belongs to exactly one Integration (F23, States & rules), so there is exactly one
 * login that can mean "me" on it.
 *
 * A missing mapping answers `login: null` rather than an error: it is an ordinary state — nobody
 * has said who they are on this provider yet — and it is the state the caller has to be able to
 * *say*, since `@me` resolved to nothing looks exactly like a project with nothing assigned to
 * you. The filter itself already treats a null `me` as matching nothing rather than everything.
 */
export async function providerIdentityForProject(
  ctx: RequestContext,
  input: ProjectIdentityInput,
): Promise<Result<ProjectIdentityDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select({ integrationId: project.integrationId })
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const [mapping] = await ctx.db
    .select({ login: providerIdentity.login })
    .from(providerIdentity)
    .where(
      and(
        eq(providerIdentity.workspaceId, ctx.workspaceId),
        eq(providerIdentity.userId, ctx.userId),
        eq(providerIdentity.integrationId, row.integrationId),
      ),
    )
    .limit(1);

  return ok({
    projectId: input.projectId,
    integrationId: row.integrationId,
    login: mapping?.login ?? null,
  });
}
