import "server-only";
import {
  type ChangeRequestDto,
  CommonErrorCode,
  type ConnectIntegrationInput,
  type DeleteIntegrationInput,
  type DeleteIntegrationResultDto,
  type ExternalIssuePreviewDto,
  type ExternalRepositoryDto,
  err,
  type ImportIssuesInput,
  type ImportRepositoryInput,
  type IntegrationDto,
  IntegrationErrorCode,
  type IssueDto,
  type ListExternalIssuesInput,
  type ListExternalRepositoriesInput,
  ok,
  type RepositoryBranchDto,
  type RepositoryDto,
  type Result,
  type SyncRepositorySignalsInput,
} from "@gatecontrol/contracts";
import {
  changeRequest,
  decryptForScmSync,
  integration,
  issue,
  repository,
  repositoryBranch,
  secret,
} from "@gatecontrol/db";
import { providerFor, type ScmCredential } from "@gatecontrol/scm";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import {
  changeRequestToDto,
  integrationToDto,
  issueToDto,
  repositoryBranchToDto,
  repositoryToDto,
} from "./mappers.js";

/**
 * SCM integrations (issue #15). Every function here is workspace-scoped (Principle V) and the
 * credential never leaves this module as plaintext — `loadCredential` decrypts it, the caller
 * passes it straight to `@gatecontrol/scm`, and it goes out of scope when the function returns.
 */

async function loadCredential(
  ctx: RequestContext,
  integrationId: string,
): Promise<
  Result<
    { row: typeof integration.$inferSelect; credential: ScmCredential },
    typeof CommonErrorCode.NotFound
  >
> {
  const [row] = await ctx.db
    .select()
    .from(integration)
    .where(and(eq(integration.workspaceId, ctx.workspaceId), eq(integration.id, integrationId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const [secretRow] = await ctx.db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, row.secretId)))
    .limit(1);
  if (!secretRow) return err(CommonErrorCode.NotFound);

  return ok({
    row,
    credential: { token: decryptForScmSync(secretRow.ciphertext), baseUrl: row.baseUrl },
  });
}

async function loadLinkedRepository(
  ctx: RequestContext,
  repositoryId: string,
): Promise<
  Result<
    typeof repository.$inferSelect & { integrationId: string; externalFullName: string },
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
  return ok({
    ...repo,
    integrationId: repo.integrationId,
    externalFullName: repo.externalFullName,
  });
}

/** Connect an Integration — verifies the PAT actually authenticates before storing it as connected (AC-1). */
export async function connectIntegration(
  ctx: RequestContext,
  input: ConnectIntegrationInput,
): Promise<
  Result<
    IntegrationDto,
    | typeof CommonErrorCode.NotFound
    | typeof CommonErrorCode.ValidationFailed
    | typeof IntegrationErrorCode.AuthenticationFailed
  >
> {
  const [secretRow] = await ctx.db
    .select({ ciphertext: secret.ciphertext })
    .from(secret)
    .where(and(eq(secret.workspaceId, ctx.workspaceId), eq(secret.id, input.secretId)))
    .limit(1);
  if (!secretRow) return err(CommonErrorCode.NotFound);

  const credential: ScmCredential = {
    token: decryptForScmSync(secretRow.ciphertext),
    baseUrl: input.baseUrl ?? null,
  };
  const auth = await providerFor(input.provider).authenticate(credential);
  if (!auth.ok) return err(IntegrationErrorCode.AuthenticationFailed);

  const [row] = await ctx.db
    .insert(integration)
    .values({
      workspaceId: ctx.workspaceId,
      provider: input.provider,
      secretId: input.secretId,
      baseUrl: input.baseUrl ?? null,
      writeBackEnabled: input.writeBackEnabled,
    })
    .returning();
  return row ? ok(integrationToDto(row)) : err(CommonErrorCode.ValidationFailed);
}

/**
 * Disconnect an Integration and drop what only existed because of it (spec F12).
 *
 * Three different answers for three different kinds of row, and the differences are the design:
 *
 * - Branches and change requests are a *cache* of the provider's state. With the credential gone
 *   they can never be refreshed, so leaving them would leave the UI showing data nothing can
 *   correct. They go.
 * - Issues are *work*: `task.issue_id` is NOT NULL, so deleting an imported Issue would take its
 *   Tasks with it. They stay, with the link to this Integration cleared.
 * - Repositories are configuration the user created before any of this. They are unlinked, never
 *   deleted.
 *
 * The statement order is the order the foreign keys allow — `change_request.integration_id` is
 * NOT NULL, so those rows cannot outlive the integration row — and it is also the order that is
 * safe to retry: every step before the final delete is idempotent, so a failure part-way through
 * leaves a state a second call completes rather than a half-deleted integration.
 */
