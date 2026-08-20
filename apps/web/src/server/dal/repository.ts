import "server-only";
import {
  CommonErrorCode,
  type ConnectRepositoryInput,
  err,
  IntegrationErrorCode,
  ok,
  type RepositoryDto,
  type RepositoryLabelDto,
  type Result,
  type UpdateRepositorySetupInput,
} from "@gatecontrol/contracts";
import { decryptForScmSync, integration, repository, secret } from "@gatecontrol/db";
import { providerFor, type ScmCredential } from "@gatecontrol/scm";
import { and, desc, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { repositoryToDto } from "./mappers.js";

export async function getRepository(
  ctx: RequestContext,
  id: string,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, id)))
    .limit(1);
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.NotFound);
}

export async function connectRepository(
  ctx: RequestContext,
  input: ConnectRepositoryInput,
): Promise<Result<RepositoryDto>> {
  const [row] = await ctx.db
    .insert(repository)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name,
      source: input.source,
      location: input.location,
    })
    .returning();
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.ValidationFailed);
}

export async function listRepositories(ctx: RequestContext): Promise<Result<RepositoryDto[]>> {
  const rows = await ctx.db
    .select()
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId))
    .orderBy(desc(repository.createdAt));
  return ok(rows.map(repositoryToDto));
}

/**
 * Replace a Repository's setup-file allowlist (issue #52).
 *
 * Scoped by `workspaceId` in the `where`, like every other write here: the allowlist decides
 * which files are copied into a worktree, so letting one Workspace edit another's would be a
 * tenancy hole with a credential on the other side of it (Principle V).
 */
export async function updateRepositorySetup(
  ctx: RequestContext,
  input: UpdateRepositorySetupInput,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .update(repository)
    .set({ setupFilePatterns: input.setupFilePatterns, updatedAt: new Date().toISOString() })
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, input.repositoryId)))
    .returning();
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.NotFound);
}

/**
 * The two-step Repository → Integration → decrypted credential lookup `apps/web/src/server/dal/
 * integration.ts`'s `loadCredential`/`loadLinkedRepository` already do — duplicated here rather
 * than imported because those helpers are not exported from that file, and that file belongs to
 * a different track this run (see this track's file-ownership list). Same reasoning, same
 * result: the credential never leaves this module as plaintext, and everything is scoped to
 * `ctx.workspaceId` (Principle V).
 */
async function loadRepositoryCredential(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<
    { provider: "github" | "gitlab"; credential: ScmCredential; externalFullName: string },
    typeof CommonErrorCode.NotFound | typeof IntegrationErrorCode.NotLinked
  >
> {
  const [repo] = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, repositoryId)))
    .limit(1);
  if (!repo) return err(CommonErrorCode.NotFound);
  if (!repo.integrationId || !repo.externalFullName) return err(IntegrationErrorCode.NotLinked);

  const [integrationRow] = await ctx.db
    .select()
    .from(integration)
    .where(
      and(eq(integration.workspaceId, ctx.workspaceId), eq(integration.id, repo.integrationId)),
    )
    .limit(1);
  if (!integrationRow) return err(CommonErrorCode.NotFound);

  const [secretRow] = await ctx.db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, integrationRow.secretId)))
    .limit(1);
  if (!secretRow) return err(CommonErrorCode.NotFound);

  return ok({
    provider: integrationRow.provider,
    credential: { token: decryptForScmSync(secretRow.ciphertext), baseUrl: integrationRow.baseUrl },
    externalFullName: repo.externalFullName,
  });
}

/**
 * A linked Repository's real labels, for the Issue label picker (issue #15 reversal). Only
 * meaningful for a Repository linked to a GitHub/GitLab Integration — a local-path Repository
 * has nothing to fetch, which is exactly what `IntegrationErrorCode.NotLinked` communicates.
 */
export async function listRepositoryLabels(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<
    RepositoryLabelDto[],
    typeof CommonErrorCode.NotFound | typeof IntegrationErrorCode.NotLinked
  >
> {
  const resolved = await loadRepositoryCredential(ctx, repositoryId);
  if (!resolved.ok) return resolved;

  const labels = await providerFor(resolved.data.provider).listLabels(
    resolved.data.credential,
    resolved.data.externalFullName,
  );
  return ok(labels);
}
