import {
  type Db,
  decryptForScmSync,
  integration,
  issue,
  repository,
  secret,
} from "@gatecontrol/db";
import { ISSUE_PAGE_CAP, ISSUE_PAGE_SIZE, providerWith } from "@gatecontrol/scm";
import { and, eq, isNotNull } from "drizzle-orm";

/**
 * Automatic issue ingestion (spec F23 FR-6, issue #125).
 *
 * Polling, not webhooks, and the choice is the point: a local install behind a NAT has no public
 * URL for a webhook to reach, and configuring one on the provider is exactly the manual step this
 * removes. Webhooks can accelerate a hosted deployment later; they cannot be the floor.
 */

export interface RepositorySyncResult {
  repositoryId: string;
  imported: number;
  updated: number;
  /** Set when the poll backed off. The repository keeps its previous watermark. */
  staleReason: string | null;
}

/**
 * Is this the provider saying "slow down"?
 *
 * Matched on the message because a driver throws `ScmProviderError` carrying the status in its
 * text rather than a typed code. Narrow on purpose: mistaking an ordinary failure for a rate
 * limit would quietly stop syncing a repository that is merely misconfigured.
 *
 * It also catches a throttle the driver hit while reading an issue's *links* rather than the
 * issues themselves, and that is deliberate on both sides: a pass that finished with the links
 * merely unknown would advance the watermark past those issues and never ask again, so the
 * driver fails the listing and the watermark stays put for the retry.
 */
export function isBackoffWorthy(cause: unknown): boolean {
  const text = cause instanceof Error ? cause.message : String(cause);
  return /\b429\b|rate limit|secondary rate|too many requests/i.test(text);
}

export interface SyncableRepository {
  id: string;
  workspaceId: string;
  integrationId: string | null;
  externalFullName: string | null;
  issuesSyncedAt: string | null;
}

/**
 * Pull one repository's issues and write what changed.
 *
 * Upserts on `(repository, externalId)` — the uniqueness the manual import already enforces,
 * because GitLab's `iid` restarts at 1 per project and an id alone is not a key (#125 AC-3).
 *
 * **Nothing is deleted here, and that is deliberate** (#125 AC-5 / AC-6). An issue absent from a
 * page is not proof of deletion — it may have been filtered, paged past, or fallen outside the
 * `since` window — and removing it would orphan the Tasks, Sessions and review records that
 * reference it. State is synced; existence is not revoked. A genuinely deleted issue keeps its
 * row and stops being updated, which is a stale row rather than a destroyed history.
 */
