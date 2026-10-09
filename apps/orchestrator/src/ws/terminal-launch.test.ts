import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutorConfig } from "@solow/contracts";
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
import type { PreflightResult } from "../executor/preflight.js";
import type { Executor, TerminalHandle, TerminalOpts } from "../executor/types.js";
import {
  CONTAINER_SHELL,
  closeTerminal,
  resolveTerminalLaunch,
  startTerminal,
  type TerminalDeps,
  type TerminalWsData,
} from "./terminal.js";

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
/** This machine, with the environment the orchestrator would have. */
const onHost = (env: Record<string, string | undefined>) => ({ kind: "host" as const, env });
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

    const launch = await resolveTerminalLaunch(d, claims, onHost(HOST));

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

    const launch = await resolveTerminalLaunch(
      deps(db),
      claims,
      onHost({ ...HOST, HOME: operatorHome }),
    );

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
      onHost(HOST),
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
    const launch = await resolveTerminalLaunch(
      deps(db),
      claims,
      onHost({ ...HOST, HOME: mkdtempSync(join(tmpdir(), "solow-empty-")) }),
    );
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
    const launch = await resolveTerminalLaunch(deps(db, { get: () => ({}) }), claims, onHost(HOST));
    expect(launch).toMatchObject({ mode: "shell", cmd: ["/bin/zsh", "-l"] });
    expect(launch.mode === "shell" && launch.reason).toContain(
      "working in this task's conversation",
    );
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("opens a shell before the first run has started a conversation", async () => {
    const db = createTestDb();
    await seed(db);
    const launch = await resolveTerminalLaunch(deps(db), claims, onHost(HOST));
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
    const launch = await resolveTerminalLaunch(deps(db), claims, onHost(HOST));
    expect(launch.mode).toBe("shell");
    expect(launch.mode === "shell" && launch.reason).toContain("OpenCode has no conversation");
  });
});

/** The image's own environment, as a container's `baseEnv()` reports it. */
const IMAGE_ENV = {
  PATH: "/usr/local/bin:/usr/bin:/bin",
  HOME: "/home/solow",
  NODE_PATH: "/opt/n",
};
const inContainer = (harnessCommands: readonly string[] = ["claude"]) => ({
  kind: "container" as const,
  env: IMAGE_ENV,
  harnessCommands,
});

/** Make the seeded Task's Executor Profile a Docker one, as the DAL would write it. */
async function dockerProfile(db: TestDb): Promise<void> {
  await db
    .update(executorProfile)
    .set({
      kind: "docker",
      config: { kind: "docker", image: "solow-executor:local", mounts: [], env: {} },
    })
    .where(eq(executorProfile.id, "ex-1"));
}

describe("resolveTerminalLaunch — in the task's container", () => {
  it("mounts the conversation from the task's transcript store, under the container's own home", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-boxed",
    });
    const d = deps(db);
    // The host directory the container sees at `$HOME/.claude/projects`.
    const project = join(d.worktreeRoot, "task-1--transcripts", "-wt-task-1");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, "conv-boxed.jsonl"), "{}\n");

    const launch = await resolveTerminalLaunch(d, claims, inContainer());

    expect(launch.mode).toBe("chat");
    expect(launch.cmd.slice(0, 3)).toEqual(["claude", "--resume", "conv-boxed"]);
    // The container's home, never a host path: the run had the same one.
    expect(launch.env.HOME).toBe("/home/solow");
    expect(launch.env.CLAUDE_CONFIG_DIR).toBe("/home/solow/.claude");
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(TOKEN);
    // The image's environment is the base, so its tools work in the TUI as they do in the run.
    expect(launch.env.NODE_PATH).toBe("/opt/n");
    expect(launch.env.PATH).toBe(IMAGE_ENV.PATH);
  });

  it("never resumes from the operator's own configuration, which only this host can reach", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-host-only",
    });
    const operatorHome = mkdtempSync(join(tmpdir(), "solow-operator-"));
    storeConversation(join(operatorHome, ".claude"), "conv-host-only");

    const launch = await resolveTerminalLaunch(deps(db), claims, {
      ...inContainer(),
      env: { ...IMAGE_ENV, HOME: operatorHome },
    });

    expect(launch).toMatchObject({ mode: "shell", cmd: CONTAINER_SHELL });
    expect(launch.mode === "shell" && launch.reason).toContain("not in its transcript store");
    expect(launch.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("opens a shell in the container when the image has no such harness", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    await db.insert(session).values({
      id: "sess-1",
      workspaceId: WS,
      taskId: "task-1",
      harnessSessionId: "conv-1",
    });

    const launch = await resolveTerminalLaunch(deps(db), claims, inContainer([]));

    expect(launch).toMatchObject({ mode: "shell", cmd: CONTAINER_SHELL });
    expect(launch.mode === "shell" && launch.reason).toContain(
      "Claude Code is not installed in this task's image",
    );
  });

  it("gives the container's shell the image's environment, not this host's allowlist", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);

    const launch = await resolveTerminalLaunch(deps(db), claims, inContainer());

    expect(launch.mode).toBe("shell");
    expect(launch.cmd).toEqual(CONTAINER_SHELL);
    expect(launch.env).toMatchObject({ ...IMAGE_ENV, TERM: "xterm-256color" });
    expect(launch.mode === "shell" && launch.reason).toContain("a shell in the task's container");
  });
});

