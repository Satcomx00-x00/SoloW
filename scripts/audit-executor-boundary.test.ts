import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditBoundary, withoutComments } from "./audit-executor-boundary.js";

/**
 * This audit is a gate, so its tests are demonstrations: each one is a tree the audit is pointed
 * at, and the claim is what it says about that tree. Two of them are built from files taken
 * verbatim out of this repository, because the way the first version of the Docker rules failed
 * was not that it matched nothing — it was that it matched no argv *this* repository writes.
 *
 * These run because the root `test` script ends with `bun test scripts`. It did not always: the
 * script was `bun run --filter '*' test`, which enumerates the ten workspaces and never enters
 * `scripts/`, so `make test` and CI's unit-test step executed none of this file — the sole
 * evidence for a gate that had, at that point, silently stopped reporting a whole class of
 * violation. A test nothing runs is worse than no test, because it reads as coverage.
 */

const REPO = join(import.meta.dir, "..");
const roots: string[] = [];

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** A tree shaped enough like the repository for the audit to walk it. */
function treeWith(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "solow-r2-boundary-"));
  roots.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture", private: true }));
  mkdirSync(join(root, "apps"), { recursive: true });
  mkdirSync(join(root, "packages"), { recursive: true });
  for (const [rel, source] of Object.entries(files)) {
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, source);
  }
  return root;
}

function repoFile(rel: string): string {
  return readFileSync(join(REPO, rel), "utf8");
}

describe("docker rules match the argv this repository actually writes", () => {
  // Deliberately the live files rather than a paraphrase of them: the rules exist to catch the
  // argv *this tree* composes, and a paraphrase is exactly how the first version passed while
  // matching neither. If one of these ever stops being a violation when moved, the file changed
  // its idiom and the rules have to follow it — that failure is the gate working.
  const preflight = repoFile("apps/orchestrator/src/executor/preflight.ts");
  const reap = repoFile("apps/orchestrator/src/executor/reap.ts");

  test("preflight.ts moved out of the executor module is a violation", () => {
    // `const bin = opts.dockerBin ?? "docker"` — the whole of preflight's Docker call, since its
    // argv is `[bin, ...args]` and nothing textual can tell that from any other argv.
    const moved = auditBoundary(treeWith({ "apps/orchestrator/src/preflight.ts": preflight }));
    expect(moved.join("\n")).toContain("apps/orchestrator/src/preflight.ts");
  });

  test("reap.ts moved out of the executor module is a violation", () => {
    // `host.exec([env.SOLOW_DOCKER_BIN, "ps", …])`, plus the `label=solow.` filters underneath.
    const moved = auditBoundary(treeWith({ "apps/orchestrator/src/reap.ts": reap }));
    expect(moved.join("\n")).toContain("apps/orchestrator/src/reap.ts");
  });

  test("both are silent where they actually live — the module is allowed to own Docker", () => {
    const inPlace = auditBoundary(
      treeWith({
        "apps/orchestrator/src/executor/preflight.ts": preflight,
        "apps/orchestrator/src/executor/reap.ts": reap,
      }),
    );
    expect(inPlace).toEqual([]);
  });

  test("copying the configured binary into a local does not hide the call", () => {
    // `[bin, ...args]` is invisible to a textual gate, so the read is what has to be caught:
    // `opts.dockerBin` with no `?? "docker"` under it is still this deployment's docker binary.
    const violations = auditBoundary(
      treeWith({
        "apps/orchestrator/src/probe.ts": [
          "const bin = opts.dockerBin;",
          "const out = await host.exec([bin, ...args]);",
          "",
        ].join("\n"),
      }),
    );
    expect(violations.join("\n")).toContain("docker binary read");
  });

  test("a container search by solow label is a violation however the argv was built", () => {
    // The second net under the argv rules: `[bin, "ps", …]` names no binary a pattern can see,
    // but a caller still has to name the labels `docker.ts` stamps to find a container to act on.
    const violations = auditBoundary(
      treeWith({
        "apps/orchestrator/src/sweeper.ts":
          'const listed = await host.exec([bin, "ps", "-a", "--filter", "label=solow.managed=true"]);\n',
      }),
    );
    expect(violations.join("\n")).toContain("Docker container label");
  });

  test('the literal ["docker", "run", …] argv is a violation', () => {
    const violations = auditBoundary(
      treeWith({
        "apps/orchestrator/src/runner.ts": 'await host.exec(["docker", "run", "--rm", image]);\n',
      }),
    );
    expect(violations.join("\n")).toContain("docker CLI argv");
  });
});

