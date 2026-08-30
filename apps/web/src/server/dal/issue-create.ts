import "server-only";
import {
  CommonErrorCode,
  type CreatedEpicDto,
  type CreatedProviderIssueDto,
  type CreateEpicInput,
  type CreateProviderIssueInput,
  type ExternalEpicDto,
  type ExternalGroupDto,
  err,
  IntegrationErrorCode,
  type ListEpicsInput,
  type ListGroupsInput,
  ok,
  type Result,
} from "@solow/contracts";
import {
  addIssueToProject,
  attachIssueToLocalProjects,
  issue,
  project,
  repository,
} from "@solow/db";
import type { DriverWith, EpicSeed, IssueSeed, ScmCredential } from "@solow/scm";
import { providerManifest } from "@solow/scm";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { driverWith, loadCredential, mirrorExternalIssues } from "./integration.js";

/**
 * Originating an Issue or an Epic **on the provider** (spec F23a Part 1).
 *
 * The counterpart to `issue-write.ts`, and it keeps that file's one rule: the answer is built
 * from what the provider stored, never from what was typed (F23 NFR-7). A create is the case
 * where that matters most — a provider assigns the number, may normalise the title, and silently
 * drops an assignee or a label it will not accept, so a caller handed back its own input would be
 * shown a row that does not exist anywhere but on its screen.
 *
 * Distinct from `issue.ts`'s `createIssue`, which makes a **local** Issue that has never touched
 * a provider. Nothing here invents a row either: the Issue that appears in the table is the
 * provider's issue, mirrored through the same `mirrorExternalIssues` the import path uses.
 */

/** A Repository in this Workspace that has a provider behind it to create on. */
async function loadCreatableRepository(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<
    { id: string; integrationId: string; externalFullName: string },
    typeof CommonErrorCode.NotFound | IntegrationErrorCode
  >
> {
  const [repo] = await ctx.db
    .select()
    .from(repository)
    // Tenancy on the id the client sent, before it is used for anything at all (Principle V) —
    // a Repository id from another Workspace must read as absent, never as a target.
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, repositoryId)))
    .limit(1);
  if (!repo) return err(CommonErrorCode.NotFound);
  // A Repository added as a local path has no provider to create on. Not a fault the operator can
  // fix from this dialog, and not a throw either: the "＋ New" entry should have been disabled,
  // and this is the second line (the same two-layer refusal `updateExternalIssue` uses).
  if (!repo.integrationId || !repo.externalFullName) return err(IntegrationErrorCode.NotLinked);
  return ok({
    id: repo.id,
    integrationId: repo.integrationId,
    externalFullName: repo.externalFullName,
  });
}

/**
 * The `issueCreates` driver behind an Integration this Workspace owns.
 *
 * `loadCredential` is what enforces the tenancy — it selects the Integration by
 * `(workspaceId, id)` — so an `integrationId` naming somebody else's connection is a NotFound
 * here rather than a credential this Workspace was never entitled to decrypt.
 */
async function issueCreatesDriver(
  ctx: RequestContext,
  integrationId: string,
): Promise<
  Result<
    { provider: string; credential: ScmCredential; driver: DriverWith<"issueCreates"> },
    typeof CommonErrorCode.NotFound | IntegrationErrorCode
  >
