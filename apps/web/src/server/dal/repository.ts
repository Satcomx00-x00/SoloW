import "server-only";
import {
  CommonErrorCode,
  type ConnectRepositoryInput,
  err,
  IntegrationErrorCode,
  type ListRepositoriesInput,
  ok,
  type RepositoryAssigneeDto,
  type RepositoryDto,
  type RepositoryLabelDto,
  type RepositoryListDto,
  type RepositoryMilestoneDto,
  type Result,
  type SeedDefaultLabelsResult,
  type UpdateRepositorySetupInput,
} from "@solow/contracts";
import { decryptForScmSync, integration, issue, repository, secret } from "@solow/db";
import {
  DEFAULT_LABEL_TAXONOMY,
  isProviderInstalled,
  providerWith,
  type ScmCredential,
} from "@solow/scm";
import { and, count, eq, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { type RepositoryEnrichment, repositoryToDto } from "./mappers.js";
import { pageAfter, pageLimit, pageOrder, pageProbe, toPage } from "./page.js";

/**
 * The provider + host + Issue count for a page of Repository rows, one batched pair of queries
 * rather than one query per row (the same reasoning `listProjectRepositories` batches its own
 * counts for) — so a page of a hundred repositories costs three queries, not two hundred and one.
 */
async function enrichmentFor(
  ctx: RequestContext,
  rows: Array<{ id: string; integrationId: string | null }>,
): Promise<Map<string, RepositoryEnrichment>> {
  const map = new Map<string, RepositoryEnrichment>(
    rows.map((r) => [r.id, { provider: null, integrationBaseUrl: null, issueCount: 0 }]),
  );

  const integrationIds = [...new Set(rows.map((r) => r.integrationId).filter((id) => id !== null))];
  if (integrationIds.length > 0) {
    const integrations = await ctx.db
      .select({ id: integration.id, provider: integration.provider, baseUrl: integration.baseUrl })
      .from(integration)
      .where(
        and(eq(integration.workspaceId, ctx.workspaceId), inArray(integration.id, integrationIds)),
      );
    const byIntegration = new Map(integrations.map((i) => [i.id, i]));
    for (const row of rows) {
      const linked = row.integrationId ? byIntegration.get(row.integrationId) : undefined;
      if (!linked) continue;
      const enrichment = map.get(row.id);
      if (enrichment) {
        enrichment.provider = linked.provider;
        enrichment.integrationBaseUrl = linked.baseUrl;
      }
    }
  }

  const repositoryIds = rows.map((r) => r.id);
  if (repositoryIds.length > 0) {
    const counts = await ctx.db
      .select({ repositoryId: issue.repositoryId, n: count() })
      .from(issue)
      .where(
        and(eq(issue.workspaceId, ctx.workspaceId), inArray(issue.repositoryId, repositoryIds)),
      )
      .groupBy(issue.repositoryId);
    for (const { repositoryId, n } of counts) {
      // `inArray` above already excludes it, but the column itself is nullable (an Issue can
      // arrive with no Repository resolved yet), so the type still says so.
      if (repositoryId === null) continue;
      const enrichment = map.get(repositoryId);
      if (enrichment) enrichment.issueCount = n;
    }
  }

  return map;
}

export async function getRepository(
  ctx: RequestContext,
  id: string,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  const enrichment = await enrichmentFor(ctx, [row]);
  return ok(repositoryToDto(row, enrichment.get(row.id)));
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

export async function listRepositories(
  ctx: RequestContext,
  input: ListRepositoriesInput,
): Promise<Result<RepositoryListDto>> {
  const after = pageAfter(input.cursor, repository.createdAt, repository.id);
  const rows = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), ...(after ? [after] : [])))
    .orderBy(...pageOrder(repository.createdAt, repository.id))
    .limit(pageProbe(pageLimit(input.limit)));
  const page = toPage(rows, pageLimit(input.limit), (row) => ({
    createdAt: row.createdAt,
    id: row.id,
  }));
  const enrichment = await enrichmentFor(ctx, page.items);
  return ok({
    items: page.items.map((row) => repositoryToDto(row, enrichment.get(row.id))),
    nextCursor: page.nextCursor,
  });
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
    // The provider is whatever the row holds, not a member of a pair. Whether this build has a
    // driver for it is the caller's question, asked of the registry (F21).
    { provider: string; credential: ScmCredential; externalFullName: string },
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
 * A linked Repository's real labels, for the Issue label picker (issue #15 reversal).
 *
 * Only meaningful for a Repository linked to an Integration whose provider carries labels — a
 * local-path Repository has nothing to fetch, which is what `NotLinked` communicates, and a
 * provider that does not declare the issues capability has no label vocabulary to offer, which
 * is what `CapabilityUnavailable` communicates. Two different reasons for an empty picker, and
 * an Owner can act on exactly one of them.
 */
