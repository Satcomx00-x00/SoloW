import "server-only";
import {
  type AdoptProjectResultDto,
  CommonErrorCode,
  err,
  IntegrationErrorCode,
  ok,
  type ProjectFieldValue,
  type Result,
} from "@gatecontrol/contracts";
import {
  integration,
  issue,
  project,
  projectField,
  projectItem,
  projectValue,
  repository,
} from "@gatecontrol/db";
import type { ExternalProjectItem, ScmCredential } from "@gatecontrol/scm";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { driverWith, importIssues, loadCredential } from "./integration.js";
import { getProject, replaceProjectFields, setProjectSyncCursor } from "./project.js";

/**
 * Adopting a provider's project, and refreshing the mirror (spec F23, issue #126).
 *
 * GateControl does not create a project on the provider — it mirrors one that already exists
 * (Decision 0018, Out of scope). So "adopt" is the whole of setup: point at a project the token
 * can see, read its columns, and pull the first page of rows.
 *
 * Every provider call here goes through a driver resolved **by capability**, never by name
 * (Decision 0016). A provider that does not declare `projects` is not offered one.
 */

export interface AvailableProject {
  integrationId: string;
  provider: string;
  externalId: string;
  title: string;
  url: string;
  ownerLogin: string | null;
  /** True when this Workspace already mirrors it — the picker shows it, disabled. */
  adopted: boolean;
}

/**
 * Every project the Workspace's tokens can see, across every integration that has the capability.
 *
 * One integration failing does not hide the others: a token that lost its scope, or a host that
 * is down, costs its own projects and nothing else.
 */
export async function listAvailableProjects(ctx: RequestContext): Promise<AvailableProject[]> {
  const connected = await ctx.db
    .select({ id: integration.id, provider: integration.provider })
    .from(integration)
    .where(eq(integration.workspaceId, ctx.workspaceId));

  const mirrored = await ctx.db
    .select({ integrationId: project.integrationId, providerProjectId: project.providerProjectId })
    .from(project)
    .where(eq(project.workspaceId, ctx.workspaceId));
  const already = new Set(mirrored.map((m) => `${m.integrationId}:${m.providerProjectId}`));

  const found: AvailableProject[] = [];
  for (const row of connected) {
    const driver = driverWith(row.provider, "projects");
    if (!driver.ok) continue;
    const credential = await loadCredential(ctx, row.id);
    if (!credential.ok) continue;
    try {
      for (const p of await driver.data.listProjects(credential.data.credential)) {
        found.push({
          integrationId: row.id,
          provider: row.provider,
          externalId: p.externalId,
          title: p.title,
          url: p.url,
          ownerLogin: p.ownerLogin ?? null,
          adopted: already.has(`${row.id}:${p.externalId}`),
        });
      }
    } catch {}
  }
  return found;
}

/**
 * Start mirroring a project: create the row, read its columns, pull the first page.
 *
 * Idempotent on `(integration, providerProjectId)` — adopting twice is adopting once, which the
 * unique index enforces and this reads back rather than failing.
 */