/** A socket as `startTerminal` sees one, closing the way Bun's `close` handler would. */
function fakeSocket() {
  const sent: Array<string | Uint8Array> = [];
  const socket = {
    data: {
      kind: "terminal",
      claims: { workspaceId: WS, taskId: "task-1", exp: Date.now() + 60_000 },
      cwd: "/wt/task-1",
      cols: 120,
      rows: 40,
    } as TerminalWsData,
    closedWith: null as number | null,
    send(data: string | Uint8Array) {
      sent.push(data);
    },
    close(code?: number) {
      socket.closedWith = code ?? 1000;
      closeTerminal(socket);
    },
  };
  const frames = () =>
    sent
      .filter((frame): frame is string => typeof frame === "string")
      .map((frame) => JSON.parse(frame) as Record<string, unknown>);
  const bytes = () =>
    sent
      .filter((frame): frame is Uint8Array => typeof frame !== "string")
      .map((frame) => new TextDecoder().decode(frame))
      .join("");
  return { socket, frames, bytes };
}

/** A terminal executor that records what it was asked for and answers the preflight as told. */
function fakeTerminalExecutor(
  preflight: () => Promise<PreflightResult>,
  openFails: string | null = null,
) {
  const asked: Array<{ profile: { config: ExecutorConfig }; opts: unknown }> = [];
  const opened: Array<{ cmd: string[]; opts: TerminalOpts }> = [];
  let disposed = 0;
  const executor = {
    openTerminal(cmd: string[], opts: TerminalOpts): TerminalHandle {
      if (openFails) throw new Error(openFails);
      opened.push({ cmd, opts });
      return { write() {}, resize() {}, kill() {}, exited: Promise.resolve(0) };
    },
    baseEnv: async () => IMAGE_ENV,
  } as unknown as Executor;
  const open: TerminalDeps["terminalExecutor"] = (profile, opts) => {
    asked.push({ profile, opts });
    return {
      executor,
      preflight,
      dispose: async () => {
        disposed += 1;
      },
    };
  };
  return { open, asked, opened, disposed: () => disposed };
}

function terminalDeps(db: TestDb, open: TerminalDeps["terminalExecutor"]): TerminalDeps {
  return { ...deps(db), repoCacheRoot: "/srv/repos", terminalExecutor: open };
}