describe("the rules do not cry wolf", () => {
  test('["docker", "local"] is a list of ExecutorKinds, not a call', () => {
    // task-run.test.ts:1440 asserts exactly this array, and executor-profiles-section.tsx's
    // RUNNABLE_KINDS is one reorder away from writing it in production code.
    const violations = auditBoundary(
      treeWith({
        "apps/web/src/kinds.ts": [
          'const RUNNABLE_KINDS: readonly ExecutorKind[] = ["docker", "local"];',
          'const ALL_KINDS = ["docker", "local", "ssh", "cloud"] as const;',
          "",
        ].join("\n"),
      }),
    );
    expect(violations).toEqual([]);
  });

  test("declaring SOLOW_DOCKER_BIN is not calling Docker", () => {
    // env.ts names the binary for the executor module to use. It is outside that module, and it
    // has to stay green, or the rule below it is one someone deletes.
    const violations = auditBoundary(
      treeWith({
        "apps/orchestrator/src/env.ts": [
          "const schema = z.object({",
          '  SOLOW_DOCKER_BIN: z.string().min(1).default("docker"),',
          "});",
          "",
        ].join("\n"),
      }),
    );
    expect(violations).toEqual([]);
  });

  test("a comment quoting a docker command line is not a violation", () => {
    const violations = auditBoundary(
      treeWith({
        "apps/web/src/notes.ts": [
          "/**",
          " * The container is created with `docker run --rm --cpus 0.5`, which is why the quota",
          ' * arrives as cpu.max "50000 100000". A `docker ps --filter label=solow.managed=true`',
          " * lists the ones we made.",
          " */",
          "export const NOTE = 1;",
          "",
        ].join("\n"),
      }),
    );
    expect(violations).toEqual([]);
  });
});

describe("withoutComments is string-aware", () => {
  // The regression this replaced: `"+refs/heads/*:refs/heads/*"` in manager.ts opened a
  // pseudo-comment that ran to the next real close-comment token, blanking about thirty lines of
  // live `ensureTaskClone` code. A `Bun.spawn` among them was reported by the audit before that
  // change and not after it.
  const REFSPEC = '  const args = ["fetch", upstream, "+refs/heads/*:refs/heads/*"];';

  test("a git refspec does not open a comment", () => {
    const source = [REFSPEC, '  Bun.spawn(["docker", "ps"]);', "  /* a real comment */", ""].join(
      "\n",
    );
    const code = withoutComments(source);
    expect(code).toContain("+refs/heads/*:refs/heads/*");
    expect(code).toContain("Bun.spawn(");
    expect(code).not.toContain("a real comment");
  });

  test("the real manager.ts still reports a Bun.spawn planted after its refspec", () => {
    const manager = repoFile("apps/orchestrator/src/worktree/manager.ts").split("\n");
    const at = manager.findIndex((line) => line.includes("+refs/heads/*:refs/heads/*"));
    expect(at).toBeGreaterThan(-1);
    manager.splice(at + 1, 0, '  Bun.spawn(["docker", "ps"]);');
    const violations = auditBoundary(
      treeWith({ "apps/orchestrator/src/worktree/manager.ts": manager.join("\n") }),
    );
    expect(violations.join("\n")).toContain("Bun.spawn");
  });

  test("the real manager.ts, unplanted, is clean", () => {
    const violations = auditBoundary(
      treeWith({
        "apps/orchestrator/src/worktree/manager.ts": repoFile(
          "apps/orchestrator/src/worktree/manager.ts",
        ),
      }),
    );
    expect(violations).toEqual([]);
  });

  test("comments are blanked in place, so line numbers and token boundaries survive", () => {
    const source = ["const a = 1; /* two", "three", "four */ const b = 2;", ""].join("\n");
    const code = withoutComments(source);
    expect(code.split("\n").length).toBe(source.split("\n").length);
    expect(code).toContain("const a = 1; ");
    expect(code).toContain(" const b = 2;");
    expect(code).not.toContain("three");
  });

  test("a // inside a string or a template literal is text, not a comment", () => {
    // Split so this line is not itself a template placeholder in the eyes of the linter.
    const interpolated = `const t = \`a//b $${"{x}"} c\`;`;
    const code = withoutComments(
      ['const url = "https://example.com/x"; // trailing', interpolated, ""].join("\n"),
    );
    expect(code).toContain("https://example.com/x");
    expect(code).toContain("a//b");
    expect(code).not.toContain("trailing");
  });

  test("an apostrophe in JSX prose does not swallow the comments after it", () => {
    // Three .tsx files in apps/web depend on this: `permission-card.tsx` writes "deployment's"
    // as JSX text, and a `'` that ran past the end of its line took every later comment in the
    // file out of the haystack with it.
    const code = withoutComments(
      [
        "      <p>this deployment's unattended permission policy settles it</p>",
        "      // gone",
        'const kept = "after";',
        "",
      ].join("\n"),
    );
    expect(code).toContain("deployment's");
    expect(code).not.toContain("gone");
    expect(code).toContain('const kept = "after";');
  });

  test("a regex literal holding quotes does not open a string", () => {
    const code = withoutComments(
      ["const q = /[\"'`]/.test(s); // gone", 'const kept = "after";', ""].join("\n"),
    );
    expect(code).not.toContain("gone");
    expect(code).toContain('const kept = "after";');
  });
});

test("the repository itself passes", () => {
  expect(auditBoundary(REPO)).toEqual([]);
});

test("blanking comments never loses a line of any file in the repository", () => {
  // The failure mode a scanner has that a pair of regexes does not: an unterminated literal, and
  // it consumes to the end of the file in silence. Line count is the cheap tell for that.
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (full.endsWith(".ts") || full.endsWith(".tsx")) files.push(full);
    }
  };
  walk(join(REPO, "apps"));
  walk(join(REPO, "packages"));
  expect(files.length).toBeGreaterThan(100);
  const drifted = files.filter((file) => {
    const source = readFileSync(file, "utf8");
    return withoutComments(source).split("\n").length !== source.split("\n").length;
  });
  expect(drifted).toEqual([]);
});