export async function adoptProject(
  ctx: RequestContext,
  input: { integrationId: string; providerProjectId: string; title: string },
): Promise<Result<AdoptProjectResultDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const credential = await loadCredential(ctx, input.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const driver = driverWith(credential.data.row.provider, "projects");
  if (!driver.ok) return err(driver.error);

  const [existing] = await ctx.db
    .select({ id: project.id })
    .from(project)
    .where(
      and(
        eq(project.workspaceId, ctx.workspaceId),
        eq(project.integrationId, input.integrationId),
        eq(project.providerProjectId, input.providerProjectId),
      ),
    )
    .limit(1);

  // Make the provider able to *hold* a project's structure before reading it. On GitHub this
  // reports nothing to do; on GitLab it creates the scoped labels that stand in for the fields,
  // because without `status::*` there is no Status column to read. Called unconditionally — a
  // branch on which provider this is would be the one thing Decision 0016 forbids.
  let provisioned = { created: [] as string[], existing: [] as string[] };
  try {
    provisioned = await driver.data.provisionProjectStructure(
      credential.data.credential,
      input.providerProjectId,
    );
  } catch {
    // A token without write scope, or a provider that refused: the import continues against
    // whatever structure is already there rather than failing outright. What is missing shows up
    // as a column that is not offered, which is legible; a failed adopt is not.
  }

  let projectId = existing?.id;
  if (!projectId) {
    const [created] = await ctx.db
      .insert(project)
      .values({
        workspaceId: ctx.workspaceId,
        integrationId: input.integrationId,
        providerProjectId: input.providerProjectId,
        title: input.title,
      })
      .returning({ id: project.id });
    projectId = created?.id;
  }
  if (!projectId) return err(CommonErrorCode.NotFound);

  // The whole project, not its first page — and the issues behind it, or every row would be
  // skipped for want of an Issue and the table would be empty until the next poll.
  const issues = await importIntegrationIssues(ctx, input.integrationId);
  const scanned = await scanProject(ctx, projectId);

  const adopted = await getProject(ctx, projectId);
  if (!adopted.ok) return err(CommonErrorCode.NotFound);
  return ok({
    project: adopted.data,
    structure: provisioned,
    issues,
    rows: scanned.ok
      ? scanned.data
      : { items: 0, skipped: 0, drafts: 0, pullRequests: 0, connected: [], pages: 0 },
  });
}

/**
 * Read every page of a project into the mirror.
 *
 * `refreshProject` pulls one page, which is what an incremental poll wants. An import wants the
 * project — a rollup, a filter and a roadmap computed over page one are each wrong in a way that
 * looks right, so an adopt that stopped there would hand the operator a plausible false answer on
 * their first screen.
 *
 * Bounded by `PROJECT_SCAN_PAGE_CAP` rather than trusting the provider's cursor to terminate: a
 * driver bug or a provider that keeps handing back a cursor would otherwise loop for ever inside
 * a request.
 */
export const PROJECT_SCAN_PAGE_CAP = 200;

export async function scanProject(
  ctx: RequestContext,
  projectId: string,
): Promise<Result<ProjectPageReport & { pages: number }, typeof CommonErrorCode.NotFound>> {
  let items = 0;
  let skipped = 0;
  let drafts = 0;
  let pullRequests = 0;
  let pages = 0;
  // A repository is connected once and then found by every later page, so this is a set of what
  // the scan actually created rather than a running total that would count nothing twice.
  const connected = new Set<string>();

  // From the beginning, every time. A scan is not a resumed poll: it is asked for when the mirror
  // is wrong, and resuming from a cursor left mid-walk would re-read the tail while leaving the
  // rows that were already skipped exactly as they are — the state it was called to repair.
  await setProjectSyncCursor(ctx, projectId, null);

  for (; pages < PROJECT_SCAN_PAGE_CAP; pages++) {
    const page = await refreshProject(ctx, projectId);
    if (!page.ok) return err(CommonErrorCode.NotFound);
    items += page.data.items;
    skipped += page.data.skipped;
    drafts += page.data.drafts;
    pullRequests += page.data.pullRequests;
    for (const name of page.data.connected) connected.add(name);

    const [row] = await ctx.db
      .select({ cursor: project.syncCursor })
      .from(project)
      .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, projectId)))
      .limit(1);
    // `refreshProject` clears the cursor when the walk finishes, which is the signal to stop.
    if (!row?.cursor) {
      return ok({
        items,
        skipped,
        drafts,
        pullRequests,
        connected: [...connected],
        pages: pages + 1,
      });
    }
  }
  return ok({ items, skipped, drafts, pullRequests, connected: [...connected], pages });
}

/**
 * Pull every issue from every Repository this Integration owns.
 *
 * The step that turns "the project imported" into "the table has rows in it". A project item
 * points at an issue by the provider's id, and `refreshProject` skips a row whose Issue is not in
 * the database — correctly, because inventing one would create a row whose Tasks and review
 * history lead nowhere. So the issues have to arrive first.
 *
 * Each repository is contained: one that fails costs its own issues, not the import.
 */
