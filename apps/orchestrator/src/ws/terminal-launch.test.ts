import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encryptSecret,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  repository,
  secret,
  session,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { eq } from "drizzle-orm";
import { resolveTerminalLaunch } from "./terminal.js";

beforeAll(() => {
  process.env.SOLOW_SECRET_KEY = Buffer.alloc(32, 7).toString("base64");
});

const WS = "ws-alpha";
const TOKEN = "sk-ant-oat01-terminal";
const HOST = {
  HOME: "/home/op",
  PATH: "/usr/bin:/bin",
  SHELL: "/bin/zsh",
  SOLOW_SECRET_KEY: "orchestrator-only",
  SOLOW_STREAM_SECRET: "orchestrator-only",
};

async function seed(db: TestDb, protocol = "claude_code_stream_json") {
  await db.insert(workspace).values({ id: WS, name: "Alpha", ownerUserId: "user-1" });
  await db.insert(secret).values({
    id: "sec-1",
    workspaceId: WS,
    name: "claude-token",
    kind: "subscription_token",
    ciphertext: encryptSecret(TOKEN),
  });
  await db.insert(harnessCatalog).values({
    id: "cat-1",
    workspaceId: WS,
    key: "claude_code",
    displayName: "Claude Code",
    protocol: protocol as "claude_code_stream_json",
    command: "claude",
    subscriptionEnvVar: "CLAUDE_CODE_OAUTH_TOKEN",
    meteredEnvVar: "ANTHROPIC_API_KEY",
  });
  await db.insert(harnessProfile).values({
    id: "ap-1",
    workspaceId: WS,
    name: "Default Claude",
    agentCatalogId: "cat-1",
    authMode: "subscription",
    secretId: "sec-1",
    model: "claude-opus-5-5",
  });
  await db
    .insert(executorProfile)
    .values({ id: "ex-1", workspaceId: WS, name: "Local", kind: "local" });
  await db.insert(repository).values({
    id: "repo-1",
    workspaceId: WS,
    name: "solow",
    source: "local_path",
    location: "/srv/repos/solow",
  });
  await db.insert(issue).values({ id: "iss-1", workspaceId: WS, title: "Fix the gate" });
  await db.insert(task).values({
    id: "task-1",
    workspaceId: WS,
    issueId: "iss-1",
    title: "Implement gate fix",
    state: "review",
    agentProfileId: "ap-1",
    executorProfileId: "ex-1",
  });
  await db.insert(taskRepository).values({
    id: "attach-1",
    workspaceId: WS,
    taskId: "task-1",
    repositoryId: "repo-1",
    baseRef: "main",
    checkoutBranch: "solow/task-task-1",
    position: 0,
  });
}

const idle = { get: () => undefined };
const claims = { workspaceId: WS, taskId: "task-1", cwd: "/wt/task-1" };

/** Put a conversation file where Claude Code keeps one, under `configDir`. */
function storeConversation(configDir: string, conversation: string): void {
  const project = join(configDir, "projects", "-wt-solow-task-1");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, `${conversation}.jsonl`), "{}\n");
}

function deps(db: TestDb, registry: { get: () => unknown } = idle) {
  return {
    db,
    registry: registry as Parameters<typeof resolveTerminalLaunch>[0]["registry"],
    worktreeRoot: mkdtempSync(join(tmpdir(), "solow-terminal-")),
  };
}

