/// <reference types="bun-types" />

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFakeClaudeBin } from "@solow/claude-code/testing";
import type { ExecutorConfig, HarnessProtocol } from "@solow/contracts";
import { signStreamTicket } from "@solow/core/stream";
import {
  encryptSecret,
  executorProfile,
  harnessCatalog,
  harnessProfile,
  issue,
  repository,
  secret,
  task,
  taskRepository,
  workspace,
} from "@solow/db";
import { createTestDb, type TestDb } from "@solow/db/testing";
import { and, eq } from "drizzle-orm";
import { CONTAINER_HOME, containerName, deploymentId, SPAWN_SHIM } from "./executor/docker.js";
import { openOutOfBandExecutor } from "./executor/factory.js";
import { createLocalExecutor } from "./executor/local.js";
import type { ExecResult, Executor, ProcessHandle } from "./executor/types.js";
import {
  handleAnnouncePost,
  handleExplainPost,
  handleProbePost,
  type OutOfBandLaunch,
} from "./index.js";

/**
 * `POST /announce` — the notification path for a change the API made itself.
 *
 * The hub lives in this process and the web app does not, so a person moving a card told only
 * their own browser. Everything below is about the one rule that keeps that from being a tenancy
 * hole: the Workspace and Task come from the ticket's signed claims, never from the body.
 */