export async function importIntegrationIssues(
  ctx: RequestContext,
  integrationId: string,
): Promise<{ imported: number; repositories: number }> {
  const repositories = await ctx.db
    .select({ id: repository.id, externalFullName: repository.externalFullName })
    .from(repository)
    .where(
      and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.integrationId, integrationId)),
    );

  const credential = await loadCredential(ctx, integrationId);
  if (!credential.ok) return { imported: 0, repositories: 0 };
  const driver = driverWith(credential.data.row.provider, "issues");
  if (!driver.ok) return { imported: 0, repositories: 0 };

  let imported = 0;
  let touched = 0;
  for (const repo of repositories) {
    if (!repo.externalFullName) continue;
    try {
      const external = await driver.data.listIssues(
        credential.data.credential,
        repo.externalFullName,
      );
      if (external.length === 0) continue;
      const result = await importIssues(ctx, {
        repositoryId: repo.id,
        externalIds: external.map((i) => i.externalId),
      });
      if (result.ok) imported += result.data.length;
      touched += 1;
    } catch {}
  }
  return { imported, repositories: touched };
}

/**
 * How many repositories one pass may connect on the operator's behalf.
 *
 * Connecting is a write into their Workspace that they did not ask for by name, so it is bounded:
 * a project that touches eighty repositories should not turn one adopt into eighty rows in the
 * Repositories list before anyone has seen the first. What the cap leaves out is *reported*, not
 * dropped silently — the next pass connects the next batch, and the rows waiting on them stay
 * counted as waiting.
 */
export const REPOSITORY_CONNECT_CAP = 25;

/** The key a project row and an Issue agree on: an external id is only unique within its repository. */
function issueKey(repositoryId: string, externalId: string): string {
  return `${repositoryId}:${externalId}`;
}

/**
 * Make the Issues a page of project rows refers to exist — connecting their repositories if that
 * is what it takes.
 *
 * This is the fix for a project that shows columns and no rows. A project is *the* thing that
 * spans repositories, and most of the ones it spans were never connected here; a row pointing at
 * an issue this Workspace has never imported used to be skipped on every pass, for ever, behind a
 * count ("3 still waiting on their issues") that reads like a race and was in fact a permanent
 * mismatch.
 *
 * Two properties this must keep:
 *
 *  - **Nothing is invented.** A repository is created only from what the provider itself reports
 *    through the `repositories` capability — its clone URL above all, which is what an agent will
 *    later clone. A row whose issue arrives without a repository name is left waiting, exactly as
 *    before.
 *  - **Nothing is silent.** Every repository connected here is named in the return value and
 *    surfaces in the adopt report, for the same reason GitLab's created labels are: a write into
 *    the operator's world that they cannot see is the one kind they cannot undo.
 */