> {
  const credential = await loadCredential(ctx, integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const provider = credential.data.row.provider;
  const driver = driverWith(provider, "issueCreates");
  if (!driver.ok) return err(driver.error);
  return ok({ provider, credential: credential.data.credential, driver: driver.data });
}

/**
 * The same driver, refused up front when the provider has no epics.
 *
 * Asked of the manifest, never of the provider's name (Decision 0016). GitHub declares
 * `issueCreates.epics: false` and its `createEpic`/`listGroups`/`listEpics` throw a descriptive
 * `ScmProviderError` — which is the right thing for a driver to do and the wrong thing for a
 * procedure to propagate, since an unhandled throw reaches the client as an opaque 500 where the
 * honest answer is a typed "this connection cannot do that". So the flag is checked before the
 * call, and a genuine provider rejection (403, a group the token cannot write to) is still left
 * to surface with its own message, which is what the compose modal renders inline.
 */
async function epicDriver(
  ctx: RequestContext,
  integrationId: string,
): Promise<
  Result<
    { provider: string; credential: ScmCredential; driver: DriverWith<"issueCreates"> },
    typeof CommonErrorCode.NotFound | IntegrationErrorCode
  >
> {
  const resolved = await issueCreatesDriver(ctx, integrationId);
  if (!resolved.ok) return resolved;
  if (!providerManifest(resolved.data.provider)?.issueCreates?.epics) {
    return err(IntegrationErrorCode.CapabilityUnavailable);
  }
  return resolved;
}

/**
 * Create an Issue on the provider, then mirror what it stored (spec F23a Flow A, Actions 3–4).
 *
 * The returned DTO is assembled from the `ExternalIssue` the driver answered with — the number,
 * the URL and the title are the provider's, and `issueId` is the row that mirror produced. Not
 * one field of it comes from `input`, which is F23 NFR-7 stated in code: a GitLab title stripped
 * of a leading `#`, or a GitHub issue that landed as number 41 because someone else was creating
 * one at the same moment, must show as what happened rather than as what was asked for.
 */
export async function createProviderIssue(
  ctx: RequestContext,
  input: CreateProviderIssueInput,
): Promise<
  Result<CreatedProviderIssueDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>
> {
  const repo = await loadCreatableRepository(ctx, input.repositoryId);
  if (!repo.ok) return repo;

  // Checked before the provider is touched: a foreign `projectId` must not cost a real issue on
  // somebody's GitHub before it is refused (Principle V — every client-sent id, every time).
  if (input.projectId !== undefined) {
    const [row] = await ctx.db
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
      .limit(1);
    if (!row) return err(CommonErrorCode.NotFound);
  }

  const resolved = await issueCreatesDriver(ctx, repo.data.integrationId);
  if (!resolved.ok) return resolved;

  // Absent stays absent. An omitted field means "let the provider decide" — GitLab's default
  // assignee rules, GitHub's empty label set — where an explicitly empty array means "none", and
  // collapsing the two here would send a decision the caller never made.
  const seed: IssueSeed = { title: input.title };
  if (input.description !== undefined) seed.description = input.description;
  if (input.assignees !== undefined) seed.assignees = input.assignees;
  if (input.labels !== undefined) seed.labels = input.labels;
  if (input.milestone !== undefined) seed.milestone = input.milestone;
  if (input.parentEpicId !== undefined) seed.parentEpicId = input.parentEpicId;
  // Same absent-stays-absent rule as the fields above. Whether the *client* should have offered
  // one at all is the manifest's answer (`issueCreates`), asked in the compose form; a value that
  // arrives for a provider that cannot hold it is the driver's to refuse, not this layer's to
  // second-guess — the same division `parentEpicId` has always had.
  if (input.dueDate !== undefined) seed.dueDate = input.dueDate;
  if (input.weight !== undefined) seed.weight = input.weight;
  if (input.confidential !== undefined) seed.confidential = input.confidential;
  if (input.timeEstimate !== undefined) seed.timeEstimate = input.timeEstimate;
  if (input.links !== undefined) seed.links = input.links;

  const created = await resolved.data.driver.createIssue(
    resolved.data.credential,
    repo.data.externalFullName,
    seed,
  );

  await mirrorExternalIssues(
    ctx,
    {
      provider: resolved.data.provider,
      integrationId: repo.data.integrationId,
      repositoryId: repo.data.id,
    },
    [created],
  );

  const [mirrored] = await ctx.db
    .select({ id: issue.id })
    .from(issue)
    .where(and(eq(issue.repositoryId, repo.data.id), eq(issue.externalId, created.externalId)))
    .limit(1);
  // The mirror is an insert this function just made; no row means the provider answered with an
  // `externalId` it also gave to something else, which is a state to refuse rather than guess at.
  if (!mirrored) return err(CommonErrorCode.NotFound);

  // Every local Project this Repository is registered under gains the row immediately — F23's
  // "nothing is imported by hand", the same call `issue.createIssue` makes for a local Issue.
  await attachIssueToLocalProjects(ctx.db, ctx.workspaceId, {
    issueId: mirrored.id,
    repositoryId: repo.data.id,
  });
  // ...and the Project the create was started from gains it whether or not that registration
  // exists: the operator pressed "＋ New" on *this* table, and a row that lands in every Project
  // but the one they were looking at is the outcome Action 5 exists to prevent. Idempotent, so
  // the attach above having already covered it is a no-op rather than a duplicate.
  if (input.projectId !== undefined) {
    await addIssueToProject(ctx.db, ctx.workspaceId, input.projectId, mirrored.id);
  }

  return ok({
    issueId: mirrored.id,
    externalNumber: created.number,
    externalUrl: created.url,
    title: created.title,
  });
}

/**
 * Create an Epic in a group (spec F23a Flow B, Actions 3–4).
 *
 * Nothing is written to the `project` table here, deliberately. An epic is a parent planning
 * item, and the rows under it re-nest through `external_parent_id` on the next project sync —
 * which is the only pass that can see which issues the provider now considers its children.
 * Synthesising a row for it would be importing by hand the one thing F23 says is never imported
 * by hand, and would leave a row the next sync has to reconcile against the real one.
 *
 * `input.projectId` is therefore verified and otherwise unused: it names the table the caller was
 * looking at, and refusing a foreign id costs nothing where trusting one would be a hole
 * (Principle V).
 */
export async function createEpic(
  ctx: RequestContext,
  input: CreateEpicInput,
): Promise<Result<CreatedEpicDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  if (input.projectId !== undefined) {
    const [row] = await ctx.db
      .select({ id: project.id })
      .from(project)
      .where(and(eq(project.workspaceId, ctx.workspaceId), eq(project.id, input.projectId)))
      .limit(1);
    if (!row) return err(CommonErrorCode.NotFound);
  }

  const resolved = await epicDriver(ctx, input.integrationId);
  if (!resolved.ok) return resolved;

  const seed: EpicSeed = { title: input.title };
  if (input.description !== undefined) seed.description = input.description;
  if (input.labels !== undefined) seed.labels = input.labels;
  // Three states, carried through rather than collapsed: absent leaves the provider's computed
  // dates alone, null clears a fixed one, a string fixes it (`EpicSeed`'s own rule).
  if (input.startDate !== undefined) seed.startDate = input.startDate;
  if (input.dueDate !== undefined) seed.dueDate = input.dueDate;

  const created = await resolved.data.driver.createEpic(
    resolved.data.credential,
    input.groupRef,
    seed,
  );
  // The provider's own row, field for field — `createdEpicDto` is `externalEpicDto`, which is
  // `ExternalEpic`, so there is nothing to translate and nothing of the input to leak in.
  return ok({
    externalId: created.externalId,
    iid: created.iid,
    title: created.title,
    url: created.url,
    state: created.state,
    startDate: created.startDate,
    dueDate: created.dueDate,
    groupRef: created.groupRef,
  });
}