export async function deleteIntegration(
  ctx: RequestContext,
  input: DeleteIntegrationInput,
): Promise<Result<DeleteIntegrationResultDto, typeof CommonErrorCode.NotFound>> {
  const [row] = await ctx.db
    .select({ id: integration.id })
    .from(integration)
    .where(and(eq(integration.workspaceId, ctx.workspaceId), eq(integration.id, input.id)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);

  const linkedRepos = await ctx.db
    .select({ id: repository.id })
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.integrationId, row.id)));
  const repoIds = linkedRepos.map((r) => r.id);

  const changeRequestsDeleted = await ctx.db
    .delete(changeRequest)
    .where(
      and(eq(changeRequest.workspaceId, ctx.workspaceId), eq(changeRequest.integrationId, row.id)),
    )
    .returning({ id: changeRequest.id });

  // Branches carry no integration id of their own — they are reachable only through the
  // Repositories this Integration linked, which is why they are cleared by repository id here.
  const branchesDeleted =
    repoIds.length === 0
      ? []
      : await ctx.db
          .delete(repositoryBranch)
          .where(
            and(
              eq(repositoryBranch.workspaceId, ctx.workspaceId),
              inArray(repositoryBranch.repositoryId, repoIds),
            ),
          )
          .returning({ id: repositoryBranch.id });

  const issuesDetached = await ctx.db
    .update(issue)
    .set({ integrationId: null, updatedAt: new Date().toISOString() })
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.integrationId, row.id)))
    .returning({ id: issue.id });

  const repositoriesUnlinked = await ctx.db
    .update(repository)
    .set({ integrationId: null, externalFullName: null, updatedAt: new Date().toISOString() })
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.integrationId, row.id)))
    .returning({ id: repository.id });

  await ctx.db
    .delete(integration)
    .where(and(eq(integration.workspaceId, ctx.workspaceId), eq(integration.id, row.id)));

  return ok({
    id: row.id,
    repositoriesUnlinked: repositoriesUnlinked.length,
    branchesDeleted: branchesDeleted.length,
    changeRequestsDeleted: changeRequestsDeleted.length,
    issuesDetached: issuesDetached.length,
  });
}

export async function listIntegrations(ctx: RequestContext): Promise<Result<IntegrationDto[]>> {
  const rows = await ctx.db
    .select()
    .from(integration)
    .where(eq(integration.workspaceId, ctx.workspaceId))
    .orderBy(desc(integration.createdAt));
  return ok(rows.map(integrationToDto));
}

/**
 * The repositories a connected Integration's token can actually see, for the link picker.
 *
 * Flags the ones already linked rather than hiding them, so a user looking for a repository they
 * linked last week finds it marked instead of concluding the list is broken. Read-only: this
 * never writes, so it stays safe to call on every render of the form.
 */
export async function listExternalRepositories(
  ctx: RequestContext,
  input: ListExternalRepositoriesInput,
): Promise<Result<ExternalRepositoryDto[], typeof CommonErrorCode.NotFound>> {
  const cred = await loadCredential(ctx, input.integrationId);
  if (!cred.ok) return err(CommonErrorCode.NotFound);

  const external = await providerFor(cred.data.row.provider).listRepositories(cred.data.credential);

  // Scoped to this Integration: two Integrations can legitimately expose the same full name
  // (a github.com account and a GitHub Enterprise host both having "acme/gate"), and marking
  // one as imported because of the other would be wrong.
  const imported = await ctx.db
    .select({ externalFullName: repository.externalFullName })
    .from(repository)
    .where(
      and(
        eq(repository.workspaceId, ctx.workspaceId),
        eq(repository.integrationId, input.integrationId),
      ),
    );
  const importedNames = new Set(imported.map((r) => r.externalFullName));

  return ok(external.map((r) => ({ ...r, alreadyImported: importedNames.has(r.fullName) })));
}

