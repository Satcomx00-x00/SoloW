/// <reference types="bun-types" />

import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HARNESS_CONFIG_ENV_VARS } from "@solow/contracts";
import { harnessHomePath } from "../worktree/manager.js";
import { harnessConfigEnv, needsAppOwnedHome, resolveHarnessConfigEnv } from "./hermetic-home.js";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

const fresh = async () => {
  root = await mkdtemp(join(tmpdir(), "solow-hermetic-"));
  return root;
};

describe("harnessConfigEnv — where the harness is told to look for its configuration", () => {
  it("points every configuration variable inside the home it is given", () => {
    const env = harnessConfigEnv("/srv/wt/task_1--harness-home");
    expect(env).toEqual({
      HOME: "/srv/wt/task_1--harness-home",
      XDG_CONFIG_HOME: "/srv/wt/task_1--harness-home/.config",
      XDG_DATA_HOME: "/srv/wt/task_1--harness-home/.local/share",
      XDG_CACHE_HOME: "/srv/wt/task_1--harness-home/.cache",
      XDG_STATE_HOME: "/srv/wt/task_1--harness-home/.local/state",
      CLAUDE_CONFIG_DIR: "/srv/wt/task_1--harness-home/.claude",
    });
  });

  it("names exactly the variables the contract declares, and nothing else", () => {
    // The list is the contract's, so the guard that drops these same names from an Executor
    // Profile's environment and the module that produces them cannot drift apart.
    expect(Object.keys(harnessConfigEnv("/h")).sort()).toEqual([...HARNESS_CONFIG_ENV_VARS].sort());
  });

  it("leaves PATH and the rest of the environment out of it entirely", () => {
    // Isolating configuration discovery, not the environment: a harness with no `PATH` cannot
    // run its own tools, and a `LANG` of the host's is not a configuration leak.
    const env = harnessConfigEnv("/h");
    for (const name of ["PATH", "LANG", "TERM", "HTTPS_PROXY", "NODE_ENV"]) {
      expect(env).not.toHaveProperty(name);
    }
  });
});

describe("needsAppOwnedHome — which drivers answer the question themselves", () => {
  it("says no for docker, whose own base environment is already a disposable tmpfs", () => {
    expect(needsAppOwnedHome("docker")).toBe(false);
  });

  it("says yes for local, whose base environment is a person's own account", () => {
    expect(needsAppOwnedHome("local")).toBe(true);
  });
});

