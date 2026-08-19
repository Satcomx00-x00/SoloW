import { beforeEach, describe, expect, it } from "bun:test";

// The secret store reads GATECONTROL_SECRET_KEY lazily (via the validated env module),
// so setting it before the first encryptSecret call is sufficient. 32 bytes, base64.
process.env.GATECONTROL_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");

import { encryptSecret, type issue, secret, workspace } from "@gatecontrol/db";
import { createTestDb, type TestDb } from "@gatecontrol/db/testing";
import { and, eq } from "drizzle-orm";
import { issueToDto, repositoryToDto, secretToRef, taskToDto } from "./mappers.js";

type IssueRow = typeof issue.$inferSelect;

describe("mappers", () => {
  describe("issueToDto", () => {
    it("projects exactly the DTO fields and injects the taskCount", () => {
      const row: IssueRow = {
        id: "issue-1",
        workspaceId: "ws-1",
        title: "Latch fix",
        description: "sticks in rain",
        status: "open",
        source: "local",
        integrationId: null,
        repositoryId: null,
        externalId: null,
        externalNumber: null,
        externalUrl: null,
        syncedAt: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-02T00:00:00.000Z",
      };

      const dto = issueToDto(row, 3);
      expect(dto).toEqual({
        id: "issue-1",
        title: "Latch fix",
        description: "sticks in rain",
        status: "open",
        taskCount: 3,
        source: "local",
        repositoryId: null,
        externalNumber: null,
        externalUrl: null,
        syncedAt: null,
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
        status: "closed",
        source: "github",
        integrationId: "int-1",
        repositoryId: "repo-1",
        externalId: "9001",
        externalNumber: 42,
        externalUrl: "https://github.com/acme/gate/issues/42",
        syncedAt: "2026-01-03T00:00:00.000Z",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      };
      const dto = issueToDto(row, 0);
      expect(dto.description).toBeNull();
      expect(dto.source).toBe("github");
      expect(dto.repositoryId).toBe("repo-1");
      expect(dto.externalNumber).toBe(42);
      expect(dto.externalUrl).toBe("https://github.com/acme/gate/issues/42");
      expect(dto.syncedAt).toBe("2026-01-03T00:00:00.000Z");
    });
  });

  describe("taskToDto", () => {
    it("projects the task fields without workspaceId", () => {
      const dto = taskToDto({
        id: "task-1",
        workspaceId: "ws-1",
        issueId: "issue-1",
        title: "Do the thing",
        state: "running",
        agentProfileId: "agent-1",
        executorProfileId: "exec-1",
        repositoryId: "repo-1",
        baseRef: "main",
        resultBranch: null,
        failureReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(dto.id).toBe("task-1");
      expect(dto.state).toBe("running");
      expect(Object.keys(dto)).not.toContain("workspaceId");
    });
  });

  describe("repositoryToDto", () => {
    it("projects the repository fields without workspaceId", () => {
      const dto = repositoryToDto({
        id: "repo-1",
        workspaceId: "ws-1",
        name: "gatecontrol",
        source: "local_path",
        location: "/srv/repos/gatecontrol",
        integrationId: null,
        externalFullName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(dto).toEqual({
        id: "repo-1",
        name: "gatecontrol",
        source: "local_path",
        location: "/srv/repos/gatecontrol",
        integrationId: null,
        externalFullName: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      });
      expect(Object.keys(dto)).not.toContain("workspaceId");
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
      expect(ref).toEqual({ id: row.id, name: "anthropic-key", kind: "api_key" });
      expect(Object.keys(ref).sort()).toEqual(["id", "kind", "name"]);
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
