import "server-only";
import {
  type AttachProjectRepositoryInput,
  CommonErrorCode,
  type CreateLocalProjectInput,
  type DetachProjectRepositoryInput,
  err,
  LOCAL_PROJECT_SOURCE,
  ok,
  type ProjectDto,
  ProjectErrorCode,
  type ProjectIdInput,
  type ProjectRepositoryDto,
  type ProjectRepositoryListDto,
  type Result,
} from "@solow/contracts";
import {
  backfillProjectFromRepository,
  issue,
  project,
  projectItem,
  projectRepository,
  projectValue,
  repository,
} from "@solow/db";
import { and, count, eq, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";

/**
 * Local Projects (spec F23, Decision 0018's reversal, user request 2026-08-27).
 *
 * A mirrored Project's membership is walked from a provider's board; a local one has none to
 * walk, so membership is a standing decision made here — an Owner registers a Repository under
 * it (`project_repository`), and every Issue that Repository holds, now and later, is a member
 * (`@solow/db`'s `attachIssueToLocalProjects`/`backfillProjectFromRepository`). Nothing in
 * this file writes to a provider; there is none to write to.
 *
 * Workspace-scoped on every read and every write, like the rest of the DAL (Principle V).
 */

/**
 * Create a Project SoloW holds outright.
 *
 * `syncedAt` is set at creation, not left null: a local Project has no provider to disagree
 * with, so "never synced" would misdescribe it forever (see `project.syncedAt`'s own comment).
 */
export async function createLocalProject(
  ctx: RequestContext,
  input: CreateLocalProjectInput,
): Promise<Result<ProjectDto>> {
  const [row] = await ctx.db
    .insert(project)
    .values({
      workspaceId: ctx.workspaceId,
      title: input.title,
      integrationId: null,
      providerProjectId: null,
      syncedAt: new Date().toISOString(),
    })
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);

  return ok({
    id: row.id,
    integrationId: null,
    providerProjectId: null,
    source: LOCAL_PROJECT_SOURCE,
    title: row.title,
    syncedAt: row.syncedAt,
    itemCount: 0,
    fields: [],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

/**
 * The Repositories registered under a Project, and how many Issues each currently contributes.
 *
 * Reading is harmless on a mirrored Project — its `project_repository` table is simply always
 * empty — so this refuses only on a missing Project, not a mirrored one. The refusal that matters
 * lives in `attachProjectRepository`/`detachProjectRepository`, where a mutation actually would.
 */
export async function listProjectRepositories(
  ctx: RequestContext,
  input: ProjectIdInput,
): Promise<Result<ProjectRepositoryListDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select({ id: project.id })
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const attached = await ctx.db
    .select({
      id: projectRepository.id,
      repositoryId: projectRepository.repositoryId,
      repositoryName: repository.name,
      createdAt: projectRepository.createdAt,
    })
    .from(projectRepository)
    .innerJoin(
      repository,
      and(
        eq(repository.id, projectRepository.repositoryId),
        eq(repository.workspaceId, ctx.workspaceId),
      ),
    )
    .where(
      and(
        eq(projectRepository.workspaceId, ctx.workspaceId),
        eq(projectRepository.projectId, input.projectId),
      ),
    );
  if (attached.length === 0) return ok([]);

  // One grouped query for every attached Repository, not one per row — the same reasoning
  // `listProjects`'s own item counts are batched for.
  const counts = new Map(
    (
      await ctx.db
        .select({ repositoryId: issue.repositoryId, n: count() })
        .from(projectItem)
        .innerJoin(
          issue,
          and(eq(issue.id, projectItem.issueId), eq(issue.workspaceId, ctx.workspaceId)),
        )
        .where(
          and(
            eq(projectItem.workspaceId, ctx.workspaceId),
            eq(projectItem.projectId, input.projectId),
            inArray(
              issue.repositoryId,
              attached.map((a) => a.repositoryId),
            ),
          ),
        )
        .groupBy(issue.repositoryId)
    ).map((r) => [r.repositoryId, r.n]),
  );

  return ok(
    attached.map((a) => ({
      id: a.id,
      repositoryId: a.repositoryId,
      repositoryName: a.repositoryName,
      issueCount: counts.get(a.repositoryId) ?? 0,
      // `project_repository` has no `updated_at` column — a membership is created and later
      // deleted, never edited, so `createdAt` is the whole of its history and the honest answer
      // for both halves of `timestampsSchema`.
      createdAt: a.createdAt,
      updatedAt: a.createdAt,
    })),
  );
}

/**
 * Register a Repository under a local Project, and backfill every Issue it already holds.
 *
 * Refused on a mirrored Project (`NotLocal`) — its membership is the provider's board, walked by
 * a sync, and this table has no say in it. Refused on a repeat pair (`RepositoryAlreadyAttached`)
 * rather than left to the unique index: a caught constraint violation is not this codebase's
 * error-handling style.
 */
export async function attachProjectRepository(
  ctx: RequestContext,
  input: AttachProjectRepositoryInput,
): Promise<Result<ProjectRepositoryDto, typeof CommonErrorCode.NotFound | ProjectErrorCode>> {
  const [projectRow] = await ctx.db
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
    .limit(1);
  if (!projectRow) return err(CommonErrorCode.NotFound);
  if (projectRow.integrationId !== null) return err(ProjectErrorCode.NotLocal);

  const [repositoryRow] = await ctx.db
    .select()
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, input.repositoryId)))
    .limit(1);
  if (!repositoryRow) return err(CommonErrorCode.NotFound);

  const [existing] = await ctx.db
    .select({ id: projectRepository.id })
    .from(projectRepository)
    .where(
      and(
        eq(projectRepository.workspaceId, ctx.workspaceId),
        eq(projectRepository.projectId, input.projectId),
        eq(projectRepository.repositoryId, input.repositoryId),
      ),
    )
    .limit(1);
  if (existing) return err(ProjectErrorCode.RepositoryAlreadyAttached);

  const [row] = await ctx.db
    .insert(projectRepository)
    .values({
      workspaceId: ctx.workspaceId,
      projectId: input.projectId,
      repositoryId: input.repositoryId,
    })
    .returning();
  if (!row) return err(CommonErrorCode.NotFound);

  const issueCount = await backfillProjectFromRepository(
    ctx.db,
    ctx.workspaceId,
    input.projectId,
    input.repositoryId,
  );

  return ok({
    id: row.id,
    repositoryId: row.repositoryId,
    repositoryName: repositoryRow.name,
    issueCount,
    createdAt: row.createdAt,
    updatedAt: row.createdAt, // see the comment in listProjectRepositories.
  });
}

