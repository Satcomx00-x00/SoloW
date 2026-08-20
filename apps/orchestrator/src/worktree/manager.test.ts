import { describe, expect, it } from "bun:test";
import { taskCheckoutBranch } from "@gatecontrol/core";
import type { ExecOpts, ExecResult, Executor } from "../executor/types.js";
import { prepareRepository, worktreeBranch, worktreePath } from "./manager.js";

describe("worktree naming", () => {
  it("branch and path are deterministic and task-scoped", () => {
    expect(worktreeBranch("t1")).toBe("gatecontrol/task-t1");
    expect(worktreePath("/wt", "t1")).toBe("/wt/t1");
    expect(worktreeBranch("a")).not.toBe(worktreeBranch("b"));
  });

  it("delegates the branch name to core, so three call sites cannot disagree", () => {
    // The DAL derives this when an attachment names no branch and the 0010 migration wrote it;
    // a second copy of the template here would be a silent divergence waiting to happen.
    expect(worktreeBranch("t1")).toBe(taskCheckoutBranch("t1"));
  });

  it("gives a secondary attachment its own sibling directory (issue #7)", () => {
    // Keyed on the attachment, not the repository: a future second branch of the *same*
    // repository already has a directory of its own, and no Owner-authored text — a repository
    // called `../../etc` — ever reaches the path.
    expect(worktreePath("/wt", "t1", "att-2")).toBe("/wt/t1--att-2");
    expect(worktreePath("/wt", "t1", "att-2")).not.toBe(worktreePath("/wt", "t1", "att-3"));
    // And the primary keeps exactly the path a single-Repository Task has always had.
    expect(worktreePath("/wt", "t1", undefined)).toBe(worktreePath("/wt", "t1"));
  });
});

const TOKEN = "glpat-do-not-leak-me";

interface Call {
  cmd: string[];
  opts: ExecOpts;
}

/**
 * An Executor that records commands instead of running them. Enough to assert the *shape* of the
 * clone — which is where the credential handling lives — without standing up an authenticating
 * git server.
 */
function recordingExecutor(calls: Call[], cacheExists = false): Executor {
  return {
    async exec(cmd: string[], opts: ExecOpts = {}): Promise<ExecResult> {
      calls.push({ cmd, opts });
      // `test -f <cache>/.git/HEAD` decides whether a clone is needed at all.
      const isCacheProbe = cmd[0] === "test";
      const exitCode = isCacheProbe && !cacheExists ? 1 : 0;
      return { stdout: "", stderr: "", exitCode };
    },
    spawn: () => {
      throw new Error("not used");
    },
    fs: {
      exists: async () => false,
      readFile: async () => "",
      writeFile: async () => {},
      list: async () => [],
      copy: async () => {},
    },
    forward: async () => ({ url: "", close: async () => {} }),
    metrics: async () => ({
      cpuPercent: null,
      memPercent: null,
      diskPercent: null,
      loadAverage: [],
    }),
    dispose: async () => {},
  };
}

const remoteParams = {
  taskId: "t1",
  repository: { source: "remote_url" as const, location: "https://gitlab.com/acme/gate.git" },
  worktreeRoot: "/wt",
  repoCacheRoot: "/cache",
};

describe("cloning an imported repository", () => {
  it("passes the token through the environment, never through the command line", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    const clone = calls.find((c) => c.cmd.includes("clone"));
    expect(clone).toBeDefined();

    // The whole point: `ps` shows argv to every user on the box, so the token must not be there.
    // It also must not reach the URL, which git would write into .git/config permanently.
    expect(clone?.cmd.join(" ")).not.toContain(TOKEN);
    expect(clone?.cmd).toContain("https://gitlab.com/acme/gate.git");
    expect(clone?.opts.env?.GATECONTROL_SCM_TOKEN).toBe(TOKEN);
  });

  it("clears any host credential helper before installing its own", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "x-access-token", token: TOKEN },
    });

    const args = calls.find((c) => c.cmd.includes("clone"))?.cmd ?? [];
    const helpers = args.filter((a) => a.startsWith("credential.helper="));
    // The empty one first, so a credential cached on the host cannot win over this
    // Integration's token; then the helper that reads the environment variable.
    expect(helpers[0]).toBe("credential.helper=");
    expect(helpers[1]).toContain("username=x-access-token");
    expect(helpers[1]).toContain("$GATECONTROL_SCM_TOKEN");
  });

  it("disables git's terminal prompt so a bad token fails instead of hanging", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    // Without this git blocks on a username prompt no one is there to answer, and the Task
    // waits forever rather than reporting that the credential is wrong.
    expect(calls.find((c) => c.cmd.includes("clone"))?.opts.env?.GIT_TERMINAL_PROMPT).toBe("0");
  });

  it("clones a public repository with no credential arguments at all", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), remoteParams);

    const clone = calls.find((c) => c.cmd.includes("clone"));
    expect(clone?.cmd).toEqual([
      "git",
      "clone",
      "https://gitlab.com/acme/gate.git",
      "/cache/https%3A%2F%2Fgitlab.com%2Facme%2Fgate.git",
    ]);
    expect(clone?.opts.env).toBeUndefined();
  });

  it("does not clone again when the repository is already in the cache", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls, true), {
      ...remoteParams,
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    expect(calls.some((c) => c.cmd.includes("clone"))).toBe(false);
  });

  it("never reaches for a credential for a local path", async () => {
    const calls: Call[] = [];
    await prepareRepository(recordingExecutor(calls), {
      taskId: "t1",
      repository: { source: "local_path", location: "/srv/repos/gate" },
      worktreeRoot: "/wt",
      repoCacheRoot: "/cache",
      cloneCredential: { username: "oauth2", token: TOKEN },
    });

    expect(calls.some((c) => c.cmd.includes("clone"))).toBe(false);
    expect(JSON.stringify(calls)).not.toContain(TOKEN);
  });
});
