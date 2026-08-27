import "server-only";
import {
  CommonErrorCode,
  type CreateIssueCommentInput,
  err,
  IntegrationErrorCode,
  type IssueCommentListDto,
  type IssueDetailDto,
  type IssueField,
  ok,
  type Result,
  type UpdateExternalIssueInput,
} from "@solow/contracts";
import { issue, repository } from "@solow/db";
import type { IssuePatch } from "@solow/scm";
import { providerManifest } from "@solow/scm";
import { and, eq } from "drizzle-orm";
import type { RequestContext } from "./context.js";
import { driverWith, loadCredential } from "./integration.js";

/**
 * Editing an imported Issue on the provider that owns it (spec F23 FR-13, Decision 0019).
 *
 * Every function here does the same two things in the same order: ask the provider to change
 * something, then write **the provider's answer** into the mirror. Never the value that was sent.
 * A provider may normalise a title, refuse an assignee who has no access, or drop a label that
 * does not exist, and a mirror updated from the request rather than the response would hold a
 * value nobody ever stored — which is worse than being stale, because it looks current.
 */

/** An Issue that has a provider behind it, with everything needed to reach it. */
async function loadImportedIssue(
  ctx: RequestContext,
  issueId: string,
): Promise<
  Result<
    {
      row: typeof issue.$inferSelect;
      integrationId: string;
      repoFullName: string;
      issueNumber: number;
    },
    typeof CommonErrorCode.NotFound | IntegrationErrorCode
  >
> {
  const [row] = await ctx.db
    .select()
    .from(issue)
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, issueId)))
    .limit(1);
  if (!row) return err(CommonErrorCode.NotFound);
  // A locally-created Issue has no provider to write to. Not an error the operator can fix, so
  // the editor must not have offered the controls — this is the second line.
  if (!row.integrationId || !row.repositoryId || row.externalNumber === null) {
    return err(IntegrationErrorCode.NotLinked);
  }

  const [repo] = await ctx.db
    .select({ externalFullName: repository.externalFullName })
    .from(repository)
    .where(and(eq(repository.workspaceId, ctx.workspaceId), eq(repository.id, row.repositoryId)))
    .limit(1);
  if (!repo?.externalFullName) return err(IntegrationErrorCode.NotLinked);

  return ok({
    row,
    integrationId: row.integrationId,
    repoFullName: repo.externalFullName,
    issueNumber: row.externalNumber,
  });
}

/**
 * What this provider will accept a change to, read off its manifest.
 *
 * Asked as a capability question, never as "is this GitHub" (Decision 0016). A provider that does
 * not declare `issueWrites` at all answers "nothing, and here is why for each field" — which the
 * editor renders as disabled controls carrying a sentence, rather than as controls that fail on
 * save.
 */
const NO_WRITES_REASON = "This provider does not support editing issues from SoloW.";

function writeSupport(provider: string): { writes: IssueField[]; cannot: Record<string, string> } {
  const manifest = providerManifest(provider);
  const declared = manifest?.issueWrites;
  if (!declared) {
    return {
      writes: [],
      cannot: {
        title: NO_WRITES_REASON,
        description: NO_WRITES_REASON,
        state: NO_WRITES_REASON,
        assignees: NO_WRITES_REASON,
        labels: NO_WRITES_REASON,
        milestone: NO_WRITES_REASON,
      },
    };
  }
  return { writes: [...declared.writes], cannot: { ...declared.cannot } };
}

/**
 * One issue, live from the provider, with the vocabularies its editor needs.
 *
 * Four provider calls, deliberately: the issue, the assignable people, the milestones and the
 * label vocabulary. They are independent, so they go together rather than in sequence — a panel
 * that took four round trips to open would be a panel nobody opens.
 *
 * The three vocabulary calls are each allowed to fail on their own. A token that cannot list a
 * repository's collaborators can still edit a title, and losing the whole panel to one optional
 * list would be the sync-time mistake repeated in a dialog: an empty answer where the honest one
 * is "this part is unavailable".
 */