export async function listRepositoryLabels(
  ctx: RequestContext,
  repositoryId: string,
): Promise<Result<RepositoryLabelDto[], typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const resolved = await loadRepositoryCredential(ctx, repositoryId);
  if (!resolved.ok) return resolved;

  const driver = providerWith(resolved.data.provider, "issues");
  if (!driver) {
    return err(
      isProviderInstalled(resolved.data.provider)
        ? IntegrationErrorCode.CapabilityUnavailable
        : IntegrationErrorCode.ProviderUnavailable,
    );
  }
  const labels = await driver.listLabels(resolved.data.credential, resolved.data.externalFullName);
  return ok(labels);
}

/**
 * The users a provider Issue can be assigned to on this Repository, for the Compose modal's
 * assignee picker (F23a Flow A). Same three refusals and the same `"issues"`-capability driver
 * lookup as `listRepositoryLabels` — an assignee picker and a label picker are the same kind of
 * read against the same connection, differing only in which driver method answers.
 */
export async function listRepositoryAssignees(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<RepositoryAssigneeDto[], typeof CommonErrorCode.NotFound | IntegrationErrorCode>
> {
  const resolved = await loadRepositoryCredential(ctx, repositoryId);
  if (!resolved.ok) return resolved;

  // `issueWrites`, not `issues`: the provider defines the assignable-users list on its *write*
  // capability, because a picker that offers an assignee the token cannot set would lie (the
  // reasoning `IssueWritesCapability.listAssignableUsers` states).
  const driver = providerWith(resolved.data.provider, "issueWrites");
  if (!driver) {
    return err(
      isProviderInstalled(resolved.data.provider)
        ? IntegrationErrorCode.CapabilityUnavailable
        : IntegrationErrorCode.ProviderUnavailable,
    );
  }
  const users = await driver.listAssignableUsers(
    resolved.data.credential,
    resolved.data.externalFullName,
  );
  return ok(users);
}

/**
 * The milestones a provider Issue can be filed under on this Repository, for the Compose modal's
 * milestone picker (F23a Flow A). Twin of `listRepositoryAssignees` above.
 */
export async function listRepositoryMilestones(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<RepositoryMilestoneDto[], typeof CommonErrorCode.NotFound | IntegrationErrorCode>
> {
  const resolved = await loadRepositoryCredential(ctx, repositoryId);
  if (!resolved.ok) return resolved;

  const driver = providerWith(resolved.data.provider, "issueWrites");
  if (!driver) {
    return err(
      isProviderInstalled(resolved.data.provider)
        ? IntegrationErrorCode.CapabilityUnavailable
        : IntegrationErrorCode.ProviderUnavailable,
    );
  }
  const milestones = await driver.listMilestones(
    resolved.data.credential,
    resolved.data.externalFullName,
  );
  return ok(milestones);
}

/**
 * Seed a linked Repository with SoloW's default label taxonomy (user request 2026-08-27) —
 * `type/*`, `prio/*`, `size/*`, `status/*`, `area/*` — for a repository that arrived with none of
 * its own to classify Issues by, most often a fresh GitLab project.
 *
 * Same two refusals as `listRepositoryLabels`, for the same reasons: `NotLinked` for a purely
 * local Repository, `CapabilityUnavailable`/`ProviderUnavailable` for one whose provider (or this
 * build) has no way to create a label at all.
 */
export async function seedDefaultLabels(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<SeedDefaultLabelsResult, typeof CommonErrorCode.NotFound | IntegrationErrorCode>
> {
  const resolved = await loadRepositoryCredential(ctx, repositoryId);
  if (!resolved.ok) return resolved;

  const driver = providerWith(resolved.data.provider, "labelWrites");
  if (!driver) {
    return err(
      isProviderInstalled(resolved.data.provider)
        ? IntegrationErrorCode.CapabilityUnavailable
        : IntegrationErrorCode.ProviderUnavailable,
    );
  }
  const result = await driver.createLabels(
    resolved.data.credential,
    resolved.data.externalFullName,
    DEFAULT_LABEL_TAXONOMY,
  );
  return ok(result);
}