describe("startTerminal — where the terminal runs", () => {
  it("opens a Docker task's terminal in its own container, on the run's mounts", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    const place = fakeTerminalExecutor(async () => ({ ok: true, harnessCommands: ["claude"] }));
    const { socket, frames, bytes } = fakeSocket();
    const d = terminalDeps(db, place.open);

    await startTerminal(socket, d);

    const [asked] = place.asked;
    expect(asked?.profile.config.kind).toBe("docker");
    // The run's placement: this Task's own clone, never the repository every Task shares.
    expect(asked?.opts).toMatchObject({
      taskId: "task-1",
      cwd: "/wt/task-1",
      harnessCommands: ["claude"],
      placement: {
        jailRoot: join(d.worktreeRoot, "task-1"),
        bindPaths: [join(d.worktreeRoot, "task-1"), join("/srv/repos", "tasks", "task-1")],
        transcriptStore: join(d.worktreeRoot, "task-1--transcripts"),
      },
    });
    expect(bytes()).toContain("Starting this task's container");
    expect(frames()).toContainEqual(expect.objectContaining({ type: "mode", mode: "shell" }));
    expect(place.opened).toHaveLength(1);
    expect(place.opened[0]?.cmd).toEqual(CONTAINER_SHELL);
    expect(place.opened[0]?.opts).toMatchObject({ cwd: "/wt/task-1", cols: 120, rows: 40 });
    expect(socket.closedWith).toBeNull();
  });

  it("says why when the container cannot start, and never opens one on this host", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    const place = fakeTerminalExecutor(async () => ({
      ok: false,
      reason: 'could not obtain image "solow-executor:local" — not found',
    }));
    const { socket, frames } = fakeSocket();

    await startTerminal(socket, terminalDeps(db, place.open));

    expect(frames()).toContainEqual({
      type: "error",
      message:
        'This task\'s container could not be started: could not obtain image "solow-executor:local" — not found',
    });
    expect(socket.closedWith).toBe(1011);
    expect(place.opened).toEqual([]);
    expect(place.disposed()).toBeGreaterThan(0);
  });

  it("gives the container back when the window closes while it is being made", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    const { socket } = fakeSocket();
    const place = fakeTerminalExecutor(async () => {
      socket.close(1000);
      return { ok: true, harnessCommands: [] };
    });

    await startTerminal(socket, terminalDeps(db, place.open));

    expect(place.opened).toEqual([]);
    // Once by the close, and once more after the preflight that may have made it after that.
    expect(place.disposed()).toBe(2);
  });

  it("ends the socket with the reason when the program cannot be started in the container", async () => {
    const db = createTestDb();
    await seed(db);
    await dockerProfile(db);
    const place = fakeTerminalExecutor(
      async () => ({ ok: true, harnessCommands: [] }),
      "invalid environment variable name: BAD-NAME",
    );
    const { socket, frames } = fakeSocket();

    // Resolves rather than rejecting: a rejection here is an `open` handler nobody awaits.
    await expect(startTerminal(socket, terminalDeps(db, place.open))).resolves.toBeUndefined();

    expect(frames()).toContainEqual({
      type: "error",
      message: "The terminal could not be started: invalid environment variable name: BAD-NAME",
    });
    expect(socket.closedWith).toBe(1011);
    expect(place.disposed()).toBeGreaterThan(0);
  });

  it("refuses a kind this build has no driver for, before anything is made", async () => {
    const db = createTestDb();
    await seed(db);
    await db
      .update(executorProfile)
      .set({ kind: "ssh", config: { kind: "ssh", host: "build-box", env: {} } as never })
      .where(eq(executorProfile.id, "ex-1"));
    const place = fakeTerminalExecutor(async () => ({ ok: true, harnessCommands: [] }));
    const { socket, frames } = fakeSocket();

    await startTerminal(socket, terminalDeps(db, place.open));

    expect(place.asked).toEqual([]);
    expect(frames()[0]).toMatchObject({ type: "error" });
    expect(socket.closedWith).toBe(1011);
  });

  it("opens a local task's terminal on this host, with no container to wait for", async () => {
    const db = createTestDb();
    await seed(db);
    const place = fakeTerminalExecutor(async () => ({ ok: true, harnessCommands: [] }));
    const { socket, bytes } = fakeSocket();

    await startTerminal(socket, terminalDeps(db, place.open));

    expect(place.asked[0]?.profile.config.kind).toBe("local");
    expect(bytes()).toBe("");
    // This host's allowlisted environment, as the local terminal always had — not an image's.
    expect(place.opened[0]?.opts.env.SOLOW_TASK_ID).toBe("task-1");
    expect(place.opened[0]?.opts.env.NODE_PATH).toBeUndefined();
  });
});