/**
 * Import a repository from an Integration, creating the Repository (issue #15).
 *
 * The clone URL is read from the provider rather than taken from the caller, which is what makes
 * this safe to expose: the only repositories importable are the ones the stored token can
 * actually see, so an `externalFullName` naming someone else's repository is a NotFound, not an
 * attempt GateControl will go and make on the user's behalf.
 *
 * Nothing is cloned here. The web app is not allowed to touch the execution host
 * (`scripts/audit-executor-boundary.ts`), and it does not need to be: recording the clone URL as
 * a `remote_url` location hands the work to the orchestrator, which already clones exactly this
 * kind of location into its cache the first time a Task needs it.
 *
 * Idempotent per `(integration, externalFullName)` — importing the same repository twice returns
 * the Repository already there rather than a second row pointing at the same clone URL.
 */
export async function importRepository(
  ctx: RequestContext,
  input: ImportRepositoryInput,
): Promise<Result<RepositoryDto, typeof CommonErrorCode.NotFound>> {
  const cred = await loadCredential(ctx, input.integrationId);
  if (!cred.ok) return err(CommonErrorCode.NotFound);

  const [existing] = await ctx.db
    .select()
    .from(repository)
    .where(
      and(
        eq(repository.workspaceId, ctx.workspaceId),
        eq(repository.integrationId, input.integrationId),
        eq(repository.externalFullName, input.externalFullName),
      ),
    )
    .limit(1);
  if (existing) return ok(repositoryToDto(existing));

  const external = await providerFor(cred.data.row.provider).listRepositories(cred.data.credential);
  const picked = external.find((r) => r.fullName === input.externalFullName);
  if (!picked) return err(CommonErrorCode.NotFound);

  const [row] = await ctx.db
    .insert(repository)
    .values({
      workspaceId: ctx.workspaceId,
      name: input.name ?? picked.name,
      source: "remote_url",
      location: picked.cloneUrl,
      integrationId: input.integrationId,
      externalFullName: picked.fullName,
    })
    .returning();
  return row ? ok(repositoryToDto(row)) : err(CommonErrorCode.NotFound);
}

/** Preview a linked Repository's provider issues, flagging which are already imported. */
export async function listExternalIssues(
  ctx: RequestContext,
  input: ListExternalIssuesInput,
): Promise<
  Result<
    ExternalIssuePreviewDto[],
    typeof CommonErrorCode.NotFound | typeof IntegrationErrorCode.NotLinked
  >
> {
  const repo = await loadLinkedRepository(ctx, input.repositoryId);
  if (!repo.ok) return repo;

  const cred = await loadCredential(ctx, repo.data.integrationId);
  if (!cred.ok) return err(CommonErrorCode.NotFound);

  const external = await providerFor(cred.data.row.provider).listIssues(
    cred.data.credential,
    repo.data.externalFullName,
  );

  // Scoped to this Repository, not the whole Integration: GitLab's issue `iid` restarts per
  // project, so two Repositories on one Integration can share an externalId that means two
  // different issues — filtering by integrationId alone would flag one as "already imported"
  // because of the other (caught in adversarial review before merge).
  const imported = await ctx.db
    .select({ externalId: issue.externalId })
    .from(issue)
    .where(eq(issue.repositoryId, repo.data.id));
  const importedIds = new Set(imported.map((r) => r.externalId));

  return ok(external.map((i) => ({ ...i, alreadyImported: importedIds.has(i.externalId) })));
}

/**
 * Import selected external issues as GateControl Issues (AC-2). Idempotent on
 * `(repositoryId, externalId)` — an id already imported *for this Repository* is skipped on
 * insert and its existing row is returned, so a second import of the same selection is visibly
 * a no-op, not a duplicate. Scoped to the Repository rather than the Integration: GitLab's issue
 * `iid` restarts per project, so two Repositories sharing an Integration can otherwise collide
 * on the same externalId for two genuinely different issues (adversarial review, pre-merge).
 */
export async function importIssues(
  ctx: RequestContext,
  input: ImportIssuesInput,
): Promise<
  Result<IssueDto[], typeof CommonErrorCode.NotFound | typeof IntegrationErrorCode.NotLinked>