export async function readIssueDetail(
  ctx: RequestContext,
  input: { issueId: string },
): Promise<Result<IssueDetailDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const loaded = await loadImportedIssue(ctx, input.issueId);
  if (!loaded.ok) return loaded;

  const credential = await loadCredential(ctx, loaded.data.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const provider = credential.data.row.provider;

  const issues = driverWith(provider, "issues");
  if (!issues.ok) return err(issues.error);

  const writes = driverWith(provider, "issueWrites");
  const [current, assignable, milestones, labels] = await Promise.all([
    issues.data.getIssue(
      credential.data.credential,
      loaded.data.repoFullName,
      loaded.data.issueNumber,
    ),
    writes.ok
      ? writes.data
          .listAssignableUsers(credential.data.credential, loaded.data.repoFullName)
          .catch(() => [])
      : Promise.resolve([]),
    writes.ok
      ? writes.data
          .listMilestones(credential.data.credential, loaded.data.repoFullName)
          .catch(() => [])
      : Promise.resolve([]),
    issues.data.listLabels(credential.data.credential, loaded.data.repoFullName).catch(() => []),
  ]);

  await mirror(ctx, loaded.data.row.id, current);
  const support = writeSupport(provider);

  /*
   * The children, read from the mirror rather than from the provider.
   *
   * The parent edge is already synced onto every Issue (`external_parent_id`), so asking the
   * provider again would be a second round trip for an answer we hold — and one that could
   * disagree with the hierarchy the table beside this panel is drawing from the same column.
   *
   * Scoped by repository as well as by parent id: GitLab's `iid` restarts at 1 per project, so a
   * bare parent id can name two different issues, and nesting a row under a stranger's epic is
   * worse than showing none.
   */
  const children = loaded.data.row.externalId
    ? await ctx.db
        .select({
          id: issue.id,
          externalNumber: issue.externalNumber,
          title: issue.title,
          externalUrl: issue.externalUrl,
          externalState: issue.externalState,
        })
        .from(issue)
        .where(
          and(
            eq(issue.workspaceId, ctx.workspaceId),
            eq(issue.externalParentId, loaded.data.row.externalId),
            ...(loaded.data.row.repositoryId
              ? [eq(issue.repositoryId, loaded.data.row.repositoryId)]
              : []),
          ),
        )
        .orderBy(issue.externalNumber)
    : [];

  return ok({
    issueId: loaded.data.row.id,
    externalNumber: current.number,
    externalUrl: current.url,
    title: current.title,
    description: current.description,
    state: current.state,
    assignees: current.assignees ?? [],
    labels: current.labels ?? [],
    milestone: current.milestone ?? null,
    availableLabels: labels.map((l) => ({ name: l.name, color: l.color ?? null })),
    availableAssignees: assignable,
    availableMilestones: milestones,
    writes: support.writes,
    cannot: support.cannot,
    subIssues: children.map((child) => ({
      issueId: child.id,
      number: child.externalNumber,
      title: child.title,
      url: child.externalUrl,
      closed: child.externalState === "closed",
    })),
  });
}

/**
 * Send a patch, and mirror what came back.
 *
 * Refused before the network when the provider has said it cannot hold the field being changed —
 * the editor should not have offered the control, and this is the second line rather than the
 * first (the same two-layer refusal `setProjectValue` uses).
 */
export async function updateExternalIssue(
  ctx: RequestContext,
  input: UpdateExternalIssueInput,
): Promise<
  Result<
    IssueDetailDto,
    typeof CommonErrorCode.NotFound | IntegrationErrorCode | typeof CommonErrorCode.ValidationFailed
  >