/**
 * Drop a Repository from a local Project, and every row it put there.
 *
 * There are no `onDelete` cascades anywhere in this schema, so the cleanup is explicit and
 * ordered: values before items, items before the membership itself. Step 1 is a no-op today — a
 * local Project has zero `project_field` rows — but is written correctly rather than skipped:
 * nothing stops a field being added to a local Project later, and a detach that silently left
 * orphaned `project_value` rows behind would be the kind of bug that only shows up after that.
 */
export async function detachProjectRepository(
  ctx: RequestContext,
  input: DetachProjectRepositoryInput,
): Promise<Result<{ projectId: string; repositoryId: string }, typeof CommonErrorCode.NotFound>> {
  const [membership] = await ctx.db
    .select({ id: projectRepository.id })
    .from(projectRepository)
    .where(
      and(
        eq(projectRepository.workspaceId, ctx.workspaceId),
        eq(projectRepository.projectId, input.projectId),
        eq(projectRepository.repositoryId, input.repositoryId),
      ),
    )
    .limit(1);
  if (!membership) return err(CommonErrorCode.NotFound);

  const memberIssueIds = ctx.db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.repositoryId, input.repositoryId)));
  const memberItemIds = ctx.db
    .select({ id: projectItem.id })
    .from(projectItem)
    .where(
      and(
        eq(projectItem.workspaceId, ctx.workspaceId),
        eq(projectItem.projectId, input.projectId),
        inArray(projectItem.issueId, memberIssueIds),
      ),
    );

  await ctx.db
    .delete(projectValue)
    .where(
      and(
        eq(projectValue.workspaceId, ctx.workspaceId),
        inArray(projectValue.itemId, memberItemIds),
      ),
    );
  await ctx.db
    .delete(projectItem)
    .where(
      and(
        eq(projectItem.workspaceId, ctx.workspaceId),
        eq(projectItem.projectId, input.projectId),
        inArray(projectItem.issueId, memberIssueIds),
      ),
    );
  await ctx.db.delete(projectRepository).where(eq(projectRepository.id, membership.id));

  return ok({ projectId: input.projectId, repositoryId: input.repositoryId });
}
