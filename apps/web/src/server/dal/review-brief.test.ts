/// <reference types="bun-types" />

import { beforeEach, describe, expect, it } from "bun:test";
import { sessionEvent, session as sessionTable, worktree } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { getReviewBrief } from "./review-brief.js";
import { createTaskRecord } from "./task.js";
import { ctxFor, seedIssue, seedWorkspaceGraph } from "./test-fixtures.js";

/**
 * The brief assembled from a log the way the Task the analysis was about left one: a step_card
 * with one item per criterion, a `bun test` run from a copy in /tmp, a typecheck in the
 * worktree, and a diff naming the files the claims talk about.
 */
describe("getReviewBrief", () => {
  let db: TestDb;
  beforeEach(() => {
    db = createTestDb();
  });

  it("lines criteria, claims, files and checks up, and says where a check ran", async () => {
    const g = await seedWorkspaceGraph(db, "brief");
    const ctx = ctxFor(db, g.workspaceId);
    const issue = await seedIssue(db, g.workspaceId, {
      title: "Sector source overrides",
      description: [
        "## Acceptance criteria",
        "- [ ] **AC-1** A `sector_source_overrides` table exists",
        "- [ ] **AC-14** An integration test proves both directions and runs in CI",
      ].join("\n"),
    });
    const made = await createTaskRecord(ctx, {
      issueId: issue.id,
      title: "ee",
      agentProfileId: g.agentProfileId,
      executorProfileId: g.executorProfileId,
      repositories: [{ repositoryId: g.repositoryId }],
      state: "review",
    });
    if (!made.ok) throw new Error("seed");
    const [sess] = await db
      .insert(sessionTable)
      .values({ workspaceId: g.workspaceId, taskId: made.data.id, state: "awaiting_review" })
      .returning();
    if (!sess) throw new Error("seed");
    await db.insert(worktree).values({
      workspaceId: g.workspaceId,
      taskId: made.data.id,
      repositoryId: g.repositoryId,
      path: "/repo/.claude/worktrees/solow-task-ee",
      branch: "b",
      status: "active",
    });
    const at = "2026-09-11T16:30:00.000Z";
    const rows = [
      {
        kind: "tool_call",
        payload: {
          kind: "tool_call",
          name: "Bash",
          callId: "c1",
          input: { command: "cd /tmp/base-115/apps/api && bun test 2>&1 | tail -8" },
          status: "completed",
        },
      },
      {
        kind: "tool_result",
        payload: { kind: "tool_result", callId: "c1", ok: true, output: " 811 pass\n 6 fail\n" },
      },
      {
        kind: "tool_call",
        payload: {
          kind: "tool_call",
          name: "Bash",
          callId: "c2",
          input: { command: "cd /repo/.claude/worktrees/solow-task-ee && bun run typecheck" },
          status: "completed",
        },
      },
      {
        kind: "tool_result",
        payload: {
          kind: "tool_result",
          callId: "c2",
          ok: true,
          output: "Tasks: 21 successful, 21 total",
        },
      },
      {
        kind: "tool_call",
        payload: {
          kind: "tool_call",
          name: "Bash",
          callId: "c3",
          input: { command: "sed -n 1,40p apps/api/test/x.test.ts" },
          status: "completed",
        },
      },
      {
        kind: "diff",
        payload: {
          kind: "diff",
          diffRef: "b",
          files: [
            {
              path: "packages/db/drizzle/0044_fluffy_spyke.sql",
              status: "added",
              additions: 14,
              deletions: 0,
            },
            {
              path: "apps/api/test/sectors/source-overrides.test.ts",
              status: "added",
              additions: 419,
              deletions: 0,
            },
          ],
          patch: "",
          truncated: false,
        },
      },
      {
        kind: "widget",
        payload: {
          kind: "widget",
          widgetId: "w",
          widget: {
            kind: "step_card",
            title: "Build",
            steps: [
              {
                id: "ac1",
                label: "AC-1 table",
                state: "done",
                note: "packages/db/drizzle/0044_fluffy_spyke.sql, no hand-written SQL",
              },
              {
                id: "ac14",
                label: "AC-14 integration test",
                state: "done",
                note: "14 cases in apps/api/test/sectors/source-overrides.test.ts; NOT executed here",
              },
              { id: "migrate", label: "Migration applied", state: "blocked", note: "no Postgres" },
            ],
          },
        },
      },
    ];
    await db.insert(sessionEvent).values(
      rows.map((row, seq) => ({
        workspaceId: g.workspaceId,
        sessionId: sess.id,
        seq,
        kind: row.kind,
        payload: row.payload,
        at,
      })),
    );

    const brief = await getReviewBrief(ctx, sess.id);
    if (!brief.ok) throw new Error("brief failed");
    expect(brief.data.worktreePath).toBe("/repo/.claude/worktrees/solow-task-ee");
    expect(brief.data.criteria.map((c) => [c.id, c.claim?.state, c.files.length, c.tests])).toEqual(
      [
        ["AC-1", "done", 1, []],
        ["AC-14", "done", 1, ["apps/api/test/sectors/source-overrides.test.ts"]],
      ],
    );
    expect(brief.data.unmatched.map((c) => c.label)).toEqual(["Migration applied"]);
    // Two verifications, not three: a `sed` is a read. And the test suite ran in a copy.
    expect(brief.data.checks.map((c) => [c.kind, c.verdict, c.passed, c.elsewhere])).toEqual([
      ["test", "811 pass / 6 fail", false, true],
      ["typecheck", "ran", null, false],
    ]);
  });
});
