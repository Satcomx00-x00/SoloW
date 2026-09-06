/// <reference types="bun-types" />

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AgentLibraryErrorCode, CommonErrorCode, WorkflowErrorCode } from "@solow/contracts";
import { ensureDefaultAgentCatalog, workspace } from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { zipSync } from "fflate";
import { findMcpTool } from "../mcp/tools.js";
import { resetRateLimits } from "../rate-limit.js";
import type { BaseContext } from "../trpc.js";
import { appRouter } from "./index.js";

/**
 * The agent libraries (spec F24) against a real in-memory database: the two tables, the
 * per-Workspace name index, the Secret references, and the Step selections that point at them.
 */

function caller(db: TestDb, workspaceId: string, flags?: Partial<BaseContext["flagOverrides"]>) {
  return appRouter.createCaller({
    db,
    session: { workspaceId, userId: "user-1" },
    flagOverrides: {
      "ff-core-program": true,
      "ff-agent-libraries": true,
      "ff-workflows": true,
      ...flags,
    },
  } satisfies BaseContext);
}

async function errMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
    return "OK";
  } catch (e) {
    return (e as { message?: string }).message ?? String(e);
  }
}

async function fixture(db: TestDb, name: string) {
  const [ws] = await db
    .insert(workspace)
    .values({ name, ownerUserId: `owner-${name}` })
    .returning();
  if (!ws) throw new Error("failed to seed workspace");
  const c = caller(db, ws.id);
  const { secret } = await c.secret.set({ name: "gh-token", kind: "api_key", value: "ghp_x" });
  return { wsId: ws.id, c, secretId: secret.id };
}

const github = (secretId: string) => ({
  name: "github",
  description: "GitHub over MCP",
  transport: {
    kind: "stdio" as const,
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_TOKEN: { kind: "secret" as const, secretId } },
  },
});

