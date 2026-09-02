import {
  type Db,
  decryptForScmSync,
  integration,
  repository,
  repositoryLabel,
  secret,
} from "@solow/db";
import { providerWith } from "@solow/scm";
import { and, eq, inArray } from "drizzle-orm";
import type { SyncableRepository } from "./issues.js";

/**
 * Mirroring a repository's label vocabulary, so that reading it costs a query instead of a
 * round trip.
 *
 * The screen that needs this is the project table: it colours every label chip from the
 * provider's own palette. That read used to walk each linked repository and call the provider
 * for it, in sequence, while the operator waited — 2.3 seconds and ten GitHub requests on every
 * single page view of a ten-repository workspace, and the rest of the screen's queries batched
 * behind it. Now the poll pays that cost, once, on a schedule.
 *
 * Its own module rather than a branch inside `syncRepositoryIssues`, because the two run on
 * genuinely different clocks and must fail apart: a label read that 403s must not cost the
 * repository its issue pass, and an issue pass must not re-read a vocabulary that changes a few
 * times a year.
 */

/**
 * How long a mirrored vocabulary is trusted.
 *
 * Six hours, which is deliberately far longer than the five-minute issue poll. Labels are
 * *definitions*, not state: a repository's set of them is edited when someone reorganises a
 * workflow, not when work happens. The cost of being late is that a label created in the last
 * few hours draws in the neutral fallback colour until the next refresh — visible, harmless, and
 * corrected without anyone acting. The cost of being eager is a request per repository per pass,
 * for an answer that is almost always byte-identical to the one already held.
 *
 * The "Sync now" path bypasses this entirely by passing `force`, which is what makes the wait
 * acceptable: someone who just created a label has a way to see it immediately.
 */
export const LABEL_REFRESH_MS = 6 * 60 * 60 * 1000;

export interface LabelSyncResult {
  repositoryId: string;
  /** How many labels the provider reported. Zero is a valid answer, not necessarily a failure. */
  labels: number;
  /** True when the mirror was still inside `LABEL_REFRESH_MS` and no request was made. */
  skipped: boolean;
  /**
   * Whether the write actually moved anything.
   *
   * Separate from "a read happened", because the read is the common case and the change is the
   * rare one: a vocabulary re-read every six hours is byte-identical almost every time. Only a
   * real change is worth announcing to open tabs — announcing every successful read instead
   * would make every one of them re-query for rows that did not move.
   */
  changed: boolean;
  /** Set when the read failed; the previous mirror is kept rather than emptied. */
  failedReason: string | null;
}

/** Is this repository's mirrored vocabulary old enough to be worth a request? */
export function labelsAreDue(
  labelsSyncedAt: string | null,
  now: Date,
  refreshMs: number = LABEL_REFRESH_MS,
): boolean {
  if (!labelsSyncedAt) return true;
  const last = Date.parse(labelsSyncedAt);
  // An unparseable watermark is treated as never synced. It cannot be trusted to be in the past,
  // and refusing to refresh on a value we cannot read would strand the mirror permanently.
  if (Number.isNaN(last)) return true;
  return now.getTime() - last >= refreshMs;
}

/**
 * Pull one repository's labels and replace what is mirrored for it.
 *
 * A *replace*, unlike `syncRepositoryIssues`, and the difference is the point. Nothing references
 * a label row — it is a colour lookup keyed by a name that lives on the issue — so a label
 * deleted on the provider genuinely should disappear here, where an issue absent from a page
 * must never be taken for a deleted one. The whole vocabulary arrives in a single unpaged answer,
 * so "absent from this read" is real evidence of absence rather than of paging.
 *
 * A failed read keeps the previous mirror. Emptying it would repaint every chip on the table in
 * the fallback colour because one request timed out, which reads as "these labels lost their
 * colours" rather than as "we could not check".
 */
export async function syncRepositoryLabels(
  db: Db,
  row: SyncableRepository,
  options: { force?: boolean; now?: () => Date } = {},
): Promise<LabelSyncResult> {
  const now = options.now ?? (() => new Date());
  const base: LabelSyncResult = {
    repositoryId: row.id,
    labels: 0,
    skipped: false,
    changed: false,
    failedReason: null,
  };
  if (!row.integrationId || !row.externalFullName) return base;
  if (!options.force && !labelsAreDue(row.labelsSyncedAt, now())) {
    return { ...base, skipped: true };
  }

  const [connected] = await db
    .select({
      provider: integration.provider,
      baseUrl: integration.baseUrl,
      ciphertext: secret.ciphertext,
    })
    .from(integration)
    .innerJoin(secret, eq(secret.id, integration.secretId))
    .where(and(eq(integration.workspaceId, row.workspaceId), eq(integration.id, row.integrationId)))
    .limit(1);
  if (!connected) return base;

  // Asked for by capability, never by name (Decision 0016).
  const driver = providerWith(connected.provider, "issues");
  if (!driver) return base;

  let external: Awaited<ReturnType<typeof driver.listLabels>>;
  try {
    external = await driver.listLabels(
      { token: decryptForScmSync(connected.ciphertext), baseUrl: connected.baseUrl },
      row.externalFullName,
    );
  } catch (cause) {
    return {
      ...base,
      failedReason: cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
    };
  }

  const syncedAt = now().toISOString();
  // Deduplicated on the way in: the unique index is `(repository, name)`, and a provider that
  // reports the same name twice (case-differing scoped labels on GitLab do this) would otherwise
  // fail the whole write for one duplicate.
  const byName = new Map(external.map((label) => [label.name, label.color ?? null]));

  const existing = await db
    .select({ id: repositoryLabel.id, name: repositoryLabel.name, color: repositoryLabel.color })
    .from(repositoryLabel)
    .where(eq(repositoryLabel.repositoryId, row.id));
  const known = new Map(existing.map((r) => [r.name, r]));

  let changed = false;

  const gone = existing.filter((r) => !byName.has(r.name)).map((r) => r.id);
  if (gone.length > 0) {
    await db.delete(repositoryLabel).where(inArray(repositoryLabel.id, gone));
    changed = true;
  }

  for (const [name, color] of byName) {
    const current = known.get(name);
    if (!current) {
      await db.insert(repositoryLabel).values({
        workspaceId: row.workspaceId,
        repositoryId: row.id,
        name,
        color,
        syncedAt,
      });
      changed = true;
      continue;
    }
    // Only when it actually moved: an unconditional update would bump `updated_at` on every
    // label of every repository every six hours, for rows that did not change.
    if (current.color !== color) {
      await db
        .update(repositoryLabel)
        .set({ color, syncedAt })
        .where(eq(repositoryLabel.id, current.id));
      changed = true;
    }
  }

  await db.update(repository).set({ labelsSyncedAt: syncedAt }).where(eq(repository.id, row.id));

  return { ...base, labels: byName.size, changed };
}
