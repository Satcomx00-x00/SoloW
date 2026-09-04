import { describe, expect, it } from "bun:test";
import type { ExecOpts, ExecResult, Executor } from "../executor/types.js";
import { parseNumstatZ, parsePorcelainV2, readScmStatus } from "./status.js";

/**
 * Every fixture in this file was produced by running the command against a real repository and
 * piping it through `tr '\0' '\n'` — not written from the manual. Porcelain v2's two traps (a
 * rename spanning two NUL-delimited fields in *both* commands) are exactly the kind of thing a
 * hand-written fixture agrees with the parser about and git does not.
 */
const z = (...records: string[]) => `${records.join("\0")}\0`;

const STATUS = z(
  "# branch.oid 4ad7eb7a9bc39139313d6f66baab31ca703fb99c",
  "# branch.head main",
  "2 R. N... 100644 100644 100644 4286f428 4286f428 R100 new-path.ts",
  "old/path.ts",
  "1 MM N... 100644 100644 100644 e563bc26 4c6f843b src/both.ts",
  "1 D. N... 100644 000000 000000 286c5f57 00000000 src/deleted.ts",
  "1 M. N... 100644 100644 100644 de980441 d68dd403 src/staged.ts",
  "1 .M N... 100644 100644 100644 b77b4eb1 b77b4eb1 src/unstaged.ts",
  "? untracked.txt",
);

const UNSTAGED_NUMSTAT = z("1\t0\tsrc/both.ts", "1\t0\tsrc/unstaged.ts");
const STAGED_NUMSTAT = z(
  "0\t0\t",
  "old/path.ts",
  "new-path.ts",
  "1\t0\tsrc/both.ts",
  "0\t1\tsrc/deleted.ts",
  "1\t0\tsrc/staged.ts",
);

describe("parsePorcelainV2", () => {
  it("reads the branch header, and leaves ahead/behind at zero with no upstream", () => {
    const { branch } = parsePorcelainV2(STATUS);
    expect(branch).toEqual({
      name: "main",
      detached: false,
      head: "4ad7eb7a",
      upstream: null,
      ahead: 0,
      behind: 0,
    });
  });

  it("reads an upstream and its ahead/behind counts as magnitudes", () => {
    const { branch } = parsePorcelainV2(
      z("# branch.head feature", "# branch.upstream origin/feature", "# branch.ab +3 -2"),
    );
    expect(branch.upstream).toBe("origin/feature");
    expect(branch.ahead).toBe(3);
    // git prints `-2`; a panel showing "-2 behind" would be reading it twice.
    expect(branch.behind).toBe(2);
  });

  it("names a detached HEAD as detached rather than as a branch", () => {
    const { branch } = parsePorcelainV2(z("# branch.head (detached)"));
    expect(branch.detached).toBe(true);
    expect(branch.name).toBeNull();
  });

  it("puts a file that is staged and then modified again in both groups", () => {
    // `MM` is one git record and two rows, which is what git means and what an editor draws.
    const rows = parsePorcelainV2(STATUS).files.filter((f) => f.path === "src/both.ts");
    expect(rows.map((r) => r.group).sort()).toEqual(["changes", "staged"]);
  });

  it("reads a rename without inventing a file from its original path", () => {
    // The trap: with -z a `2` record spans two fields, so a parser that steps one record at a
    // time reads `old/path.ts` as the next file and reports a phantom entry.
    const { files } = parsePorcelainV2(STATUS);
    expect(files.some((f) => f.path === "old/path.ts")).toBe(false);
    const renamed = files.find((f) => f.path === "new-path.ts");
    expect(renamed).toMatchObject({
      group: "staged",
      kind: "renamed",
      letter: "R",
      originalPath: "old/path.ts",
    });
  });

  it("groups the rest the way the panel shows them", () => {
    const { files } = parsePorcelainV2(STATUS);
    const seen = files.map((f) => `${f.group}:${f.letter}:${f.path}`).sort();
    expect(seen).toEqual([
      "changes:M:src/both.ts",
      "changes:M:src/unstaged.ts",
      "staged:D:src/deleted.ts",
      "staged:M:src/both.ts",
      "staged:M:src/staged.ts",
      "staged:R:new-path.ts",
      "untracked:?:untracked.txt",
    ]);
  });

  it("skips ignored entries, which the panel does not show", () => {
    expect(parsePorcelainV2(z("! node_modules/x.js")).files).toHaveLength(0);
  });

  it("reports an unmerged file as one conflicted row", () => {
    const { files } = parsePorcelainV2(
      z("u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/conflict.ts"),
    );
    expect(files).toEqual([
      expect.objectContaining({ path: "src/conflict.ts", group: "merge", kind: "conflicted" }),
    ]);
  });

  it("keeps a path containing a space intact", () => {
    const { files } = parsePorcelainV2(
      z("1 .M N... 100644 100644 100644 aaaa bbbb src/two words.ts"),
    );
    expect(files[0]?.path).toBe("src/two words.ts");
  });
});

