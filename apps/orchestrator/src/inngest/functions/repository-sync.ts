import { createDb } from "@gatecontrol/db";
import { createLogger } from "@gatecontrol/observability";
import { linkedRepositories, syncRepositoryIssues } from "../../sync/issues.js";
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

    for (const row of repositories) {
      // Its own step: a rate limit on one connection must not cost the others their pass, and a
      // retry re-runs one repository rather than the whole sweep.
      const result = await step.run(`sync-${row.id}`, () => syncRepositoryIssues(db, row));
      imported += result.imported;
      updated += result.updated;
      if (result.staleReason) stale += 1;
    }

    if (imported > 0 || updated > 0 || stale > 0) {
      log.info(
        { imported, updated, stale, repositories: repositories.length },
        "repository sync pass complete",
      );
    }
    return { repositories: repositories.length, imported, updated, stale };
  },
);