> {
  const repo = await loadLinkedRepository(ctx, input.repositoryId);
  if (!repo.ok) return repo;

  const cred = await loadCredential(ctx, repo.data.integrationId);
  if (!cred.ok) return err(CommonErrorCode.NotFound);

  const external = await providerFor(cred.data.row.provider).listIssues(
    cred.data.credential,
    repo.data.externalFullName,
  );
  const selected = new Set(input.externalIds);
  const toImport = external.filter((i) => selected.has(i.externalId));
  const syncedAt = new Date().toISOString();

  if (toImport.length > 0) {
    await ctx.db
      .insert(issue)
      .values(
        toImport.map((i) => ({
          workspaceId: ctx.workspaceId,
          title: i.title,
          description: i.description,
          source: cred.data.row.provider,
          integrationId: repo.data.integrationId,
          repositoryId: repo.data.id,
          externalId: i.externalId,
          externalNumber: i.number,
          externalUrl: i.url,
          syncedAt,
        })),
      )
      .onConflictDoNothing();
  }

  const rows = await ctx.db
    .select()
    .from(issue)
    .where(
      and(
        eq(issue.workspaceId, ctx.workspaceId),
        eq(issue.repositoryId, repo.data.id),
        inArray(issue.externalId, input.externalIds),
      ),
    );
  // A freshly imported Issue has no Tasks yet.
  return ok(rows.map((r) => issueToDto(r, 0)));
}

/** Refresh a Repository's change requests and branches from its Integration (v1: manual trigger, polling — see issue #15). */
export async function syncRepositorySignals(
  ctx: RequestContext,
  input: SyncRepositorySignalsInput,
): Promise<
  Result<
    { changeRequests: ChangeRequestDto[]; branches: RepositoryBranchDto[] },
    typeof CommonErrorCode.NotFound | typeof IntegrationErrorCode.NotLinked
  >
> {
  const repo = await loadLinkedRepository(ctx, input.repositoryId);
  if (!repo.ok) return repo;

  const cred = await loadCredential(ctx, repo.data.integrationId);
  if (!cred.ok) return err(CommonErrorCode.NotFound);

  const driver = providerFor(cred.data.row.provider);
  const [externalCrs, externalBranches] = await Promise.all([
    driver.listChangeRequests(cred.data.credential, repo.data.externalFullName),
    driver.listBranches(cred.data.credential, repo.data.externalFullName),
  ]);
  const syncedAt = new Date().toISOString();

  for (const cr of externalCrs) {
    await ctx.db
      .insert(changeRequest)
      .values({
        workspaceId: ctx.workspaceId,
        repositoryId: repo.data.id,
        integrationId: repo.data.integrationId,
        externalId: cr.externalId,
        number: cr.number,
        title: cr.title,
        state: cr.state,
        url: cr.url,
        headRef: cr.headRef,
        baseRef: cr.baseRef,
        authorLogin: cr.authorLogin,
        syncedAt,
      })
      // Scoped to (repositoryId, externalId), matching the schema's unique index: GitLab's
      // merge-request `iid` restarts per project, so keying on integrationId alone would let
      // one Repository's sync overwrite a different Repository's change request that happens
      // to share the same iid (adversarial review, pre-merge).
      .onConflictDoUpdate({
        target: [changeRequest.repositoryId, changeRequest.externalId],
        set: { title: cr.title, state: cr.state, syncedAt, updatedAt: syncedAt },
      });
  }

  for (const b of externalBranches) {
    await ctx.db
      .insert(repositoryBranch)
      .values({
        workspaceId: ctx.workspaceId,
        repositoryId: repo.data.id,
        name: b.name,
        isDefault: b.isDefault,
        headSha: b.headSha,
        headCommittedAt: b.headCommittedAt,
        syncedAt,
      })
      .onConflictDoUpdate({
        target: [repositoryBranch.repositoryId, repositoryBranch.name],
        set: {
          isDefault: b.isDefault,
          headSha: b.headSha,
          headCommittedAt: b.headCommittedAt,
          syncedAt,
          updatedAt: syncedAt,
        },
      });
  }

  const [changeRequests, branches] = await Promise.all([
    ctx.db.select().from(changeRequest).where(eq(changeRequest.repositoryId, repo.data.id)),
    ctx.db.select().from(repositoryBranch).where(eq(repositoryBranch.repositoryId, repo.data.id)),
  ]);
  return ok({
    changeRequests: changeRequests.map(changeRequestToDto),
    branches: branches.map(repositoryBranchToDto),
  });
}