async function materialiseIssues(
  ctx: RequestContext,
  input: { integrationId: string; provider: string; credential: ScmCredential },
  items: readonly ExternalProjectItem[],
): Promise<{ connected: string[] }> {
  const carried = items.filter(
    (i): i is ExternalProjectItem & { issue: NonNullable<ExternalProjectItem["issue"]> } =>
      i.issue !== undefined,
  );
  if (carried.length === 0) return { connected: [] };

  const existing = await ctx.db
    .select({ id: repository.id, externalFullName: repository.externalFullName })
    .from(repository)
    .where(eq(repository.workspaceId, ctx.workspaceId));
  // Case-insensitively: GitHub resolves "Acme/Gate" and "acme/gate" to one repository, and
  // matching exactly would connect the same repository twice under two spellings.
  const repoIdByName = new Map(
    existing
      .filter((r) => r.externalFullName)
      .map((r) => [(r.externalFullName as string).toLowerCase(), r.id]),
  );

  const wanted = [...new Set(carried.map((i) => i.issue.repositoryFullName))].filter(
    (name) => !repoIdByName.has(name.toLowerCase()),
  );
  const connected: string[] = [];
  const repos = driverWith(input.provider, "repositories");
  for (const fullName of wanted.slice(0, REPOSITORY_CONNECT_CAP)) {
    if (!repos.ok) break;
    try {
      const found = await repos.data.getRepository(input.credential, fullName);
      // Null is the provider saying it does not exist *or* the token cannot see it — one answer,
      // and neither is worth failing the whole page over. The rows stay counted as waiting.
      if (!found) continue;
      const [row] = await ctx.db
        .insert(repository)
        .values({
          workspaceId: ctx.workspaceId,
          name: found.name,
          // Nothing is cloned here; the orchestrator does that, from exactly this URL.
          source: "remote_url",
          location: found.cloneUrl,
          integrationId: input.integrationId,
          externalFullName: found.fullName,
        })
        .returning({ id: repository.id });
      if (!row) continue;
      repoIdByName.set(found.fullName.toLowerCase(), row.id);
      connected.push(found.fullName);
    } catch {
      // One repository that could not be read costs its own rows, not the page.
    }
  }

  const rows = carried
    .map((item) => ({
      item,
      repositoryId: repoIdByName.get(item.issue.repositoryFullName.toLowerCase()),
    }))
    .filter((r): r is { item: (typeof carried)[number]; repositoryId: string } =>
      Boolean(r.repositoryId),
    );
  if (rows.length > 0) {
    const syncedAt = new Date().toISOString();
    await ctx.db
      .insert(issue)
      .values(
        rows.map(({ item, repositoryId }) => ({
          workspaceId: ctx.workspaceId,
          title: item.issue.title,
          description: item.issue.description,
          source: input.provider,
          integrationId: input.integrationId,
          repositoryId,
          externalId: item.issue.externalId,
          externalNumber: item.issue.number,
          externalUrl: item.issue.url,
          externalState: item.issue.state,
          ...(item.issue.labels ? { labels: item.issue.labels } : {}),
          ...(item.issue.parentExternalId === undefined
            ? {}
            : { externalParentId: item.issue.parentExternalId }),
          syncedAt,
        })),
      )
      /*
       * An Issue already imported is **updated**, not skipped.
       *
       * This used to do nothing on conflict, on the reasoning that a project row carries less
       * than a full issue read. That reasoning has inverted: GitHub's REST issue listing returns
       * neither labels nor assignees nor the sub-issue parent, while the project's GraphQL query
       * asks for all three. Skipping meant a workspace that imported its issues before adopting
       * the project kept them forever without labels and without a hierarchy — 4 of 39 issues
       * labelled, and not one parent, which is exactly the state this was found in.
       *
       * Only what was actually observed is written. `labels` and `externalParentId` are set from
       * the spread above and are absent from the update when the provider did not report them,
       * so a field this pass could not read keeps whatever an earlier one established rather than
       * being blanked by a thinner answer.
       */
      .onConflictDoUpdate({
        target: [issue.repositoryId, issue.externalId],
        set: {
          title: sql`excluded.title`,
          description: sql`excluded.description`,
          externalState: sql`excluded.external_state`,
          externalUrl: sql`excluded.external_url`,
          ...(rows.some(({ item }) => item.issue.labels) ? { labels: sql`excluded.labels` } : {}),
          ...(rows.some(({ item }) => item.issue.parentExternalId !== undefined)
            ? { externalParentId: sql`excluded.external_parent_id` }
            : {}),
          syncedAt,
          updatedAt: syncedAt,
        },
      });
  }

  return { connected };
}

/**
 * Pull one page of the mirror from the provider.
 *
 * Fields first, because a value is meaningless without the column that types it — and because a
 * field the provider dropped has to go before the values that referenced it (`replaceProjectFields`
 * does that).
 *
 * A row whose Issue this Workspace has not imported is **skipped, not invented**. Every row here
 * is an Issue (F23), and a project item pointing at an issue nothing else in the product knows
 * about would be a row whose Tasks, review history and links all lead nowhere. The automatic
 * ingestion (#125) is what makes those issues exist; this waits for it rather than racing it.
 */
export interface ProjectPageReport {
  items: number;
  skipped: number;
  /** Rows the provider has that this table will not: drafts and pull requests, counted so the
   *  difference between the two tables is explainable rather than mysterious. */
  drafts: number;
  pullRequests: number;
  /** Repositories connected on the operator's behalf so their issues could be imported. */
  connected: string[];
}

