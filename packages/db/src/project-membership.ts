import { and, eq, max } from "drizzle-orm";
import type { Db } from "./index.js";
import { issue, projectItem, projectRepository } from "./schema.js";

/**
 * Keep a local Project's membership current as an Issue arrives (spec F23, user request
 * 2026-08-27).
 *
 * A **mirrored** Project's rows come from walking a provider's board; a **local** one has no
 * board to walk, so its membership is a standing decision — every Issue in a Repository an Owner
 * registered under it (`projectRepository`) belongs to the Project. This is what keeps that
 * decision true as new Issues show up, from either of the two places an Issue is created:
 *
 *  - a **local** Issue, made directly against a Repository (`apps/web/src/server/dal/issue.ts`);
 *  - an **imported** one, arriving through #125's automatic per-Repository ingestion
 *    (`apps/orchestrator/src/sync/issues.ts`).
 *
 * Both call this, which is why it lives in `@solow/db` rather than in either app: it is
 * the one package both already depend on, and duplicating the join in two places is how the two
 * would quietly stop agreeing about what "a member of this Project" means.
 *
 * Idempotent and cheap to call for every Issue unconditionally — no caller has to first ask
 * "does this Repository feed a local Project": a Repository feeding none does zero writes, and
 * one already holding this Issue does zero more (`onConflictDoNothing` on the same unique pair
 * the Owner's own attach uses).
 */
export async function attachIssueToLocalProjects(
  db: Db,
  workspaceId: string,
  input: { issueId: string; repositoryId: string },
): Promise<void> {
  const memberships = await db
    .select({ projectId: projectRepository.projectId })
    .from(projectRepository)
    .where(
      and(
        eq(projectRepository.workspaceId, workspaceId),
        eq(projectRepository.repositoryId, input.repositoryId),
      ),
    );
  if (memberships.length === 0) return;

  for (const { projectId } of memberships) {
    await addIssueToProject(db, workspaceId, projectId, input.issueId);
  }
}

/**
 * One Issue, one `project_item` row — the unit both the backfill (attaching a whole Repository)
 * and the per-arrival hook above build on, so there is exactly one place that decides what a new
 * row looks like.
 *
 * `providerItemId` is the Issue's own id rather than anything from a provider: a local Project's
 * items were never assigned one, and an Issue's id is already unique per Project by construction
 * — the same Issue cannot be attached to the same Project twice, which is the whole of what that
 * column exists to guarantee (see `project_item`'s unique index).
 *
 * Position is appended, not computed from anything meaningful: a local Project has no provider
 * ordering to preserve, and "the order Issues arrived in" is the one a newly-registered
 * Repository's backfill and a freshly-created Issue can both honestly claim.
 */
export async function addIssueToProject(
  db: Db,
  workspaceId: string,
  projectId: string,
  issueId: string,
): Promise<void> {
  const [row] = await db
    .select({ next: max(projectItem.position) })
    .from(projectItem)
    .where(and(eq(projectItem.workspaceId, workspaceId), eq(projectItem.projectId, projectId)));
  const position = (row?.next ?? -1) + 1;

  await db
    .insert(projectItem)
    .values({ workspaceId, projectId, issueId, providerItemId: issueId, position })
    .onConflictDoNothing({ target: [projectItem.projectId, projectItem.providerItemId] });
}

/**
 * Every Issue currently in a Repository, attached to a local Project in one pass — the backfill
 * half of registering a Repository (the per-arrival half is `attachIssueToLocalProjects`).
 *
 * Sequential rather than batched: a Repository's Issue count is small enough that the simplicity
 * of one row at a time (and one obvious position order — creation order, ascending) outweighs a
 * bulk insert's speed, and `addIssueToProject`'s own `onConflictDoNothing` makes a retried call
 * safe to just run again rather than something that has to track where it stopped.
 */
export async function backfillProjectFromRepository(
  db: Db,
  workspaceId: string,
  projectId: string,
  repositoryId: string,
): Promise<number> {
  const issues = await db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.workspaceId, workspaceId), eq(issue.repositoryId, repositoryId)))
    .orderBy(issue.createdAt);
  for (const row of issues) await addIssueToProject(db, workspaceId, projectId, row.id);
  return issues.length;
}