describe("handleAnnouncePost", () => {
  const SECRET = "announce-secret";
  const NOW = 1_700_000_000_000;
  const deps = { now: () => NOW, streamSecret: SECRET };

  const post = (body: unknown) =>
    handleAnnouncePost(
      new Request("http://orchestrator/announce", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      deps,
    );

  const ticketFor = (workspaceId: string, taskId: string | null) =>
    signStreamTicket({ workspaceId, taskId }, SECRET, NOW);

  it("accepts a valid task ticket", async () => {
    const res = await post({ ticket: ticketFor("ws-1", "task-1"), state: "review" });

    expect(res.status).toBe(202);
  });

  it("refuses a ticket it cannot verify", async () => {
    const res = await post({
      ticket: signStreamTicket({ workspaceId: "ws-1", taskId: "task-1" }, "other-secret", NOW),
      state: "review",
    });

    expect(res.status).toBe(401);
  });

  it("refuses an expired ticket", async () => {
    const stale = signStreamTicket(
      { workspaceId: "ws-1", taskId: "task-1" },
      SECRET,
      NOW - 600_000,
    );

    const res = await post({ ticket: stale, state: "review" });

    expect(res.status).toBe(401);
  });

  it("refuses a board-scoped ticket, which names no Task to announce about", async () => {
    const res = await post({ ticket: ticketFor("ws-1", null), state: "review" });

    expect(res.status).toBe(400);
  });

  it("refuses a body that is not a valid announcement", async () => {
    expect((await post({ ticket: ticketFor("ws-1", "task-1"), state: "not-a-state" })).status).toBe(
      400,
    );
    expect((await post({ state: "review" })).status).toBe(400);
  });
});

/**
 * `POST /probe-agent` — "does this Harness Profile actually work?", asked before a Task depends on
 * the answer (2026-08-28).
 *
 * Two rules carry the weight. The tenancy one is the same as `/announce`: the Workspace comes
 * from the signed ticket, never the body, so a caller cannot probe another tenant's harness. The
 * other is specific to this route and is why it is authenticated at all — it launches a binary
 * an Owner named, with that Owner's credential in its environment. An unauthenticated version
 * would be remote command execution with a wallet attached.
 */
describe("handleProbePost", () => {
  const SECRET = "probe-secret";
  const NOW = 1_700_000_000_000;
  let db: TestDb;

  beforeAll(() => {
    // Set here rather than inherited from whichever test file ran first: `prepareHarnessEnv`
    // decrypts the Profile's Secret, and a suite that only passes after a neighbour's
    // `beforeAll` is a suite that fails when run alone.
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
  });

  beforeEach(() => {
    db = createTestDb();
  });

  const deps = () => ({
    db,
    now: () => NOW,
    streamSecret: SECRET,
    // No executor is named in this block, so every launch is the host's and the roots are
    // never read; a container launch is driven in the block below.
    outOfBand: (profile: { config: ExecutorConfig } | null, opts: OutOfBandLaunch) =>
      openOutOfBandExecutor(profile, {
        ...opts,
        worktreeRoot: "/unused",
        repoCacheRoot: "/unused",
      }),
  });

  const post = (body: unknown) =>
    handleProbePost(
      new Request("http://orchestrator/probe-agent", {
        method: "POST",
        body: JSON.stringify(body),
      }),
      deps(),
    );

  const ticketFor = (workspaceId: string) =>
    signStreamTicket({ workspaceId, taskId: null }, SECRET, NOW);

  /** A fake harness: a shell script doing exactly what the test needs (Principle VI). */
  async function fakeHarness(body: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "solow-probe-route-"));
    const path = join(dir, "fake-harness");
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
    return path;
  }

  async function seedProfile(
    workspaceId: string,
    opts: { command: string; protocol: HarnessProtocol; profileId?: string },
  ): Promise<string> {
    const profileId = opts.profileId ?? `ap-${workspaceId}`;
    await db.insert(workspace).values({ id: workspaceId, name: "WS", ownerUserId: "owner" });
    await db.insert(secret).values({
      id: `sec-${workspaceId}`,
      workspaceId,
      name: "sub",
      kind: "subscription_token",
      ciphertext: encryptSecret("oauth-token"),
    });
    await db.insert(harnessCatalog).values({
      id: `cat-${workspaceId}`,
      workspaceId,
      key: "probe-me",
      displayName: "Probe Me",
      protocol: opts.protocol,
      command: opts.command,
      argsTemplate: [],
      subscriptionEnvVar: "SUB_TOKEN",
      meteredEnvVar: "API_KEY",
    });
    await db.insert(harnessProfile).values({
      id: profileId,
      workspaceId,
      name: "Mine",
      agentCatalogId: `cat-${workspaceId}`,
      authMode: "subscription",
      secretId: `sec-${workspaceId}`,
      concurrencyCap: 1,
    });
    return profileId;
  }

  it("refuses a ticket it cannot verify, before touching the database", async () => {
    const res = await post({
      ticket: signStreamTicket({ workspaceId: "ws-1", taskId: null }, "other-secret", NOW),
      agentProfileId: "ap-ws-1",
    });

    expect(res.status).toBe(401);
  });

  it("reads a Profile from another Workspace as absent, never as someone else's harness", async () => {
    // Principle V, at the one route that would otherwise start a stranger's binary.
    await seedProfile("ws-1", { command: "/bin/true", protocol: "cli_passthrough" });

    const res = await post({ ticket: ticketFor("ws-2"), agentProfileId: "ap-ws-1" });

    expect(res.status).toBe(404);
  });

  it("reports a working harness, and caches what it advertises", async () => {
    const command = await fakeHarness("sleep 5");
    const id = await seedProfile("ws-1", { command, protocol: "cli_passthrough" });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reason: null });
  });

  it("launches the harness without the orchestrator's own secrets in its environment", async () => {
    // The probe spawns an Owner-named binary; the environment it inherits must be the same
    // scrubbed base a run gets (`Executor.baseEnv()`), not `process.env` with the key that
    // decrypts every stored Secret still in it.
    const planted = {
      SOLOW_ORCHESTRATOR_SECRET: "orch-secret-value",
      SOLOW_STREAM_SECRET: "stream-secret-value",
      SOLOW_AUTH_SECRET: "auth-secret-value",
      INNGEST_SIGNING_KEY: "signing-key-value",
      INNGEST_EVENT_KEY: "event-key-value",
    };
    Object.assign(process.env, planted);
    const out = join(await mkdtemp(join(tmpdir(), "solow-probe-env-")), "env");
    try {
      const command = await fakeHarness(`env > '${out}'\nsleep 5`);
      const id = await seedProfile("ws-1", { command, protocol: "cli_passthrough" });

      const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

      expect(res.status).toBe(200);
      const seen = await readFile(out, "utf8");
      expect(seen).toContain("SUB_TOKEN=oauth-token");
      for (const name of ["SOLOW_SECRET_KEY", ...Object.keys(planted)]) {
        expect(seen).not.toContain(`${name}=`);
      }
    } finally {
      for (const name of Object.keys(planted)) delete process.env[name];
    }
  });

  it("answers with a readable reason rather than an error status when the harness is missing", async () => {
    // The failure an Owner actually hits. A 500 here would put the reason in a server log
    // instead of on the screen of the person who can fix it.
    const id = await seedProfile("ws-1", {
      command: "/nonexistent/harness-binary",
      protocol: "cli_passthrough",
    });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; reason: string };
    expect(body.ok).toBe(false);
    expect(body.reason).toContain("installed and on PATH");
  });

  it("proves the credential only when asked for a turn (the setup's test run)", async () => {
    // Claude Code starts with any token at all — the bare probe passes on a rejected one, which
    // is why the guided setup asks for a turn: the provider only reads the credential on a prompt.
    const dir = await mkdtemp(join(tmpdir(), "solow-probe-turn-"));
    const command = await writeFakeClaudeBin(dir, {
      turns: [{ text: ["Failed to authenticate. API Error: 401 OAuth access token is invalid."] }],
      failWith: "success",
    });
    const id = await seedProfile("ws-1", { command, protocol: "claude_code_stream_json" });

    const bare = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });
    expect(await bare.json()).toMatchObject({ ok: true });

    const turned = await post({ ticket: ticketFor("ws-1"), agentProfileId: id, turn: true });
    expect(turned.status).toBe(200);
    expect(await turned.json()).toMatchObject({
      ok: false,
      failure: "credential",
      answered: false,
    });
  });

  it("reports an answered turn as the proof it is", async () => {
    const dir = await mkdtemp(join(tmpdir(), "solow-probe-turn-"));
    const command = await writeFakeClaudeBin(dir, { turns: [{ text: ["ready"] }] });
    const id = await seedProfile("ws-1", { command, protocol: "claude_code_stream_json" });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id, turn: true });

    expect(await res.json()).toMatchObject({ ok: true, answered: true });
  });

  it("fills the capability cache from the handshake, with no run needed", async () => {
    // The half of this feature that is not about failure: the pin pickers were empty until a
    // first Task completed, so the ordering was "commit work, then find out what you could
    // have chosen". A probe inverts it.
    const command = await fakeHarness(`
      while IFS= read -r line; do
        case "$line" in
          *'"initialize"'*) printf '{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":1}}\n' ;;
          *'"session/new"'*) printf '{"jsonrpc":"2.0","id":2,"result":{"sessionId":"s1","configOptions":[{"id":"model","category":"model","options":[{"value":"m-a"},{"value":"m-b"}]},{"id":"mode","category":"mode","options":[{"value":"plan"}]}]}}\n' ;;
        esac
      done`);
    const id = await seedProfile("ws-1", { command, protocol: "acp" });

    const res = await post({ ticket: ticketFor("ws-1"), agentProfileId: id });

    expect(await res.json()).toMatchObject({
      ok: true,
      capabilities: { models: ["m-a", "m-b"], modes: ["plan"] },
    });
    const [row] = await db
      .select()
      .from(harnessCatalog)
      .where(and(eq(harnessCatalog.workspaceId, "ws-1"), eq(harnessCatalog.id, "cat-ws-1")))
      .limit(1);
    expect(row?.capabilities).toEqual({ models: ["m-a", "m-b"], modes: ["plan"] });
  });
});