export async function refreshProject(
  ctx: RequestContext,
  projectId: string,
): Promise<Result<ProjectPageReport, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, projectId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const credential = await loadCredential(ctx, row.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const driver = driverWith(credential.data.row.provider, "projects");
  if (!driver.ok) return err(CommonErrorCode.NotFound);

  const fields = await driver.data.readProjectFields(
    credential.data.credential,
    row.providerProjectId,
  );
  await replaceProjectFields(
    ctx,
    projectId,
    fields.map((f) => ({
      providerFieldId: f.externalId,
      name: f.name,
      type: f.type,
      options: f.options,
      iterations: f.iterations,
      position: f.position,
      readOnly: f.readOnly,
      readOnlyReason: f.readOnlyReason,
    })),
  );

  const stored = await ctx.db
    .select({ id: projectField.id, providerFieldId: projectField.providerFieldId })
    .from(projectField)
    .where(
      and(eq(projectField.workspaceId, ctx.workspaceId), eq(projectField.projectId, projectId)),
    );
  const fieldIdByProvider = new Map(stored.map((f) => [f.providerFieldId, f.id]));

  const page = await driver.data.readProjectItems(
    credential.data.credential,
    row.providerProjectId,
    row.syncCursor,
  );

  // Create what is missing before looking for it — including the repositories the missing issues
  // live in, which is how a project stops being a table of columns with no rows.
  const materialised = await materialiseIssues(
    ctx,
    {
      integrationId: row.integrationId,
      provider: credential.data.row.provider,
      credential: credential.data.credential,
    },
    page.items,
  );

  const externalIds = page.items.map((i) => i.issueExternalId);
  const issues = externalIds.length
    ? await ctx.db
        .select({ id: issue.id, externalId: issue.externalId, repositoryId: issue.repositoryId })
        .from(issue)
        .where(and(eq(issue.workspaceId, ctx.workspaceId), inArray(issue.externalId, externalIds)))
    : [];
  /*
   * Two maps, because an external id is only unique *within its repository*.
   *
   * GitLab's `iid` restarts at 1 in every project, so a Workspace with two repositories has two
   * issues whose external id is "1"; a single map keyed on the id alone would hand a project row
   * whichever of them the query happened to return — a row silently pointing at another
   * repository's issue, which is worse than the empty table it replaced.
   *
   * The repository-qualified key is used whenever the row says which repository it came from. The
   * unqualified one remains for a provider that cannot say, where the old ambiguity is still the
   * best available answer and is at least confined to that case.
   */
  const issueIdByKey = new Map(
    issues
      .filter((i) => i.repositoryId)
      .map((i) => [issueKey(i.repositoryId as string, i.externalId ?? ""), i.id]),
  );
  const issueIdByExternal = new Map(issues.map((i) => [i.externalId ?? "", i.id]));
  const repositoryIdByName = new Map(
    (
      await ctx.db
        .select({ id: repository.id, externalFullName: repository.externalFullName })
        .from(repository)
        .where(eq(repository.workspaceId, ctx.workspaceId))
    )
      .filter((r) => r.externalFullName)
      .map((r) => [(r.externalFullName as string).toLowerCase(), r.id]),
  );

  let written = 0;
  let skipped = 0;
  for (const item of page.items) {
    const repositoryId = item.issue
      ? repositoryIdByName.get(item.issue.repositoryFullName.toLowerCase())
      : undefined;
    const issueId = repositoryId
      ? issueIdByKey.get(issueKey(repositoryId, item.issueExternalId))
      : issueIdByExternal.get(item.issueExternalId);
    if (!issueId) {
      skipped += 1;
      continue;
    }
    const [saved] = await ctx.db
      .insert(projectItem)
      .values({
        workspaceId: ctx.workspaceId,
        projectId,
        issueId,
        providerItemId: item.externalId,
        position: item.position,
        archivedAt: item.archivedAt,
      })
      .onConflictDoUpdate({
        target: [projectItem.projectId, projectItem.providerItemId],
        set: {
          issueId,
          position: item.position,
          archivedAt: item.archivedAt,
          updatedAt: new Date().toISOString(),
        },
      })
      .returning({ id: projectItem.id });
    if (!saved) continue;
    written += 1;

    for (const value of item.values) {
      const fieldId = fieldIdByProvider.get(value.fieldExternalId);
      // A value for a field the project no longer reports has no column to live in.
      if (!fieldId) continue;
      await ctx.db
        .insert(projectValue)
        .values({ workspaceId: ctx.workspaceId, itemId: saved.id, fieldId, value: value.value })
        .onConflictDoUpdate({
          target: [projectValue.itemId, projectValue.fieldId],
          set: { value: value.value, syncedAt: new Date().toISOString() },
        });
    }
  }

  // The cursor is the provider's, stored opaquely. Null means the walk finished, which is also
  // when `syncedAt` becomes true — a half-read project is not a project that agrees.
  await setProjectSyncCursor(
    ctx,
    projectId,
    page.nextCursor,
    page.nextCursor ? undefined : new Date().toISOString(),
  );

  return ok({
    items: written,
    skipped,
    drafts: page.drafts,
    pullRequests: page.pullRequests,
    connected: materialised.connected,
  });
}