> {
  const loaded = await loadImportedIssue(ctx, input.issueId);
  if (!loaded.ok) return loaded;

  const credential = await loadCredential(ctx, loaded.data.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const provider = credential.data.row.provider;
  const writes = driverWith(provider, "issueWrites");
  if (!writes.ok) return err(writes.error);

  const patch: IssuePatch = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.description !== undefined) patch.description = input.description;
  if (input.state !== undefined) patch.state = input.state;
  if (input.assignees !== undefined) patch.assignees = input.assignees;
  if (input.labels !== undefined) patch.labels = input.labels;
  if (input.milestone !== undefined) patch.milestone = input.milestone;

  const support = writeSupport(provider);
  const touched = Object.keys(patch) as IssueField[];
  // An empty patch is a no-op request, not a write. Sending it would still cost a round trip and
  // would bump the issue's `updated_at` on some providers for no change at all.
  if (touched.length === 0) return readIssueDetail(ctx, { issueId: input.issueId });
  if (touched.some((field) => !support.writes.includes(field))) {
    return err(CommonErrorCode.ValidationFailed);
  }

  const stored = await writes.data.updateIssue(
    credential.data.credential,
    loaded.data.repoFullName,
    loaded.data.issueNumber,
    patch,
  );
  await mirror(ctx, loaded.data.row.id, stored);

  // Re-read rather than assembling a DTO from the write's answer plus remembered vocabularies:
  // an edit can change what the next edit may say (a milestone just created, a label just
  // applied), and a panel showing a stale vocabulary beside a fresh value is the same drift in
  // miniature.
  return readIssueDetail(ctx, { issueId: input.issueId });
}

/**
 * Write the provider's answer into the mirror.
 *
 * Only the columns the mirror actually holds. Assignees and the milestone are deliberately not
 * among them: they have no column, they are read live by the panel that needs them, and adding
 * them here would create a copy that nothing refreshes between polls.
 */
async function mirror(
  ctx: RequestContext,
  issueId: string,
  current: {
    title: string;
    description: string | null;
    state: "open" | "closed";
    labels?: string[] | undefined;
  },
): Promise<void> {
  await ctx.db
    .update(issue)
    .set({
      title: current.title,
      description: current.description,
      externalState: current.state,
      // Absent means the provider did not say, which must not be written as "no labels".
      ...(current.labels ? { labels: current.labels } : {}),
      syncedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(and(eq(issue.workspaceId, ctx.workspaceId), eq(issue.id, issueId)));
}

/**
 * The discussion on one issue, read live.
 *
 * Not mirrored, and deliberately: a comment thread is the one part of an issue that changes
 * without anything here doing it, and a stale copy of a conversation is worse than no copy —
 * it looks like the whole of it.
 */
export async function listIssueComments(
  ctx: RequestContext,
  input: { issueId: string },
): Promise<Result<IssueCommentListDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const loaded = await loadImportedIssue(ctx, input.issueId);
  if (!loaded.ok) return loaded;

  const credential = await loadCredential(ctx, loaded.data.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const provider = credential.data.row.provider;

  const issues = driverWith(provider, "issues");
  if (!issues.ok) return err(issues.error);

  const comments = await issues.data.listComments(
    credential.data.credential,
    loaded.data.repoFullName,
    loaded.data.issueNumber,
  );

  return ok({
    comments: comments.map((comment) => ({
      externalId: comment.externalId,
      author: comment.author,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      url: comment.url,
    })),
    // The composer is shown only where posting can actually work — a provider that reads and
    // does not write shows the thread with no box, rather than a box that fails on submit.
    canComment: driverWith(provider, "issueWrites").ok,
  });
}

/** Post a comment, and answer with the thread as it now stands. */
export async function createIssueComment(
  ctx: RequestContext,
  input: CreateIssueCommentInput,
): Promise<Result<IssueCommentListDto, typeof CommonErrorCode.NotFound | IntegrationErrorCode>> {
  const loaded = await loadImportedIssue(ctx, input.issueId);
  if (!loaded.ok) return loaded;

  const credential = await loadCredential(ctx, loaded.data.integrationId);
  if (!credential.ok) return err(CommonErrorCode.NotFound);
  const writes = driverWith(credential.data.row.provider, "issueWrites");
  if (!writes.ok) return err(writes.error);

  await writes.data.createComment(
    credential.data.credential,
    loaded.data.repoFullName,
    loaded.data.issueNumber,
    input.body,
  );

  /*
   * Re-read rather than appending the write's answer to a list held on the client.
   *
   * Two reasons, and the second decides it: a provider may render or normalise what was posted,
   * and someone else may have commented while this one was being written. Answering with the
   * whole thread is the only response that cannot be missing a message.
   */
  return listIssueComments(ctx, { issueId: input.issueId });
}
