import { beforeEach, describe, expect, it } from "bun:test";

// The secret store reads SOLOW_SECRET_KEY lazily (via the validated env module),
// so setting it before the first encryptSecret call is sufficient. 32 bytes, base64.
process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

import { encryptSecret, type issue, secret, type taskRepository, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { issueToDto, NO_TASKS, repositoryToDto, secretToRef, taskToDto } from "./mappers.js";

type IssueRow = typeof issue.$inferSelect;
type TaskRepositoryRow = typeof taskRepository.$inferSelect;

describe("mappers", () => {
  describe("issueToDto", () => {
    it("projects exactly the DTO fields and injects the taskCount", () => {
      const row: IssueRow = {
        id: "issue-1",
        workspaceId: "ws-1",
        title: "Latch fix",
        description: "sticks in rain",
        statusOverride: null,
        statusOverrideAt: null,
        statusOverrideBy: null,
        source: "local",
        integrationId: null,
        repositoryId: null,
        externalId: null,
        externalNumber: null,
        externalUrl: null,
        syncedAt: null,
        labels: ["hardware"],
        linkedChangeRequests: [],
        assignees: [],
        milestone: null,
        externalState: null,
        externalParentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };

      const dto = issueToDto(row, {
        taskCount: 3,
        activeTaskCount: 1,
        derivedStatus: "in_progress",
      });
      expect(dto).toEqual({
        id: "issue-1",
        title: "Latch fix",
        description: "sticks in rain",
        // No override on the row, so the Issue reads whatever its Tasks derived to.
        status: "in_progress",
        derivedStatus: "in_progress",
        statusOverride: null,
        statusOverrideAt: null,
        taskCount: 3,
        activeTaskCount: 1,
        source: "local",
        repositoryId: null,
        externalNumber: null,
        externalUrl: null,
        // Carried so an issue *list* can draw the hierarchy the project table already draws.
        externalId: null,
        externalParentId: null,
        syncedAt: null,
        labels: ["hardware"],
        linkedChangeRequests: [],
        assignees: [],
        milestone: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      });
      // workspaceId (tenant key) and the internal integrationId FK are deliberately NOT part of
      // the DTO — the client sees the provider-facing externalNumber/externalUrl instead.
      expect(Object.keys(dto)).not.toContain("workspaceId");
      expect(Object.keys(dto)).not.toContain("integrationId");
    });

    it("preserves a null description, and carries an imported Issue's provider reference", () => {
      const row: IssueRow = {
        id: "issue-2",
        workspaceId: "ws-1",
        title: "No details",
        description: null,
        statusOverride: "closed",
        statusOverrideAt: "2026-01-04T00:00:00.000Z",
        statusOverrideBy: "user-1",
        source: "github",
        integrationId: "int-1",
        repositoryId: "repo-1",
        externalId: "9001",
        externalNumber: 42,
        externalUrl: "https://github.com/acme/gate/issues/42",
        syncedAt: "2026-01-03T00:00:00.000Z",
        labels: [],
        linkedChangeRequests: [],
        assignees: [],
        milestone: null,
        externalState: null,
        externalParentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const dto = issueToDto(row, NO_TASKS);
      expect(dto.description).toBeNull();
      expect(dto.source).toBe("github");
      expect(dto.repositoryId).toBe("repo-1");
      expect(dto.externalNumber).toBe(42);
      expect(dto.externalUrl).toBe("https://github.com/acme/gate/issues/42");
      expect(dto.syncedAt).toBe("2026-01-03T00:00:00.000Z");
      expect(dto.labels).toEqual([]);
    });

    it("lets a manual override win over the derived status, and reports both", () => {
      const row: IssueRow = {
        id: "issue-3",
        workspaceId: "ws-1",
        title: "Abandoned",
        description: null,
        statusOverride: "closed",
        statusOverrideAt: "2026-01-04T00:00:00.000Z",
        statusOverrideBy: "user-1",
        source: "local",
        integrationId: null,
        repositoryId: null,
        externalId: null,
        externalNumber: null,
        externalUrl: null,
        syncedAt: null,
        labels: [],
        linkedChangeRequests: [],
        assignees: [],
        milestone: null,
        externalState: null,
        externalParentId: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };

      const dto = issueToDto(row, {
        taskCount: 2,
        activeTaskCount: 2,
        derivedStatus: "in_progress",
      });
      // Both halves travel: the detail view says "Closed" but can still explain what the Tasks
      // say underneath it (spec F01 FR-7).
      expect(dto.status).toBe("closed");
      expect(dto.derivedStatus).toBe("in_progress");
      expect(dto.statusOverride).toBe("closed");
      expect(dto.statusOverrideAt).toBe("2026-01-04T00:00:00.000Z");
      expect(dto.activeTaskCount).toBe(2);
      // Who set it is recorded on the row but is not client-facing.
      expect(Object.keys(dto)).not.toContain("statusOverrideBy");
    });
  });

  describe("taskToDto", () => {
    const taskRow = {
      id: "task-1",
      workspaceId: "ws-1",
      issueId: "issue-1",
      title: "Do the thing",
      state: "running" as const,
      agentProfileId: "agent-1",
      executorProfileId: "exec-1",
      failureReason: null,
      completedAt: null,
      completedOutcome: null,
      completedSummary: null,
      // A Task on no Workflow, which is every Task that exists today (issue #5).
      workflowId: null,
      workflowStepId: null,
      workflowVersion: null,
      workflowHandoff: null,
      workflowPendingHandoff: null,
      workflowDecisionId: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const attachment = (overrides: Partial<TaskRepositoryRow> = {}): TaskRepositoryRow => ({
      id: "att-1",
      workspaceId: "ws-1",
      taskId: "task-1",
      repositoryId: "repo-1",
      baseRef: "main",
      checkoutBranch: "solow/task-task-1",
      resultBranch: null,
      position: 0,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      ...overrides,
    });

    it("projects the task fields without workspaceId", () => {
      const dto = taskToDto(taskRow, [attachment()]);
      expect(dto.id).toBe("task-1");
      expect(dto.state).toBe("running");
      expect(Object.keys(dto)).not.toContain("workspaceId");
    });

    it("carries every attachment, and the attachment's tenant key never reaches the DTO", () => {
      // The join row is workspace-scoped like everything else; the DTO is what a browser sees,
      // and a tenant key on it would be a leak nobody would notice (Principle V).
      const dto = taskToDto(taskRow, [
        attachment(),
        attachment({ id: "att-2", repositoryId: "repo-2", position: 1, baseRef: null }),
      ]);
      expect(dto.repositories.map((r) => r.repositoryId)).toEqual(["repo-1", "repo-2"]);
      expect(dto.repositories[1]?.baseRef).toBeNull();
      for (const entry of dto.repositories) {
        expect(Object.keys(entry)).not.toContain("workspaceId");
        expect(Object.keys(entry)).not.toContain("taskId");
      }
    });

    it("puts the attachments in position order whatever order the rows arrive in", () => {
      // `repositories[0]` is the primary attachment — the worktree the agent is started in — so
      // position order is a promise the DTO makes to every consumer. The read path sorts in SQL,
      // but `task.create` and `task.setRepositories` map the rows `INSERT … RETURNING` handed
      // back, whose order SQLite documents as undefined.
      const dto = taskToDto(taskRow, [
        attachment({ id: "att-2", repositoryId: "repo-2", position: 1 }),
        attachment({ id: "att-1", repositoryId: "repo-1", position: 0 }),
      ]);
      expect(dto.repositories.map((r) => r.repositoryId)).toEqual(["repo-1", "repo-2"]);
    });
  });

  describe("repositoryToDto", () => {
    it("projects the repository fields without workspaceId", () => {
      const dto = repositoryToDto({
        id: "repo-1",
        workspaceId: "ws-1",
        name: "solow",
        source: "local_path",
        location: "/srv/repos/solow",
        integrationId: null,
        externalFullName: null,
        issuesSyncedAt: null,
        syncStaleSince: null,
        syncStaleReason: null,
        setupFilePatterns: [".env"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(dto).toEqual({
        id: "repo-1",
        name: "solow",
        source: "local_path",
        location: "/srv/repos/solow",
        integrationId: null,
        externalFullName: null,
        provider: null,
        integrationBaseUrl: null,
        issueCount: 0,
        setupFilePatterns: [".env"],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(Object.keys(dto)).not.toContain("workspaceId");
    });

    it("carries the joined provider, base URL and issue count when a caller supplies them", () => {
      const dto = repositoryToDto(
        {
          id: "repo-1",
          workspaceId: "ws-1",
          name: "solow",
          source: "remote_url",
          location: "https://gitlab.example.com/acme/gate.git",
          integrationId: "int-1",
          externalFullName: "acme/gate",
          issuesSyncedAt: null,
          syncStaleSince: null,
          syncStaleReason: null,
          setupFilePatterns: [],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
        { provider: "gitlab", integrationBaseUrl: "https://gitlab.example.com", issueCount: 7 },
      );
      expect(dto.provider).toBe("gitlab");
      expect(dto.integrationBaseUrl).toBe("https://gitlab.example.com");
      expect(dto.issueCount).toBe(7);
    });
  });

  // Principle IV: a secret's ciphertext must never surface through a mapper/DTO.
  describe("secretToRef", () => {
    let db: TestDb;

    beforeEach(() => {
      db = createTestDb();
    });

    it("returns only { id, name, kind } and never the ciphertext", async () => {
      const [ws] = await db
        .insert(workspace)
        .values({ name: "acme", ownerUserId: "owner-1" })
        .returning();
      if (!ws) throw new Error("failed to seed workspace");

      const ciphertext = encryptSecret("super-secret-token");
      const [row] = await db
        .insert(secret)
        .values({
          workspaceId: ws.id,
          name: "anthropic-key",
          kind: "api_key",
          ciphertext,
        })
        .returning();
      if (!row) throw new Error("failed to seed secret");

      // Precondition: the stored row really does carry the ciphertext.
      expect(row.ciphertext).toBe(ciphertext);
      expect(row.ciphertext.length).toBeGreaterThan(0);

      const ref = secretToRef(row);
      expect(ref).toEqual({ id: row.id, name: "anthropic-key", kind: "api_key", usedBy: [] });
      expect(Object.keys(ref).sort()).toEqual(["id", "kind", "name", "usedBy"]);
      expect(ref).not.toHaveProperty("ciphertext");
      // The plaintext must not appear anywhere in the serialized ref either.
      expect(JSON.stringify(ref)).not.toContain("super-secret-token");
      expect(JSON.stringify(ref)).not.toContain(ciphertext);
    });

    it("does not mutate the source row (ciphertext stays on the row)", async () => {
      const [ws] = await db
        .insert(workspace)
        .values({ name: "acme", ownerUserId: "owner-1" })
        .returning();
      if (!ws) throw new Error("failed to seed workspace");
      await db.insert(secret).values({
        workspaceId: ws.id,
        name: "k",
        kind: "subscription_token",
        ciphertext: encryptSecret("v"),
      });
      const [row] = await db
        .select()
        .from(secret)
        .where(and(eq(secret.workspaceId, ws.id), eq(secret.name, "k")));
      if (!row) throw new Error("secret not found");
      secretToRef(row);
      expect(row.ciphertext.length).toBeGreaterThan(0);
    });
  });
});