describe("agent libraries", () => {
  let db: TestDb;
  beforeAll(async () => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 7).toString("base64");
    // Where an unpacked archive lands: a temp directory, never the default `.solow/skills`
    // under whatever directory the test runner started in.
    process.env.SOLOW_SKILLS_ROOT = await mkdtemp(join(tmpdir(), "solow-skills-root-"));
  });
  beforeEach(async () => {
    db = await createTestDb();
    resetRateLimits();
  });

  describe("MCP servers", () => {
    it("stores a server with a secret reference, never the secret's value", async () => {
      const { c, secretId } = await fixture(db, "acme");
      const created = await c.library.mcp.create(github(secretId));
      expect(created.enabled).toBe(false);
      expect(created.transport).toEqual({
        kind: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        env: { GITHUB_TOKEN: { kind: "secret", secretId } },
      });
      expect(JSON.stringify(await c.library.mcp.list({}))).not.toContain("ghp_x");
    });

    it("switches a server on for every agent, and off again", async () => {
      const { c, secretId } = await fixture(db, "acme");
      const created = await c.library.mcp.create(github(secretId));
      expect((await c.library.mcp.update({ id: created.id, enabled: true })).enabled).toBe(true);
      expect((await c.library.mcp.list({}))[0]?.enabled).toBe(true);
      expect((await c.library.mcp.update({ id: created.id, enabled: false })).enabled).toBe(false);
    });

    it("refuses two servers with one name, and a rename onto a taken one", async () => {
      const { c, secretId } = await fixture(db, "acme");
      await c.library.mcp.create(github(secretId));
      const other = await c.library.mcp.create({
        name: "docs",
        transport: { kind: "http", url: "https://docs.example/mcp", headers: {} },
      });
      expect(await errMessage(() => c.library.mcp.create(github(secretId)))).toBe(
        AgentLibraryErrorCode.NameTaken,
      );
      expect(await errMessage(() => c.library.mcp.update({ id: other.id, name: "github" }))).toBe(
        AgentLibraryErrorCode.NameTaken,
      );
    });

    it("refuses a reference to another Workspace's secret, on create and on update", async () => {
      const acme = await fixture(db, "acme");
      const rival = await fixture(db, "rival");
      expect(await errMessage(() => acme.c.library.mcp.create(github(rival.secretId)))).toBe(
        AgentLibraryErrorCode.NotInWorkspace,
      );
      const mine = await acme.c.library.mcp.create(github(acme.secretId));
      expect(
        await errMessage(() =>
          acme.c.library.mcp.update({ id: mine.id, transport: github(rival.secretId).transport }),
        ),
      ).toBe(AgentLibraryErrorCode.NotInWorkspace);
      // And the rival cannot see or touch it.
      expect(await rival.c.library.mcp.list({})).toEqual([]);
      expect(await errMessage(() => rival.c.library.mcp.delete({ id: mine.id }))).toBe(
        CommonErrorCode.NotFound,
      );
    });
  });

  describe("Skills", () => {
    it("stores an inline skill and a directory-backed one, and lists them by name", async () => {
      const { c } = await fixture(db, "acme");
      await c.library.skill.create({
        name: "review-checklist",
        description: "How we review",
        source: { kind: "inline", body: "# Review\n\nCheck the tests." },
        enabled: true,
      });
      await c.library.skill.create({
        name: "deploy",
        description: "Deploy runbook",
        source: { kind: "path", path: "/srv/skills/deploy" },
      });
      const listed = await c.library.skill.list({});
      expect(listed.map((s) => [s.name, s.enabled])).toEqual([
        ["deploy", false],
        ["review-checklist", true],
      ]);
    });

    it("refuses a name that is not a slug — it becomes a directory on the agent's side", async () => {
      const { c } = await fixture(db, "acme");
      expect(
        await errMessage(() =>
          c.library.skill.create({
            name: "Review Checklist",
            description: "x",
            source: { kind: "inline", body: "y" },
          }),
        ),
      ).not.toBe("OK");
    });
  });

  describe("Workflow Steps naming library items", () => {
    async function pipeline(c: ReturnType<typeof caller>, secretId: string) {
      const catalogId = await ensureDefaultAgentCatalog(db, (await c.workspace.get({})).id);
      const profile = await c.profile.agent.create({
        name: "Opus",
        agentCatalogId: catalogId,
        authMode: "api_key",
        secretId,
        concurrencyCap: 1,
      });
      const wf = await c.workflow.create({ name: "Ship" });
      const withStep = await c.workflow.addStep({
        workflowId: wf.id,
        name: "Review",
        agentProfileId: profile.id,
      });
      const step = withStep.steps[0];
      if (!step) throw new Error("pipeline");
      return { wf, step };
    }

    it("round-trips a Step's selections, de-duplicated, and reads them back on the binding", async () => {
      const { c, secretId } = await fixture(db, "acme");
      const server = await c.library.mcp.create(github(secretId));
      const skill = await c.library.skill.create({
        name: "review-checklist",
        description: "x",
        source: { kind: "inline", body: "y" },
      });
      const { wf, step } = await pipeline(c, secretId);
      const updated = await c.workflow.updateStep({
        stepId: step.id,
        mcpServerIds: [server.id, server.id],
        skillIds: [skill.id],
      });
      expect(updated.steps[0]?.mcpServerIds).toEqual([server.id]);
      expect(updated.steps[0]?.skillIds).toEqual([skill.id]);
      expect(updated.version).toBe(wf.version + 2);
      // Sending the same lists again changes nothing and bumps nothing.
      const again = await c.workflow.updateStep({ stepId: step.id, mcpServerIds: [server.id] });
      expect(again.version).toBe(updated.version);
    });

    it("refuses a Step naming an item that is not in this Workspace", async () => {
      const acme = await fixture(db, "acme");
      const rival = await fixture(db, "rival");
      const theirs = await rival.c.library.mcp.create(github(rival.secretId));
      const { step } = await pipeline(acme.c, acme.secretId);
      expect(
        await errMessage(() =>
          acme.c.workflow.updateStep({ stepId: step.id, mcpServerIds: [theirs.id] }),
        ),
      ).toBe(WorkflowErrorCode.ToolNotInWorkspace);
      expect(
        await errMessage(() =>
          acme.c.workflow.updateStep({ stepId: step.id, skillIds: ["not-a-skill"] }),
        ),
      ).toBe(WorkflowErrorCode.ToolNotInWorkspace);
    });

    it("refuses to delete an item a Step still names, and allows it once the Step lets go", async () => {
      const { c, secretId } = await fixture(db, "acme");
      const server = await c.library.mcp.create(github(secretId));
      const { step } = await pipeline(c, secretId);
      await c.workflow.updateStep({ stepId: step.id, mcpServerIds: [server.id] });
      expect(await errMessage(() => c.library.mcp.delete({ id: server.id }))).toBe(
        AgentLibraryErrorCode.InUse,
      );
      await c.workflow.updateStep({ stepId: step.id, mcpServerIds: [] });
      expect(await c.library.mcp.delete({ id: server.id })).toEqual([]);
    });
  });

  describe("bulk import", () => {
    let tree: string;
    beforeEach(async () => {
      tree = await mkdtemp(join(tmpdir(), "solow-skills-"));
      for (const [path, body] of [
        [
          "skills/review/SKILL.md",
          "---\nname: review-checklist\ndescription: How we review\n---\n",
        ],
        ["skills/review/scripts/check.sh", "#!/bin/sh"],
        ["skills/deploy/SKILL.md", "# Deploy\n\nHow we ship.\n"],
      ] as const) {
        await mkdir(join(tree, path, ".."), { recursive: true });
        await writeFile(join(tree, path), body);
      }
    });
    afterEach(() => rm(tree, { recursive: true, force: true }));

    it("scans a directory, marks what the library already holds, and imports the rest as directory sources", async () => {
      const { c } = await fixture(db, "acme");
      await c.library.skill.create({
        name: "deploy",
        description: "ours",
        source: { kind: "inline", body: "# ours" },
      });

      const scan = await c.library.skill.scan({ source: { kind: "path", path: tree } });
      expect(scan.root).toBe(tree);
      expect(scan.skills.map((s) => [s.name, s.description, s.files, s.existing])).toEqual([
        ["deploy", "How we ship.", 1, true],
        ["review-checklist", "How we review", 2, false],
      ]);

      const result = await c.library.skill.import({
        skills: scan.skills.map(({ name, description, path }) => ({ name, description, path })),
        enabled: true,
      });
      expect(result.skipped).toEqual(["deploy"]);
      expect(result.imported.map((s) => [s.name, s.enabled, s.source])).toEqual([
        ["review-checklist", true, { kind: "path", path: join(tree, "skills", "review") }],
      ]);
      // The library's own deploy is untouched.
      const list = await c.library.skill.list({});
      expect(list.find((s) => s.name === "deploy")?.source).toEqual({
        kind: "inline",
        body: "# ours",
      });
    });

    it("skips a directory that lost its SKILL.md between the scan and the import", async () => {
      const { c } = await fixture(db, "acme");
      const scan = await c.library.skill.scan({ source: { kind: "path", path: tree } });
      await rm(join(tree, "skills", "deploy"), { recursive: true });
      const result = await c.library.skill.import({
        skills: scan.skills.map(({ name, description, path }) => ({ name, description, path })),
      });
      expect(result.skipped).toEqual(["deploy"]);
      expect(result.imported.map((s) => s.name)).toEqual(["review-checklist"]);
    });

    it("unpacks a dropped zip and imports what it holds, from SoloW's own skills directory", async () => {
      const { c } = await fixture(db, "acme");
      const zip = zipSync({
        "skills/triage/SKILL.md": new TextEncoder().encode("# Triage\n\nHow we triage.\n"),
        "skills/triage/references/labels.md": new TextEncoder().encode("# Labels"),
      });
      const scan = await c.library.skill.unpack({
        fileName: "team.zip",
        zipBase64: Buffer.from(zip).toString("base64"),
      });
      expect(scan.skills.map((s) => [s.name, s.description, s.files, s.existing])).toEqual([
        ["triage", "How we triage.", 2, false],
      ]);
      expect(basename(scan.root)).toBe("team");
      const result = await c.library.skill.import({
        skills: scan.skills.map(({ name, description, path }) => ({ name, description, path })),
      });
      expect(result.imported.map((s) => s.source)).toEqual([
        { kind: "path", path: join(scan.root, "skills", "triage") },
      ]);
      expect(
        await errMessage(() =>
          c.library.skill.unpack({ fileName: "x.zip", zipBase64: "bm9wZQ==" }),
        ),
      ).toBe(AgentLibraryErrorCode.ImportArchiveInvalid);
    });

    it("says when the source is not there, and when a repository cannot be cloned", async () => {
      const { c } = await fixture(db, "acme");
      expect(
        await errMessage(() =>
          c.library.skill.scan({ source: { kind: "path", path: join(tree, "nope") } }),
        ),
      ).toBe(AgentLibraryErrorCode.ImportSourceNotFound);
      expect(
        await errMessage(() => c.library.skill.scan({ source: { kind: "git", url: "nope" } })),
      ).toBe(AgentLibraryErrorCode.ImportCloneFailed);
    });
  });

  it("is withheld from the external MCP surface, and refused when the flag is off", async () => {
    // A token an agent holds must not be able to hand that agent a new server.
    expect(findMcpTool("library_mcp_create")).toBeUndefined();
    expect(findMcpTool("library_skill_list")).toBeUndefined();

    const [ws] = await db.insert(workspace).values({ name: "off", ownerUserId: "o" }).returning();
    const off = caller(db, ws?.id ?? "", { "ff-agent-libraries": false });
    expect(await errMessage(() => off.library.mcp.list({}))).toBe(CommonErrorCode.FlagDisabled);
  });
});
