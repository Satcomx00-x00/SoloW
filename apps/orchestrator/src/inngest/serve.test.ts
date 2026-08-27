import { describe, expect, it } from "bun:test";
import { INNGEST_FUNCTIONS } from "./serve.js";

/**
 * `INNGEST_FUNCTIONS` is the one list Inngest is actually served (bug found 2026-08-27,
 * user-reported: a GitLab repository's Issues never synced). It used to be duplicated — one copy
 * here, feeding the real handler, and a second, hand-kept one in `index.ts` that fed nothing but
 * a boot-time log line — and the two silently drifted apart: `repositorySync` (issue #125's
 * cron) was added to the log-line copy and never to this one, so Inngest never learned it
 * existed. This test is the guard: every function this process means to run has to show up here,
 * or it is unreachable no matter what `index.ts` claims.
 */
describe("INNGEST_FUNCTIONS", () => {
  it("includes every function this process is supposed to serve, by id", () => {
    const ids = INNGEST_FUNCTIONS.map((fn) => fn.id());
    expect(ids).toContain("task-run");
    expect(ids).toContain("repository-sync");
  });
});
