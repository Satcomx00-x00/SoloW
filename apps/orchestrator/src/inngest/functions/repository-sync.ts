import { REPOSITORY_SYNC_REQUESTED } from "@solow/contracts";
import { createDb } from "@solow/db";
import { createLogger } from "@solow/observability";
import { MirrorChanges } from "../../sync/announce.js";
import { linkedRepositories, syncRepositoryIssues } from "../../sync/issues.js";
import { syncRepositoryLabels } from "../../sync/labels.js";
import { hub } from "../../ws/hub.js";
import { inngest } from "../client.js";

/**
 * The durable loop behind "issues arrive because they exist" (issue #125).
 *
 * A cron rather than a `setInterval`, for the reason every other long-running thing here is
 * durable: an orchestrator restart in the middle of a pass resumes on the next tick with each
 * repository's own watermark intact, rather than losing the pass and re-reading everything
 * (Principle III).
 *
 * One step per repository, so a provider that is rate limiting one connection does not stop the
 * others — and so a failure is attributed to the repository that caused it rather than to "the
 * sync".
 */

/**
 * Every five minutes, and that number is a measurement rather than a taste.
 *
 * A pass costs one listing request per linked repository — the provider's own "updated since"
 * filter, so a quiet repository answers with an empty array — plus one request per issue that
 * actually changed. Ten repositories is therefore about 120 requests an hour at rest, against
 * GitHub's 5 000 for an authenticated token: roughly two percent of the budget, with the whole
 * of the rest left for the things a person is waiting on.
 *
 * What used to spend the budget was never this loop. It was a *read path* — the project table
 * asked every repository for its label vocabulary on every render, which on the same ten
 * repositories cost ten requests per page view and 2.3 seconds of somebody's attention. That is
 * why labels are mirrored now (`sync/labels.ts`) and why this interval did not need shortening
 * or lengthening: the poll was never the thing that was too eager.
 */
export const REPOSITORY_SYNC_CRON = "*/5 * * * *";

export const repositorySync = inngest.createFunction(
  {
    id: "repository-sync",
    retries: 1,
    /**
     * Two ways in, one pass.
     *
     * The manual refresh is the same function as the cron rather than a second implementation of
     * it, because "refresh" and "the scheduled poll" mean the same thing and two code paths for
     * one meaning drift the first time either gains a step. All the event changes is `force`,
     * which is exactly the difference the person pressing the button intends: read it now, even
     * though we read it recently.
     */
    triggers: [{ cron: REPOSITORY_SYNC_CRON }, { event: REPOSITORY_SYNC_REQUESTED }],
  },
  async ({ step, event }) => {
    // A cron tick carries the scheduled event's own name; anything else here is a person asking.
    const forced = event?.name === REPOSITORY_SYNC_REQUESTED;
    const db = createDb();
    const log = createLogger({ service: "orchestrator" });

    const repositories = await step.run("list-linked-repositories", () => linkedRepositories(db));
    let imported = 0;
    let updated = 0;
    let stale = 0;
    let labelled = 0;
    // What this pass actually changed, so open tabs can be told — and only if there is something
    // to tell them. See `sync/announce.ts`.
    const changes = new MirrorChanges();

    for (const row of repositories) {
      // Its own step: a rate limit on one connection must not cost the others their pass, and a
      // retry re-runs one repository rather than the whole sweep.
      const result = await step.run(`sync-${row.id}`, () => syncRepositoryIssues(db, row));
      imported += result.imported;
      updated += result.updated;
      if (result.staleReason) stale += 1;
      if (result.imported > 0 || result.updated > 0) changes.issuesChanged(row.workspaceId);

      /*
       * The label vocabulary, on its own much slower clock.
       *
       * A separate step for the same reason the issue pass is one — a repository whose labels
       * cannot be read still gets its issues — and `syncRepositoryLabels` decides for itself
       * whether anything is due, so this costs a timestamp comparison on the passes (the large
       * majority) where it is not. Reading it here rather than on a cron of its own means it
       * inherits this loop's ordering and its per-repository isolation for free.
       */
      const labels = await step.run(`labels-${row.id}`, () =>
        syncRepositoryLabels(db, row, { force: forced }),
      );
      if (!labels.skipped && !labels.failedReason) labelled += 1;
      // Only a vocabulary that actually moved is worth telling anyone about. A six-hourly
      // re-read that came back identical is the common case, and announcing it would make every
      // open tab re-query for rows that did not change.
      if (labels.changed) changes.labelsChanged(row.workspaceId);
    }

    /*
     * Announced outside every `step.run`, on purpose.
     *
     * A step's result is memoized and replayed; a WebSocket frame is not a result, it is a side
     * effect on a connection that exists only in this process right now. Publishing inside a step
     * would send nothing on a replay that skipped it, which is the run where a client most needs
     * telling. Out here it is sent once per attempt, and a duplicate nudge costs a client one
     * invalidation of data it was about to be told to re-read anyway.
     */
    const announced = changes.announce(hub);

    if (imported > 0 || updated > 0 || stale > 0 || labelled > 0) {
      log.info(
        {
          imported,
          updated,
          stale,
          labelled,
          announced,
          forced,
          repositories: repositories.length,
        },
        "repository sync pass complete",
      );
    }
    return { repositories: repositories.length, imported, updated, stale, labelled, announced };
  },
);