describe("resolveTerminalLaunch", () => {
  it("mounts the task's newest conversation in the harness's own TUI, under the run's home and credential", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(session).values([
      {
        id: "sess-1",
        workspaceId: WS,
        taskId: "task-1",
        harnessSessionId: "conv-old",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        id: "sess-2",
        workspaceId: WS,
        taskId: "task-1",
        harnessSessionId: "conv-new",
        startedAt: "2026-02-01T00:00:00.000Z",
      },
    ]);
    const d = deps(db);
    storeConversation(join(d.worktreeRoot, "task-1--harness-home", ".claude"), "conv-new");

    const launch = await resolveTerminalLaunch(d, claims, HOST);

    expect(launch.mode).toBe("chat");
    expect(launch.cmd).toEqual([
      "claude",
      "--resume",
      "conv-new",
      "--setting-sources",
      "project,local",
      "--model",
      "claude-opus-5-5",
    ]);
    // The run's app-owned home, so the stored conversation is the one found.
    expect(launch.env.HOME).toBe(join(d.worktreeRoot, "task-1--harness-home"));
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(
      join(d.worktreeRoot, "task-1--harness-home", ".claude"),
    );
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    expect(launch.env.TERM).toBe("xterm-256color");
    // The orchestrator's own secrets stay with the orchestrator.
    expect(launch.env.SOLOW_SECRET_KEY).toBeUndefined();
    expect(launch.env.SOLOW_STREAM_SECRET).toBeUndefined();
    expect(launch.env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("resumes a conversation from before app-owned homes under the operator's own configuration", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-legacy",
    });
    const operatorHome = mkdtempSync(join(tmpdir(), "solow-operator-"));
    storeConversation(join(operatorHome, ".claude"), "conv-legacy");

    const launch = await resolveTerminalLaunch(deps(db), claims, { ...HOST, HOME: operatorHome });

    expect(launch.mode).toBe("chat");
    expect(launch.cmd.slice(0, 3)).toEqual(["claude", "--resume", "conv-legacy"]);
    expect(launch.env.HOME).toBe(operatorHome);
    expect(launch.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(launch.env.SOLOW_SECRET_KEY).toBeUndefined();
  });

  it("finds a conversation an earlier run left inside the worktree, and resumes it there", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-in-worktree",
    });
    const worktree = mkdtempSync(join(tmpdir(), "solow-wt-"));
    const legacyHome = join(worktree, ".solow", "worktrees", "task-1--harness-home");
    storeConversation(join(legacyHome, ".claude"), "conv-in-worktree");

    const launch = await resolveTerminalLaunch(
      { ...deps(db), worktreeRoot: ".solow/worktrees" },
      { ...claims, cwd: worktree },
      HOST,
    );

    expect(launch.mode).toBe("chat");
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe(join(legacyHome, ".claude"));
  });

  it("opens a shell when the conversation is stored nowhere on this machine", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-elsewhere",
    });
    const launch = await resolveTerminalLaunch(deps(db), claims, {
      ...HOST,
      HOME: mkdtempSync(join(tmpdir(), "solow-empty-")),
    });
    expect(launch.mode).toBe("shell");
    expect(launch.mode === "shell" && launch.reason).toContain("not stored on this machine");
  });

  it("opens a shell, and says why, while a run holds the conversation", async () => {
    const db = createTestDb();
    await seed(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-1",
    });
    const launch = await resolveTerminalLaunch(deps(db, { get: () => ({}) }), claims, HOST);
    expect(launch).toMatchObject({ mode: "shell", cmd: ["/bin/zsh", "-l"] });
    expect(launch.mode === "shell" && launch.reason).toContain(
      "working in this task's conversation",
    );
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("opens a shell before the first run has started a conversation", async () => {
    const db = createTestDb();
    await seed(db);
    const launch = await resolveTerminalLaunch(deps(db), claims, HOST);
    expect(launch.mode).toBe("shell");
    expect(launch.mode === "shell" && launch.reason).toContain("No conversation yet");
  });

  it("opens a shell for a harness whose TUI cannot resume a stored conversation", async () => {
    const db = createTestDb();
    await seed(db, "acp");
    await db
      .update(harnessCatalog)
      .set({ displayName: "OpenCode" })
      .where(eq(harnessCatalog.id, "cat-1"));
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-1",
    });
    const launch = await resolveTerminalLaunch(deps(db), claims, HOST);
    expect(launch.mode).toBe("shell");
    expect(launch.mode === "shell" && launch.reason).toContain("OpenCode has no conversation");
  });
});