/**
 * The two out-of-band launches, where the Task runs (roadmap B4).
 *
 * A Docker Executor Profile used to change nothing about either route: Explain and the guided
 * setup's test both started the harness on the orchestrator's host. These drive both through the
 * real container driver against a fake host that records argv and stands in for one container —
 * `docker exec … env -i /bin/sh -c <shim> …` is carried out on this machine, shim and all, so the
 * environment really does arrive on the exec's stdin and the fake harness really does answer.
 * Everything else the daemon says is scripted, the way `docker.test.ts` scripts it.
 */
describe("an out-of-band launch on a Docker Executor Profile", () => {
  const SECRET = "probe-secret";
  const NOW = 1_700_000_000_000;
  const IMAGE = "solow-executor:test";
  let db: TestDb;
  let worktreeRoot: string;

  beforeAll(() => {
    process.env.SOLOW_SECRET_KEY ??= Buffer.alloc(32, 3).toString("base64");
    // `dockerOpts` reads the deployment's settings, and refuses to parse without this.
    process.env.SOLOW_STREAM_SECRET ??= "test-stream-secret";
  });

  beforeEach(async () => {
    db = createTestDb();
    worktreeRoot = await mkdtemp(join(tmpdir(), "solow-oob-root-"));
  });

  interface Daemon {
    executor: Executor;
    /** Every argv handed to the host, `exec` and `spawn` alike, in order. */
    calls: string[][];
    /** Everything written to a spawned exec's stdin — where the environment travels. */
    stdin: string[];
  }

  /**
   * One container's worth of daemon. `overrides` answer a matching argv first, so a case states
   * only the answer it is about; the rest is the creation path followed by adoption, as the
   * preflight and then the driver's own `ready()` see it.
   */
  function fakeDaemon(overrides: Array<[RegExp, Partial<ExecResult>]> = []): Daemon {
    const calls: string[][] = [];
    const stdin: string[] = [];
    const pids = new Map<string, string>();
    let container: { name: string; cfg: string; run: string } | undefined;
    const pidDir = mkdtempSync(join(tmpdir(), "solow-oob-pids-"));
    const answer = (cmd: string[]): Partial<ExecResult> => {
      const line = cmd.join(" ");
      for (const [pattern, result] of overrides) if (pattern.test(line)) return result;
      if (cmd[0] === "realpath") return { stdout: `${cmd[3]}\n` };
      if (cmd[0] !== "docker") return {};
      if (cmd[1] === "version") return { stdout: "29.7.2\n" };
      if (cmd[1] === "image" && line.includes("json .Config.Env")) {
        return { stdout: `${JSON.stringify([`PATH=${process.env.PATH}`])}\n` };
      }
      if (cmd[1] === "image") return { stdout: "sha256:d15c0ffee\n" };
      if (cmd[1] === "ps") return { stdout: container ? "c0ffee\n" : "" };
      if (cmd[1] === "run") {
        const label = (key: string) =>
          cmd.find((arg) => arg.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
        container = {
          name: cmd[cmd.indexOf("--name") + 1] ?? "",
          cfg: label("solow.cfg"),
          run: label("solow.run"),
        };
        return { stdout: "c0ffee\n" };
      }
      if (cmd[1] === "inspect") {
        return {
          stdout: line.includes("solow.cfg")
            ? `true|${container?.cfg}|${container?.run}|/${container?.name}\n`
            : "true 0\n",
        };
      }
      if (cmd[1] === "rm") container = undefined;
      // The pid the shim recorded, and the signal the kill ladder sends to it: the two `docker
      // exec`s that reach inside the container, carried out against the local process.
      const inner = cmd.slice(cmd.indexOf(container?.name ?? "\0") + 1);
      if (inner[0] === "cat" && inner[1]?.endsWith(".pid")) {
        return { stdout: pids.has(inner[1]) ? readFileSync(pids.get(inner[1]) ?? "", "utf8") : "" };
      }
      if (inner[0] === "kill") {
        try {
          process.kill(Number(inner[3]), `SIG${inner[2]}`);
        } catch {
          // Already gone, which is the ordinary case.
        }
      }
      return {};
    };
    const executor: Executor = {
      async exec(cmd) {
        calls.push(cmd);
        return { stdout: "", stderr: "", exitCode: 0, ...answer(cmd) };
      },
      spawn(cmd, opts): ProcessHandle {
        calls.push(cmd);
        // `docker exec -i --user … -w <cwd> <name> env -i /bin/sh -c <shim> sh <pidfile> …cmd`,
        // run here with the same shim: `env -i` becomes the empty environment `spawn` replaces
        // with, and the pid file moves somewhere this machine can write.
        const shim = cmd.indexOf(SPAWN_SHIM);
        const pidFile = cmd[shim + 2] ?? "";
        const local = join(pidDir, pidFile.split("/").pop() ?? "pid");
        pids.set(pidFile, local);
        const handle = createLocalExecutor(opts.cwd).spawn(
          ["/bin/sh", "-c", SPAWN_SHIM, "sh", local, ...cmd.slice(shim + 3)],
          { cwd: cmd[cmd.indexOf("-w") + 1] ?? opts.cwd, env: {} },
        );
        const write = handle.stdin.write.bind(handle.stdin);
        handle.stdin.write = (data) => {
          stdin.push(data);
          return write(data);
        };
        return handle;
      },
      async baseEnv() {
        throw new Error("a container's environment is the image's, never the host executor's");
      },
      fs: {} as Executor["fs"],
      forward: async () => {
        throw new Error("unused");
      },
      metrics: async () => {
        throw new Error("unused");
      },
      async dispose() {},
    };
    return { executor, calls, stdin };
  }

  const depsWith = (daemon: Daemon) => ({
    db,
    now: () => NOW,
    streamSecret: SECRET,
    outOfBand: (profile: { config: ExecutorConfig } | null, opts: OutOfBandLaunch) =>
      openOutOfBandExecutor(profile, {
        ...opts,
        worktreeRoot,
        repoCacheRoot: join(worktreeRoot, "..", "repos"),
        host: daemon.executor,
      }),
  });

  /** The environment preamble the shim decoded, back as text. */
  const preambles = (daemon: Daemon) =>
    daemon.stdin
      .filter((chunk) => /^[A-Za-z0-9+/=]+\n$/.test(chunk))
      .map((chunk) => Buffer.from(chunk.trim(), "base64").toString("utf8"));

  async function seedWorkspace(workspaceId: string, command: string): Promise<void> {
    await db.insert(workspace).values({ id: workspaceId, name: "WS", ownerUserId: "owner" });
    await db.insert(secret).values({
      id: `sec-${workspaceId}`,
      workspaceId,
      name: "sub",
      kind: "subscription_token",
      ciphertext: encryptSecret("oauth-token-in-the-container"),
    });
    await db.insert(harnessCatalog).values({
      id: `cat-${workspaceId}`,
      workspaceId,
      key: "claude_code",
      displayName: "Claude Code",
      protocol: "claude_code_stream_json",
      command,
      argsTemplate: [],
      subscriptionEnvVar: "SUB_TOKEN",
      meteredEnvVar: "API_KEY",
    });
    await db.insert(harnessProfile).values({
      id: `ap-${workspaceId}`,
      workspaceId,
      name: "Mine",
      agentCatalogId: `cat-${workspaceId}`,
      authMode: "subscription",
      secretId: `sec-${workspaceId}`,
      concurrencyCap: 1,
    });
    await db.insert(executorProfile).values({
      id: `ex-${workspaceId}`,
      workspaceId,
      name: "Isolated container",
      kind: "docker",
      config: { kind: "docker", image: IMAGE, mounts: [], env: { FROM_PROFILE: "yes" } },
    });
  }

  const probe = (daemon: Daemon, body: Record<string, unknown>) =>
    handleProbePost(
      new Request("http://orchestrator/probe-agent", {
        method: "POST",
        body: JSON.stringify({
          ticket: signStreamTicket({ workspaceId: "ws-1", taskId: null }, SECRET, NOW),
          agentProfileId: "ap-ws-1",
          ...body,
        }),
      }),
      depsWith(daemon),
    );

  async function fakeClaude(script: Parameters<typeof writeFakeClaudeBin>[1]): Promise<string> {
    return writeFakeClaudeBin(await mkdtemp(join(tmpdir(), "solow-oob-claude-")), script);
  }

  const runLine = (daemon: Daemon) => daemon.calls.find((cmd) => cmd[1] === "run") ?? [];

  it("tests the setup in a one-shot container of the profile's image, and removes it", async () => {
    await seedWorkspace("ws-1", await fakeClaude({ turns: [{ text: ["ready"] }] }));
    const daemon = fakeDaemon();

    const res = await probe(daemon, { turn: true, executorProfileId: "ex-ws-1" });

    expect(await res.json()).toMatchObject({ ok: true, answered: true });
    const run = runLine(daemon);
    const name = run[run.indexOf("--name") + 1] ?? "";
    expect(name).toMatch(/^solow-oneshot-/);
    expect(run).toContain("solow.role=oneshot");
    expect(run).toContain(IMAGE);
    // The scratch directory is the one thing mounted, and it is gone with the container.
    const mounts = run.filter((_, i) => run[i - 1] === "--mount");
    expect(mounts).toHaveLength(1);
    const scratch = mounts[0]?.match(/source=([^,]+)/)?.[1] ?? "";
    expect(scratch.startsWith(`${worktreeRoot}/.solow-probe-`)).toBe(true);
    expect(existsSync(scratch)).toBe(false);
    expect(daemon.calls.at(-1)).toEqual(["docker", "rm", "-f", name]);
    // Both launches — the probe and its turn — went into that container.
    const spawned = daemon.calls.filter((cmd) => cmd[1] === "exec" && cmd.includes(SPAWN_SHIM));
    expect(spawned).toHaveLength(2);
    for (const cmd of spawned) expect(cmd[cmd.indexOf("-w") + 2]).toBe(name);
  });

  it("hands the credential over the way a run does — on the exec's stdin, under the container's HOME", async () => {
    await seedWorkspace("ws-1", await fakeClaude({ turns: [{ text: ["ready"] }] }));
    const daemon = fakeDaemon();

    await probe(daemon, { turn: true, executorProfileId: "ex-ws-1" });

    const [preamble] = preambles(daemon);
    expect(preamble).toContain("export 'SUB_TOKEN'='oauth-token-in-the-container'");
    // The container's own tmpfs home (`CONTAINER_HOME`), not a host path inside the scratch
    // directory, which does not exist in there — the run's `resolveHarnessConfigEnv` rule.
    expect(preamble).toContain(`export 'HOME'='${CONTAINER_HOME}'`);
    expect(preamble).toContain(`export 'CLAUDE_CONFIG_DIR'='${CONTAINER_HOME}/.claude'`);
    expect(preamble).toContain("export 'FROM_PROFILE'='yes'");
    for (const cmd of daemon.calls) {
      expect(cmd.some((arg) => arg.includes("oauth-token-in-the-container"))).toBe(false);
    }
  });

  it("keeps Settings' bare probe on the host: no executor named, no daemon asked", async () => {
    await seedWorkspace("ws-1", await fakeClaude({ turns: [{ text: ["ready"] }] }));
    const daemon = fakeDaemon();

    const res = await probe(daemon, { turn: true });

    expect(await res.json()).toMatchObject({ ok: true, answered: true });
    expect(daemon.calls).toEqual([]);
  });

  it("reads another Workspace's executor as absent, before any daemon is asked", async () => {
    await seedWorkspace("ws-1", await fakeClaude({}));
    await db.insert(workspace).values({ id: "ws-2", name: "Other", ownerUserId: "someone" });
    await db.insert(executorProfile).values({
      id: "ex-ws-2",
      workspaceId: "ws-2",
      name: "Theirs",
      kind: "docker",
      config: { kind: "docker", image: "theirs:1", mounts: [], env: {} },
    });
    const daemon = fakeDaemon();

    const res = await probe(daemon, { turn: true, executorProfileId: "ex-ws-2" });

    expect(res.status).toBe(404);
    expect(daemon.calls).toEqual([]);
  });

  it("fails the test as an executor problem when the image is not there", async () => {
    await seedWorkspace("ws-1", await fakeClaude({}));
    const daemon = fakeDaemon([
      [/image inspect .* \{\{\.Id\}\}/, { exitCode: 1, stderr: "No such image" }],
      [/ pull /, { exitCode: 1, stderr: "pull access denied for solow-executor" }],
    ]);

    const res = await probe(daemon, { turn: true, executorProfileId: "ex-ws-1" });

    const body = (await res.json()) as { ok: boolean; failure: string; reason: string };
    expect(body).toMatchObject({ ok: false, failure: "executor" });
    expect(body.reason).toContain(`could not obtain image "${IMAGE}"`);
    // The run's preflight refused before a container existed, so there is nothing to start.
    expect(runLine(daemon)).toEqual([]);
    expect(daemon.calls.some((cmd) => cmd.includes(SPAWN_SHIM))).toBe(false);
  });

  it("names the image, not the host, when the harness binary is missing from it", async () => {
    const command = await fakeClaude({});
    await seedWorkspace("ws-1", command);
    // The probe loop prints what it could not find. The harness's own probe is the one call
    // whose last argument is the harness — the utilities' ends with `kill`.
    const missing = fakeDaemon([
      [
        new RegExp(`for c in .* ${command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
        { stdout: `${command}\n` },
      ],
    ]);

    const res = await probe(missing, { turn: true, executorProfileId: "ex-ws-1" });

    const body = (await res.json()) as { ok: boolean; failure: string; reason: string };
    expect(body).toMatchObject({ ok: false, failure: "missing" });
    expect(body.reason).toContain("not found in the executor image");
    const name = runLine(missing)[runLine(missing).indexOf("--name") + 1] ?? "";
    expect(missing.calls.at(-1)).toEqual(["docker", "rm", "-f", name]);
  });

  it("explains in a one-shot container, and never names the Task's own", async () => {
    await seedWorkspace(
      "ws-1",
      await fakeClaude({ turns: [{ text: ["Because the test asked."] }] }),
    );
    await db.insert(repository).values({
      id: "repo-1",
      workspaceId: "ws-1",
      name: "app",
      source: "local_path",
      location: "/srv/repos/app",
    });
    await db.insert(issue).values({ id: "iss-1", workspaceId: "ws-1", title: "An issue" });
    await db.insert(task).values({
      id: "task-1",
      workspaceId: "ws-1",
      issueId: "iss-1",
      title: "A task",
      state: "running",
      agentProfileId: "ap-ws-1",
      executorProfileId: "ex-ws-1",
    });
    await db.insert(taskRepository).values({
      id: "attach-1",
      workspaceId: "ws-1",
      taskId: "task-1",
      repositoryId: "repo-1",
      baseRef: "main",
      checkoutBranch: "solow/task-task-1",
      position: 0,
    });
    const daemon = fakeDaemon();

    const res = await handleExplainPost(
      new Request("http://orchestrator/explain", {
        method: "POST",
        body: JSON.stringify({
          ticket: signStreamTicket({ workspaceId: "ws-1", taskId: "task-1" }, SECRET, NOW),
          taskId: "task-1",
          system: "Explain.",
          prompt: "Why?",
        }),
      }),
      depsWith(daemon),
    );

    expect(await res.json()).toMatchObject({ ok: true, text: "Because the test asked." });
    const taskContainer = containerName(
      { workspaceId: "ws-1", taskId: "task-1" },
      deploymentId(worktreeRoot),
    );
    for (const cmd of daemon.calls) expect(cmd).not.toContain(taskContainer);
    const run = runLine(daemon);
    expect(run).toContain("solow.task=task-1");
    expect(run).toContain("solow.role=oneshot");
    // No worktree, no repository: the scratch directory is all an explanation is given.
    expect(run.filter((_, i) => run[i - 1] === "--mount")).toHaveLength(1);
    expect(daemon.calls.at(-1)?.slice(0, 3)).toEqual(["docker", "rm", "-f"]);
  });
});