/**
 * The groups this connection can actually create an epic in — the "Where" modal's picker.
 *
 * `integrationId` is stamped onto every row from the input rather than read back off the
 * provider: the driver answers about a connection it was handed and has no idea which row in this
 * Workspace that connection is, and the picker needs to send it back with the create.
 */
export async function listCreatableGroups(
  ctx: RequestContext,
  input: ListGroupsInput,
): Promise<Result<ExternalGroupDto[], typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const resolved = await epicDriver(ctx, input.integrationId);
  if (!resolved.ok) return resolved;

  const groups = await resolved.data.driver.listGroups(resolved.data.credential);
  return ok(
    groups.map((g) => ({
      integrationId: input.integrationId,
      externalId: g.externalId,
      fullPath: g.fullPath,
      name: g.name,
      url: g.url,
    })),
  );
}

/** The epics already in a group — the "parent epic" picker on the issue compose form. */
export async function listGroupEpics(
  ctx: RequestContext,
  input: ListEpicsInput,
): Promise<Result<ExternalEpicDto[], typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const resolved = await epicDriver(ctx, input.integrationId);
  if (!resolved.ok) return resolved;

  const epics = await resolved.data.driver.listEpics(resolved.data.credential, input.groupRef);
  return ok(
    epics.map((e) => ({
      externalId: e.externalId,
      iid: e.iid,
      title: e.title,
      url: e.url,
      state: e.state,
      startDate: e.startDate,
      dueDate: e.dueDate,
      groupRef: e.groupRef,
    })),
  );
}