/**
 * Write one cell, and store what the provider answers (F23 FR-4, issue #122 AC-3).
 *
 * Three refusals before the network is touched, in order of how badly each would fail:
 *
 *  1. **A field this provider cannot hold.** The table should not have offered the edit; refusing
 *     here is the second line, not the first (F23 FR-5).
 *  2. **A field belonging to another project**, or an item belonging to another — a mismatch that
 *     would otherwise write into whichever row the provider happened to resolve.
 *  3. **Another Workspace's project**, which the scoped read above already refuses.
 *
 * The value written back to the mirror is the provider's, never the caller's. A write that fails
 * leaves the mirror holding the last value the provider confirmed, which is what lets the table
 * put the old value back on screen and say so rather than keeping an optimistic one (NFR-7).
 */
export async function setProjectValue(
  ctx: RequestContext,
  input: {
    projectId: string;
    itemId: string;
    fieldId: string;
    value: ProjectFieldValue | null;
  },
): Promise<
  Result<
    { itemId: string; fieldId: string; value: ProjectFieldValue | null },
    typeof CommonErrorCode.NotFound | IntegrationErrorCode
  >
> {
  const [row] = await ctx.db
    .select()
    .from(project)
    .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const [field] = await ctx.db
    .select()
    .from(projectField)
    .where(
      and(
        eq(projectField.workspaceId, ctx.workspaceId),
        eq(projectField.projectId, input.projectId),
        eq(projectField.id, input.fieldId),
      ),
    )
    .limit(1);
  if (!field) return err(CommonErrorCode.NotFound);
  if (field.readOnly) return err(IntegrationErrorCode.CapabilityUnavailable);

  const [item] = await ctx.db
    .select()
    .from(projectItem)
    .where(
      and(
        eq(projectItem.workspaceId, ctx.workspaceId),
        eq(projectItem.projectId, input.projectId),
        eq(projectItem.id, input.itemId),
      ),
    )
    .limit(1);
  if (!item) return err(CommonErrorCode.NotFound);

  const credential = await loadCredential(ctx, row.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const driver = driverWith(credential.data.row.provider, "projects");
  if (!driver.ok) return err(driver.error);

  const stored = await driver.data.writeProjectFieldValue(credential.data.credential, {
    projectExternalId: row.providerProjectId,
    itemExternalId: item.providerItemId,
    fieldExternalId: field.providerFieldId,
    value: input.value,
  });

  await ctx.db
    .insert(projectValue)
    .values({
      workspaceId: ctx.workspaceId,
      itemId: item.id,
      fieldId: field.id,
      value: stored.value,
    })
    .onConflictDoUpdate({
      target: [projectValue.itemId, projectValue.fieldId],
      set: { value: stored.value, syncedAt: new Date().toISOString() },
    });

  return ok({ itemId: item.id, fieldId: field.id, value: stored.value });
}
