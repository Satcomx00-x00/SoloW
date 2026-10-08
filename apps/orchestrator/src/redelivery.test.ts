/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { DELIVERY_FAILED_REASON } from "@solow/core";
import {
  encryptSecret,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  integration,
  issue,
  repository,
  secret,
  session,
  sessionEvent,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { type ExternalChangeRequest, testing as scmTesting } from "@solow/scm";
import { asc, eq } from "drizzle-orm";
import { type RedeliveryDeps, redeliverTask } from "./redelivery.js";
import type { CloneCredential } from "./worktree/manager.js";

/**
 * Ship again (A1): an approval that committed and could not ship is pushed and its request opened
 * from the branch already committed — no harness, no commit — against a real in-memory database
 * and a fixture provider registered for the test.
 */

const FORGE = "fixture.redeliver";
const REMOTE = "https://forge.example/acme/gate.git";
const WS = "ws-redeliver";
const TASK = "task-redeliver";
const BRANCH = `solow/task-${TASK}`;

let db: TestDb;
let upserts: Array<{ repo: string; head: string; title: string }>;
let pushed: Array<{ upstreamPath: string; remoteUrl: string; branch: string; token: string }>;
let pushFails: string | null;
let announced: string[];

function deps(): RedeliveryDeps {
  return {
    db,
    repoCacheRoot: "/cache",
    push: async (upstreamPath, remoteUrl, branch, credential: CloneCredential) => {
      if (pushFails) throw new Error(`${pushFails} (${credential.token})`);
      pushed.push({ upstreamPath, remoteUrl, branch, token: credential.token });
    },
    announce: (_workspaceId, _taskId, state) => announced.push(state),
  };
}

async function seed(opts: {
  state?: "failed" | "done";
  reason?: string | null;
  resultBranch?: string | null;
  /** A second attachment, on a local folder with nothing to push to. */
  withLocal?: boolean;
}): Promise<void> {
  await db.insert(workspace).values({ id: WS, name: "WS", ownerUserId: "owner" });
  await db.insert(secret).values([
    {
      id: "sec-harness",
      workspaceId: WS,
      name: "sub",
      kind: "subscription_token",
      ciphertext: encryptSecret("oauth-token"),
    },
    {
      id: "sec-forge",
      workspaceId: WS,
      name: "forge-pat",
      kind: "scm_pat",
      ciphertext: encryptSecret("forge-token"),
    },
  ]);
  await db.insert(harnessCatalog).values({
    id: "cat",
    workspaceId: WS,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: "acp",
    command: "fake",
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });
  await db.insert(harnessProfile).values({
    id: "harness",
    workspaceId: WS,
    name: "Claude",
    agentCatalogId: "cat",
    authMode: "subscription",
    secretId: "sec-harness",
    concurrencyCap: 3,
  });
  await db.insert(executorProfile).values({
    id: "exec",
    workspaceId: WS,
    name: "Local",
    kind: "local",
    config: { kind: "local", env: {} },
  });
  await db
    .insert(integration)
    .values({ id: "int", workspaceId: WS, provider: FORGE, secretId: "sec-forge" });
  await db.insert(repository).values({
    id: "repo",
    workspaceId: WS,
    name: "gate",
    source: "remote_url",
    location: REMOTE,
    integrationId: "int",
    externalFullName: "acme/gate",
  });
  await db.insert(issue).values({
    id: "issue",
    workspaceId: WS,
    title: "Fix the gate",
    description: "It sticks.",
  });
  await db.insert(task).values({
    id: TASK,
    workspaceId: WS,
    issueId: "issue",
    title: "Task",
    state: opts.state ?? "failed",
    failureReason: opts.reason === undefined ? DELIVERY_FAILED_REASON : opts.reason,
    agentProfileId: "harness",
    executorProfileId: "exec",
  });
  await db.insert(taskRepository).values({
    id: "attach",
    workspaceId: WS,
    taskId: TASK,
    repositoryId: "repo",
    checkoutBranch: BRANCH,
    resultBranch: opts.resultBranch === undefined ? BRANCH : opts.resultBranch,
    position: 0,
  });
  if (opts.withLocal) {
    await db.insert(repository).values({
      id: "repo-local",
      workspaceId: WS,
      name: "notes",
      source: "local_path",
      location: "/srv/notes",
    });
    await db.insert(taskRepository).values({
      id: "attach-local",
      workspaceId: WS,
      taskId: TASK,
      repositoryId: "repo-local",
      checkoutBranch: BRANCH,
      resultBranch: BRANCH,
      position: 1,
    });
  }
  await db.insert(session).values({ id: "sess", workspaceId: WS, taskId: TASK, state: "closed" });
}

const taskRow = async () => (await db.select().from(task).where(eq(task.id, TASK)))[0];
const attachment = async () =>
  (await db.select().from(taskRepository).where(eq(taskRepository.id, "attach")))[0];
const log = async () =>
  (
    await db
      .select()
      .from(sessionEvent)
      .where(eq(sessionEvent.sessionId, "sess"))
      .orderBy(asc(sessionEvent.seq))
  ).map((row) => row.payload as { kind: string; text?: string; from?: string; to?: string });

beforeEach(() => {
  process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  db = createTestDb();
  upserts = [];
  pushed = [];
  pushFails = null;
  announced = [];
  const registered = scmTesting.register({
    id: FORGE,
    name: "Fixture Forge",
    capabilities: ["changeRequests"] as const,
    fields: [],
    changeRequestNoun: "pull request",
    driver: {
      provider: FORGE,
      authenticate: async () => ({ ok: true as const }),
      listChangeRequests: async () => [],
      upsertChangeRequest: async (_credential, repo, input) => {
        upserts.push({ repo, head: input.head, title: input.title });
        const changeRequest: ExternalChangeRequest = {
          externalId: "9",
          number: 7,
          title: input.title,
          state: "open",
          url: `https://forge.example/${repo}/pull/7`,
          headRef: input.head,
          baseRef: "main",
          authorLogin: null,
        };
        return { changeRequest, created: true };
      },
    },
  });
  expect(registered.ok).toBe(true);
});

afterEach(() => scmTesting.unregister(FORGE));

describe("Ship again", () => {
  it("pushes the committed branch, opens the request and finishes the Task", async () => {
    await seed({});

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe("done");
    expect(pushed).toEqual([
      {
        upstreamPath: `/cache/${encodeURIComponent(REMOTE)}`,
        remoteUrl: REMOTE,
        branch: BRANCH,
        token: "forge-token",
      },
    ]);
    expect(upserts).toEqual([{ repo: "acme/gate", head: BRANCH, title: "Fix the gate" }]);
    const row = await taskRow();
    expect(row?.state).toBe("done");
    expect(row?.failureReason).toBeNull();
    expect((await attachment())?.changeRequestUrl).toBe("https://forge.example/acme/gate/pull/7");
    const events = await log();
    expect(events.some((e) => e.kind === "notice" && e.text?.includes("pull request #7"))).toBe(
      true,
    );
    expect(events.some((e) => e.kind === "state" && e.from === "failed" && e.to === "done")).toBe(
      true,
    );
    expect(announced).toEqual(["done"]);
  });

  it("stays not shipped, with the new cause in the log, when the push is refused again", async () => {
    await seed({});
    pushFails = "remote: Permission denied";

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe(DELIVERY_FAILED_REASON);
    const row = await taskRow();
    expect(row?.state).toBe("failed");
    expect(row?.failureReason).toBe(DELIVERY_FAILED_REASON);
    expect(upserts).toEqual([]);
    const notice = (await log()).find((e) => e.kind === "notice")?.text ?? "";
    expect(notice).toContain("Permission denied");
    expect(notice).toContain("Ship again");
    expect(notice).not.toContain("approve again");
    // The token never reaches the session log (Principle IV).
    expect(notice).not.toContain("forge-token");
    expect(announced).toEqual(["failed"]);
  });

  it("will not push a branch the Task did not create, even when asked to ship again", async () => {
    // Ship again goes through the same ownership guard as the approval.
    await seed({ resultBranch: "main" });

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe(DELIVERY_FAILED_REASON);
    expect(pushed).toEqual([]);
    expect(upserts).toEqual([]);
    expect((await log()).find((e) => e.kind === "notice")?.text).toContain("Did not push main");
  });

  it("does nothing for a Task that is not an approval waiting to ship", async () => {
    await seed({ state: "failed", reason: "fail" });

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe("not_applicable");
    expect(pushed).toEqual([]);
    expect((await taskRow())?.state).toBe("failed");
    expect(await log()).toEqual([]);
  });

  it("leaves a local attachment alone and ships the remote one", async () => {
    await seed({ withLocal: true });

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe("done");
    expect(pushed).toHaveLength(1);
    expect(upserts).toHaveLength(1);
  });

  it("skips an attachment the approval never committed", async () => {
    await seed({ resultBranch: null, withLocal: true });

    const result = await redeliverTask(deps(), { workspaceId: WS, taskId: TASK });

    expect(result).toBe("done");
    expect(pushed).toEqual([]);
  });
});