describe("parseNumstatZ", () => {
  it("keys a rename on the new path, consuming both of its trailing fields", () => {
    const stats = parseNumstatZ(STAGED_NUMSTAT);
    expect(stats.has("new-path.ts")).toBe(true);
    expect(stats.has("old/path.ts")).toBe(false);
    // And the records after the rename are still read.
    expect(stats.get("src/staged.ts")).toEqual({ added: 1, removed: 0 });
  });

  it("reports a binary file as null counts rather than as zero", () => {
    // Zero would read as "nothing changed"; null is "this is not a line count".
    expect(parseNumstatZ(z("-\t-\tassets/logo.png")).get("assets/logo.png")).toEqual({
      added: null,
      removed: null,
    });
  });
});

/** An Executor that answers the three git calls the status read makes, and records them. */
function fakeGit(
  answers: { status?: string; unstaged?: string; staged?: string } = {},
  calls: string[][] = [],
): Executor {
  return {
    async exec(cmd: string[], _opts: ExecOpts = {}): Promise<ExecResult> {
      calls.push(cmd);
      const stdout = cmd.includes("status")
        ? (answers.status ?? STATUS)
        : cmd.includes("--cached")
          ? (answers.staged ?? STAGED_NUMSTAT)
          : (answers.unstaged ?? UNSTAGED_NUMSTAT);
      return { stdout, stderr: "", exitCode: 0 };
    },
    spawn: () => {
      throw new Error("not used");
    },
    baseEnv: async () => ({}),
    fs: {} as Executor["fs"],
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

describe("readScmStatus", () => {
  it("attaches each group's own counts, so a staged and re-modified file reads twice", async () => {
    const status = await readScmStatus(fakeGit(), "/wt/task");
    const both = status.files.filter((f) => f.path === "src/both.ts");
    expect(both).toHaveLength(2);
    for (const row of both) expect(row.additions).toBe(1);
  });

  it("marks a binary file and leaves its counts unstated", async () => {
    const status = await readScmStatus(
      fakeGit({
        status: z("1 .M N... 100644 100644 100644 aaaa bbbb assets/logo.png"),
        unstaged: z("-\t-\tassets/logo.png"),
      }),
      "/wt/task",
    );
    expect(status.files[0]).toMatchObject({ binary: true, additions: null, deletions: null });
  });

  it("excludes the Repository's setup files from every call it makes (issue #52)", async () => {
    // A `.env` copied in for the agent is not part of what the agent proposed, and rendering it
    // would put a secret on screen (Principle IV).
    const calls: string[][] = [];
    await readScmStatus(fakeGit({}, calls), "/wt/task", [".env"]);
    expect(calls).toHaveLength(3);
    for (const cmd of calls) expect(cmd).toContain(":(exclude,glob).env");
  });

  it("says so when it cut the list short rather than truncating silently", async () => {
    const status = await readScmStatus(fakeGit(), "/wt/task", [], 2);
    expect(status.files).toHaveLength(2);
    expect(status.total).toBe(7);
    expect(status.truncated).toBe(true);
  });

  it("does not claim truncation when everything fits", async () => {
    const status = await readScmStatus(fakeGit(), "/wt/task");
    expect(status.truncated).toBe(false);
    expect(status.total).toBe(status.files.length);
  });

  it("fails loudly when git does, rather than reporting an empty worktree", async () => {
    const broken: Executor = {
      ...fakeGit(),
      exec: async () => ({ stdout: "", stderr: "not a git repository", exitCode: 128 }),
    };
    expect(readScmStatus(broken, "/wt/task")).rejects.toThrow("not a git repository");
  });
});
