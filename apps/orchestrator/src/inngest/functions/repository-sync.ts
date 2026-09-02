import { createDb } from "@solow/db";
import { createLogger } from "@solow/observability";
import { linkedRepositories, syncRepositoryIssues } from "../../sync/issues.js";
import { syncRepositoryLabels } from "../../sync/labels.js";
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
    triggers: [{ cron: REPOSITORY_SYNC_CRON }],
  },
  async ({ step }) => {
    const db = createDb();
    const log = createLogger({ service: "orchestrator" });

    const repositories = await step.run("list-linked-repositories", () => linkedRepositories(db));
    let imported = 0;
    let updated = 0;
    let stale = 0;
    let labelled = 0;

    for (const row of repositories) {
      // Its own step: a rate limit on one connection must not cost the others their pass, and a
      // retry re-runs one repository rather than the whole sweep.
      const result = await step.run(`sync-${row.id}`, () => syncRepositoryIssues(db, row));
      imported += result.imported;
      updated += result.updated;
      if (result.staleReason) stale += 1;

      /*
       * The label vocabulary, on its own much slower clock.
       *
       * A separate step for the same reason the issue pass is one — a repository whose labels
       * cannot be read still gets its issues — and `syncRepositoryLabels` decides for itself
       * whether anything is due, so this costs a timestamp comparison on the passes (the large
       * majority) where it is not. Reading it here rather than on a cron of its own means it
       * inherits this loop's ordering and its per-repository isolation for free.
       */
      const labels = await step.run(`labels-${row.id}`, () => syncRepositoryLabels(db, row));
      if (!labels.skipped && !labels.failedReason) labelled += 1;
    }

    if (imported > 0 || updated > 0 || stale > 0 || labelled > 0) {
      log.info(
        { imported, updated, stale, labelled, repositories: repositories.length },
        "repository sync pass complete",
      );
    }
    return { repositories: repositories.length, imported, updated, stale, labelled };
  },
);