export async function syncRepositoryIssues(
  db: Db,
  row: SyncableRepository,
  now: () => Date = () => new Date(),
): Promise<RepositorySyncResult> {
  const base: RepositorySyncResult = {
    repositoryId: row.id,
    imported: 0,
    updated: 0,
    staleReason: null,
  };
  if (!row.integrationId || !row.externalFullName) return base;

  const [connected] = await db
    .select({
      id: integration.id,
      provider: integration.provider,
      baseUrl: integration.baseUrl,
      ciphertext: secret.ciphertext,
    })
    .from(integration)
    .innerJoin(secret, eq(secret.id, integration.secretId))
    .where(and(eq(integration.workspaceId, row.workspaceId), eq(integration.id, row.integrationId)))
    .limit(1);
  if (!connected) return base;

  // Asked for by capability, never by name (Decision 0016). A provider that does not declare
  // `issues` is not one this loop has anything to say to.
  const driver = providerWith(connected.provider, "issues");
  if (!driver) return base;

  const startedAt = now().toISOString();
  let external: Awaited<ReturnType<typeof driver.listIssues>>;
  try {
    external = await driver.listIssues(
      { token: decryptForScmSync(connected.ciphertext), baseUrl: connected.baseUrl },
      row.externalFullName,
      {
        // A repository with no watermark yet asks for everything, which is what an empty
        // `since` means to a driver — spread rather than passed as undefined, so the option is
        // absent rather than present-and-empty.
        ...(row.issuesSyncedAt ? { since: row.issuesSyncedAt } : {}),
        /**
         * The one caller that asks for the links, because it is the one that stores them.
         *
         * They cost a request per issue, so the enrichment is opt-in and every other caller —
         * the connect-time auto-import, the import preview — pays for issues alone. Asked for
         * here on the ordinary poll rather than on a schedule of its own: a merge is the
         * transition a reader is most likely to be shown stale (#128 AC-4).
         */
        linkedChangeRequests: true,
      },
    );
  } catch (cause) {
    const reason = isBackoffWorthy(cause)
      ? "the provider is rate limiting this connection"
      : "the provider could not be reached";
    // The watermark stays where it was: a failed poll must not advance past issues it never
    // read, or they are skipped for ever.
    await db
      .update(repository)
      .set({ syncStaleSince: startedAt, syncStaleReason: reason })
      .where(eq(repository.id, row.id));
    return { ...base, staleReason: reason };
  }

  let imported = 0;
  let updated = 0;
  for (const item of external) {
    const [existing] = await db
      .select({ id: issue.id })
      .from(issue)
      .where(
        and(
          eq(issue.workspaceId, row.workspaceId),
          eq(issue.repositoryId, row.id),
          eq(issue.externalId, item.externalId),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(issue)
        .set({
          title: item.title,
          description: item.description,
          externalUrl: item.url,
          ...(item.labels ? { labels: item.labels } : {}),
          // Link state — which pull or merge request is in flight, and whether it merged — is
          // what changes most often between two polls (F23 FR-8, issue #128), so it is refreshed
          // here rather than on a schedule of its own. A driver that could not read them omits
          // the field, and the row keeps the links last confirmed: blanking a column because one
          // side call failed would be the table claiming nothing is in flight.
          ...(item.linkedChangeRequests ? { linkedChangeRequests: item.linkedChangeRequests } : {}),
          // Closed on the provider is what an epic's progress is counted from (issue #127 AC-3),
          // so it is refreshed on every poll — FR-13's "without a person acting".
          externalState: item.state,
          // `undefined` is "this driver does not report a hierarchy"; `null` is "this issue has
          // no parent". Only the second may erase an edge — a provider that went quiet must not
          // silently un-nest a row another poll correctly nested.
          ...(item.parentExternalId !== undefined
            ? { externalParentId: item.parentExternalId }
            : {}),
          syncedAt: startedAt,
          updatedAt: startedAt,
        })
        .where(eq(issue.id, existing.id));
      updated += 1;
      continue;
    }

    await db.insert(issue).values({
      workspaceId: row.workspaceId,
      title: item.title,
      description: item.description,
      source: connected.provider,
      integrationId: connected.id,
      repositoryId: row.id,
      externalId: item.externalId,
      externalNumber: item.number,
      externalUrl: item.url,
      ...(item.labels ? { labels: item.labels } : {}),
      ...(item.linkedChangeRequests ? { linkedChangeRequests: item.linkedChangeRequests } : {}),
      externalState: item.state,
      externalParentId: item.parentExternalId ?? null,
      syncedAt: startedAt,
    });
    imported += 1;
  }

  /*
   * The watermark advances only on a poll that actually read everything.
   *
   * A driver walks pages up to `ISSUE_PAGE_CAP`, and a listing that came back holding exactly the
   * cap is a listing that *stopped*, not one that finished. Advancing past a stop is the worst
   * failure this loop has: the unread issues fall outside every later `since` window and are
   * never asked for again — silent, permanent, and invisible because the pass looked successful.
   *
   * So a truncated pass keeps its watermark and says it is stale. The next pass re-reads from the
   * same point and gets further; nothing is lost, and the operator is told the repository is
   * behind rather than shown a fraction of it as though it were whole.
   */
  const truncated = external.length >= ISSUE_PAGE_SIZE * ISSUE_PAGE_CAP;
  if (truncated) {
    const reason = "more issues than one pass can read — still catching up";
    await db
      .update(repository)
      .set({ syncStaleSince: startedAt, syncStaleReason: reason })
      .where(eq(repository.id, row.id));
    return { ...base, imported, updated, staleReason: reason };
  }

  await db
    .update(repository)
    .set({ issuesSyncedAt: startedAt, syncStaleSince: null, syncStaleReason: null })
    .where(eq(repository.id, row.id));

  return { ...base, imported, updated };
}

/** Every repository linked to an integration — the set this loop has anything to do for. */
export async function linkedRepositories(db: Db): Promise<SyncableRepository[]> {
  return db
    .select({
      id: repository.id,
      workspaceId: repository.workspaceId,
      integrationId: repository.integrationId,
      externalFullName: repository.externalFullName,
      issuesSyncedAt: repository.issuesSyncedAt,
    })
    .from(repository)
    .where(isNotNull(repository.integrationId));
}