describe("resolveHarnessConfigEnv — the environment a run is actually given", () => {
  it("creates the home and returns an environment rooted in it", async () => {
    const dir = await fresh();
    const home = harnessHomePath(dir, "task_1");

    const env = await resolveHarnessConfigEnv({
      kind: "local",
      home,
      baseEnv: { HOME: "/home/operator", PATH: "/usr/bin" },
    });

    expect(env["HOME"]).toBe(home);
    expect(env["CLAUDE_CONFIG_DIR"]).toBe(join(home, ".claude"));
    expect((await stat(home)).isDirectory()).toBe(true);
    // Seeded blank on purpose: the app's own configuration reaches the harness on its command
    // line (`--mcp-config`, `--plugin-dir`, `--settings`), never by being written in here.
    expect(await readdir(join(home, ".claude"))).toEqual([]);
  });

  it("is idempotent, because every round of a Task reaches it again", async () => {
    const dir = await fresh();
    const home = harnessHomePath(dir, "task_1");
    const first = await resolveHarnessConfigEnv({ kind: "local", home, baseEnv: {} });
    // Something the first round's harness left behind must survive the second round's call, or
    // resuming a conversation would start from a home that had been emptied underneath it.
    await writeFile(join(home, ".claude", "kept.json"), "{}", "utf8");
    const second = await resolveHarnessConfigEnv({ kind: "local", home, baseEnv: {} });

    expect(second).toEqual(first);
    expect(await readdir(join(home, ".claude"))).toEqual(["kept.json"]);
  });

  it("takes the container's own HOME for a docker run, and creates nothing on the host", async () => {
    const dir = await fresh();
    const home = harnessHomePath(dir, "task_1");

    const env = await resolveHarnessConfigEnv({
      kind: "docker",
      home,
      baseEnv: { HOME: "/home/solow", PATH: "/usr/bin" },
    });

    expect(env["HOME"]).toBe("/home/solow");
    expect(env["CLAUDE_CONFIG_DIR"]).toBe("/home/solow/.claude");
    // A host path handed to a container names a directory that does not exist inside it, and a
    // second host directory is a mount this decision deliberately does not add.
    await expect(stat(home)).rejects.toThrow();
  });

  it("imposes nothing when a container declares no HOME at all, rather than inventing one", async () => {
    const dir = await fresh();
    const env = await resolveHarnessConfigEnv({
      kind: "docker",
      home: harnessHomePath(dir, "task_1"),
      baseEnv: { PATH: "/usr/bin" },
    });
    expect(env).toEqual({});
  });

  it("still isolates the configuration when the directory cannot be created", async () => {
    const dir = await fresh();
    // A file where the directory has to go, so `mkdir` cannot win. The environment is the
    // guarantee and the directory is a courtesy: the harness makes its own config directory
    // anywhere it has not run before, and what must not happen — the run falling back to the
    // operator's `$HOME` — still does not happen. A root that is genuinely unwritable is caught
    // by `git worktree add`, which needs the same root and fails first.
    const blocked = join(dir, "blocked");
    await writeFile(blocked, "not a directory", "utf8");
    const home = join(blocked, "home");

    const env = await resolveHarnessConfigEnv({ kind: "local", home, baseEnv: {} });
    expect(env["HOME"]).toBe(home);
    expect(env["HOME"]).not.toBe(process.env["HOME"]);
  });
});

describe("resolveHarnessConfigEnv — a home a relative root put inside the worktree", () => {
  const conversation = async (home: string, id: string, body = "{}\n") => {
    const project = join(home, ".claude", "projects", "-wt");
    await mkdir(project, { recursive: true });
    await writeFile(join(project, `${id}.jsonl`), body);
  };

  it("hands the harness an absolute home, whatever it was given", async () => {
    root = await mkdtemp(join(tmpdir(), "solow-home-"));
    const env = await resolveHarnessConfigEnv({
      kind: "local",
      home: ".solow/worktrees/task-1--harness-home",
      baseEnv: {},
    });
    expect(isAbsolute(env.HOME ?? "")).toBe(true);
    expect(isAbsolute(env.CLAUDE_CONFIG_DIR ?? "")).toBe(true);
  });

  it("copies an earlier round's home out of the worktree once, so --resume still finds the conversation", async () => {
    root = await mkdtemp(join(tmpdir(), "solow-home-"));
    const home = join(root, "real", "task-1--harness-home");
    const legacy = join(root, "worktree", ".solow", "worktrees", "task-1--harness-home");
    await conversation(legacy, "conv-1");

    await resolveHarnessConfigEnv({ kind: "local", home, baseEnv: {}, legacyHomes: [legacy] });

    expect(await readFile(join(home, ".claude", "projects", "-wt", "conv-1.jsonl"), "utf8")).toBe(
      "{}\n",
    );
    // The worktree's copy is the operator's to remove; it is not moved.
    expect((await stat(join(legacy, ".claude", "projects"))).isDirectory()).toBe(true);
  });

  it("never overwrites a home that has conversations of its own", async () => {
    root = await mkdtemp(join(tmpdir(), "solow-home-"));
    const home = join(root, "real", "task-1--harness-home");
    const legacy = join(root, "worktree", "task-1--harness-home");
    await conversation(home, "conv-1", "newer\n");
    await conversation(legacy, "conv-1", "older\n");

    await resolveHarnessConfigEnv({ kind: "local", home, baseEnv: {}, legacyHomes: [legacy] });

    expect(await readFile(join(home, ".claude", "projects", "-wt", "conv-1.jsonl"), "utf8")).toBe(
      "newer\n",
    );
  });
});
